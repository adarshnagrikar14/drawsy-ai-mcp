import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  AgentMetadata,
  BridgeEvent,
  JsonObject,
} from "./protocol.js";
import { isRecord } from "./protocol.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

const DEVELOPER_INSTRUCTIONS = `You are the local Codex agent inside Drawsy AI.
- You may use normal local coding tools only inside the selected folder.
- Internet, browser/computer control, apps, connectors, and every non-Drawsy MCP are unavailable.
- The Drawsy MCP is permanently attached and scoped to the single current canvas.
- Read the canvas before changing it. Use apply_canvas_changes for targeted upserts/deletions.
- Never attempt to discover or access another canvas.
- Work autonomously within these boundaries; do not request permission escalation.`;

export class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activeTools = new Map<string, string>();
  private nextId = 1;
  private threadId: string | null = null;
  private turnActive = false;
  private agentMetadata: AgentMetadata | null = null;
  private resolveDrawsyMcp!: () => void;
  private rejectDrawsyMcp!: (error: Error) => void;
  private readonly drawsyMcpReady = new Promise<void>((resolve, reject) => {
    this.resolveDrawsyMcp = resolve;
    this.rejectDrawsyMcp = reject;
  });

  private constructor(
    private readonly folderPath: string,
    private readonly session: { id: string; secret: string; bridgeUrl: string },
    private readonly emit: (event: BridgeEvent) => void
  ) {
    this.process = spawn(
      process.env.DRAWSY_CODEX_BIN || "codex",
      [
        "app-server",
        "--stdio",
        "--strict-config",
        "--disable",
        "plugins",
        "--disable",
        "apps",
        "--disable",
        "browser_use",
        "--disable",
        "computer_use",
        "--disable",
        "remote_plugin",
        "--disable",
        "multi_agent",
        "--disable",
        "image_generation",
        "--disable",
        "in_app_browser",
        "--disable",
        "browser_use_external",
        "--disable",
        "browser_use_full_cdp_access",
        "--disable",
        "goals",
        "--disable",
        "memories",
        "--disable",
        "tool_suggest",
        "--disable",
        "skill_mcp_dependency_install",
        "--disable",
        "auth_elicitation",
        "--disable",
        "network_proxy",
        "-c",
        'web_search="disabled"',
      ],
      { stdio: ["pipe", "pipe", "pipe"] }
    );
    readline
      .createInterface({ input: this.process.stdout })
      .on("line", (line) => this.handleLine(line));
    this.process.stderr.on("data", (chunk) => {
      const text = chunk.toString().trim();
      if (text && !text.includes("state db discrepancy")) {
        console.error(`[codex:${this.session.id}] ${text}`);
      }
    });
    this.process.on("exit", (code) => {
      const exitError = new Error(
        `Codex app-server exited (${code ?? "signal"}).`
      );
      this.rejectDrawsyMcp(exitError);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(exitError);
      }
      this.pending.clear();
    });
  }

  static async start(
    folderPath: string,
    session: { id: string; secret: string; bridgeUrl: string },
    emit: (event: BridgeEvent) => void
  ) {
    const server = new CodexAppServer(folderPath, session, emit);
    try {
      await server.initialize();
      return server;
    } catch (error) {
      server.close();
      throw error;
    }
  }

  get metadata() {
    if (!this.agentMetadata) {
      throw new Error("Codex metadata is not ready.");
    }
    return this.agentMetadata;
  }

  private async initialize() {
    await this.request("initialize", {
      clientInfo: { name: "drawsy-ai", title: "Drawsy AI", version: "0.1.0" },
      capabilities: { experimentalApi: true },
    });
    this.notify("initialized");

    const config = (await this.request("config/read", {})) as JsonObject;
    const currentConfig = isRecord(config.config) ? config.config : {};
    const currentMcpServers = isRecord(currentConfig.mcp_servers)
      ? currentConfig.mcp_servers
      : {};
    const disabledMcpServers = Object.fromEntries(
      Object.keys(currentMcpServers).map((name) => [name, { enabled: false }])
    );
    const mcpEntry = path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      "mcp.js"
    );
    const thread = (await this.request("thread/start", {
      cwd: this.folderPath,
      permissions: ":workspace",
      runtimeWorkspaceRoots: [this.folderPath],
      approvalPolicy: "never",
      ephemeral: true,
      environments: [],
      developerInstructions: DEVELOPER_INSTRUCTIONS,
      personality: "pragmatic",
      config: {
        mcp_servers: {
          ...disabledMcpServers,
          drawsy: {
            command: process.execPath,
            args: [mcpEntry],
            env: {
              DRAWSY_BRIDGE_URL: this.session.bridgeUrl,
              DRAWSY_SESSION_ID: this.session.id,
              DRAWSY_SESSION_SECRET: this.session.secret,
            },
            enabled: true,
            startup_timeout_sec: 15,
            tool_timeout_sec: 45,
            default_tools_approval_mode: "auto",
            tools: {
              apply_canvas_changes: { approval_mode: "approve" },
            },
          },
        },
      },
    })) as JsonObject;
    const threadData = isRecord(thread.thread) ? thread.thread : {};
    if (typeof threadData.id !== "string") {
      throw new Error("Codex did not return a thread id.");
    }
    if (
      typeof thread.model !== "string" ||
      typeof thread.modelProvider !== "string"
    ) {
      throw new Error("Codex did not return model metadata.");
    }
    this.agentMetadata = {
      model: thread.model,
      modelProvider: thread.modelProvider,
      reasoningEffort:
        typeof thread.reasoningEffort === "string"
          ? thread.reasoningEffort
          : null,
      serviceTier:
        typeof thread.serviceTier === "string" ? thread.serviceTier : null,
    };
    const activeProfile = isRecord(thread.activePermissionProfile)
      ? thread.activePermissionProfile.id
      : null;
    if (activeProfile !== ":workspace") {
      throw new Error(
        "Codex did not activate the selected-folder permission profile."
      );
    }
    const runtimeRoots = Array.isArray(thread.runtimeWorkspaceRoots)
      ? thread.runtimeWorkspaceRoots
      : [];
    const sandbox = isRecord(thread.sandbox) ? thread.sandbox : {};
    if (
      runtimeRoots.length !== 1 ||
      runtimeRoots[0] !== this.folderPath ||
      thread.approvalPolicy !== "never" ||
      sandbox.networkAccess !== false
    ) {
      throw new Error(
        "Codex did not preserve Drawsy's folder/network boundary."
      );
    }
    this.threadId = threadData.id;
    let mcpTimer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        this.drawsyMcpReady,
        new Promise<never>((_, reject) => {
          mcpTimer = setTimeout(
            () => reject(new Error("Drawsy MCP did not become ready.")),
            20_000
          );
        }),
      ]);
    } finally {
      if (mcpTimer) clearTimeout(mcpTimer);
    }
  }

  async startTurn(message: string) {
    if (!this.threadId || this.turnActive) {
      throw new Error(
        this.turnActive
          ? "A Codex turn is already running."
          : "Codex is not ready."
      );
    }
    this.turnActive = true;
    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        cwd: this.folderPath,
        permissions: ":workspace",
        runtimeWorkspaceRoots: [this.folderPath],
        approvalPolicy: "never",
        environments: [],
        input: [{ type: "text", text: message }],
        personality: "pragmatic",
        summary: "concise",
      });
    } catch (error) {
      this.turnActive = false;
      throw error;
    }
  }

  close() {
    this.process.kill("SIGTERM");
  }

  private handleLine(line: string) {
    let message: JsonObject;
    try {
      message = JSON.parse(line) as JsonObject;
    } catch {
      return;
    }
    if (
      typeof message.method === "string" &&
      (typeof message.id === "number" || typeof message.id === "string")
    ) {
      this.handleServerRequest(message.id, message.method);
      return;
    }
    if (typeof message.id === "number") {
      const pending = this.pending.get(message.id);
      if (pending) {
        this.pending.delete(message.id);
        clearTimeout(pending.timer);
        if (message.error) {
          pending.reject(new Error(JSON.stringify(message.error)));
        } else {
          pending.resolve(message.result);
        }
      }
    }
    if (typeof message.method !== "string" || !isRecord(message.params)) {
      return;
    }
    const params = message.params;
    if (message.method === "mcpServer/startupStatus/updated") {
      const name = typeof params.name === "string" ? params.name : "";
      const status = typeof params.status === "string" ? params.status : "";
      if (name === "drawsy" && status === "ready") {
        this.resolveDrawsyMcp();
      } else if (
        name === "drawsy" &&
        (status === "failed" || status === "error")
      ) {
        this.rejectDrawsyMcp(new Error("Drawsy MCP failed to start."));
      } else if (
        name &&
        name !== "drawsy" &&
        (status === "starting" || status === "ready")
      ) {
        this.rejectDrawsyMcp(
          new Error(`Unexpected MCP server was enabled: ${name}.`)
        );
      }
    } else if (message.method === "turn/started") {
      this.emit({ type: "turn.status", data: { status: "inProgress" } });
    } else if (message.method === "item/started" && isRecord(params.item)) {
      const item = params.item;
      if (
        item.type === "mcpToolCall" &&
        item.server === "drawsy" &&
        typeof item.id === "string" &&
        typeof item.tool === "string"
      ) {
        this.activeTools.set(item.id, item.tool);
        this.emit({
          type: "tool.status",
          data: {
            itemId: item.id,
            tool: item.tool,
            status: "inProgress",
          },
        });
      }
    } else if (message.method === "item/mcpToolCall/progress") {
      if (
        typeof params.itemId === "string" &&
        typeof params.message === "string"
      ) {
        this.emit({
          type: "tool.status",
          data: {
            itemId: params.itemId,
            tool: this.activeTools.get(params.itemId) || "drawsy",
            status: "inProgress",
            message: params.message,
          },
        });
      }
    } else if (message.method === "item/agentMessage/delta") {
      this.emit({
        type: "assistant.delta",
        data: {
          delta: typeof params.delta === "string" ? params.delta : "",
          itemId:
            typeof params.itemId === "string" ? params.itemId : randomUUID(),
        },
      });
    } else if (message.method === "item/completed" && isRecord(params.item)) {
      const item = params.item;
      if (item.type === "agentMessage" && typeof item.text === "string") {
        this.emit({
          type: "assistant.final",
          data: {
            text: item.text,
            itemId:
              typeof item.id === "string" ? item.id : randomUUID(),
          },
        });
      } else if (
        item.type === "mcpToolCall" &&
        item.server === "drawsy" &&
        typeof item.id === "string" &&
        typeof item.tool === "string"
      ) {
        this.activeTools.delete(item.id);
        const status =
          item.status === "completed" || item.status === "failed"
            ? item.status
            : "failed";
        const error =
          isRecord(item.error) && typeof item.error.message === "string"
            ? item.error.message
            : undefined;
        this.emit({
          type: "tool.status",
          data: {
            itemId: item.id,
            tool: item.tool,
            status,
            ...(error ? { error } : {}),
          },
        });
      }
    } else if (message.method === "turn/completed" && isRecord(params.turn)) {
      this.turnActive = false;
      const error =
        isRecord(params.turn.error) &&
        typeof params.turn.error.message === "string"
          ? params.turn.error.message
          : undefined;
      this.emit({
        type: "turn.status",
        data: {
          status:
            typeof params.turn.status === "string"
              ? params.turn.status
              : "completed",
          ...(error ? { error } : {}),
        },
      });
    } else if (message.method === "error") {
      const error =
        isRecord(params.error) && typeof params.error.message === "string"
          ? params.error.message
          : "Codex encountered an error.";
      this.emit({
        type: "error",
        data: { code: "codex_error", message: error },
      });
    }
  }

  private handleServerRequest(id: string | number, method: string) {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.respond(id, { decision: "decline" });
      return;
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      this.respond(id, { decision: "denied" });
      return;
    }
    if (method === "item/permissions/requestApproval") {
      this.respond(id, {
        permissions: {},
        scope: "turn",
        strictAutoReview: true,
      });
      return;
    }
    if (method === "item/tool/requestUserInput") {
      this.respond(id, { answers: {} });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.respond(id, { action: "decline", content: null, _meta: null });
      return;
    }
    if (method === "item/tool/call") {
      this.respond(id, { contentItems: [], success: false });
      return;
    }
    if (method === "currentTime/read") {
      this.respond(id, { currentTimeAt: Math.floor(Date.now() / 1000) });
      return;
    }
    this.respondError(id, -32601, `Unsupported server request: ${method}`);
  }

  private request(method: string, params: JsonObject) {
    const id = this.nextId++;
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`
    );
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex request timed out: ${method}`));
      }, 300_000);
      this.pending.set(id, { resolve, reject, timer });
    });
  }

  private notify(method: string, params: JsonObject = {}) {
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`
    );
  }

  private respond(id: string | number, result: JsonObject) {
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`
    );
  }

  private respondError(id: string | number, code: number, message: string) {
    this.process.stdin.write(
      `${JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } })}\n`
    );
  }
}
