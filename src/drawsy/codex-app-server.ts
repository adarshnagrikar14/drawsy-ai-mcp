import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import type {
  AgentAccessMode,
  AgentContextCapture,
  AgentControls,
  AgentMetadata,
  AgentModelOption,
  AgentPromptTag,
  AgentSettingsPatch,
  BridgeEvent,
  JsonObject,
} from "./protocol.js";
import { isRecord } from "./protocol.js";

type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type ActiveTool = {
  tool: string;
  startedMessage: string;
  completedMessage: string;
};

const describeToolItem = (item: JsonObject): ActiveTool | null => {
  if (item.type === "mcpToolCall" && typeof item.tool === "string") {
    const server = typeof item.server === "string" ? item.server : "MCP";
    const drawsyMessages =
      item.tool === "read_current_canvas"
        ? { started: "Reading current canvas", completed: "Canvas read" }
        : item.tool === "apply_canvas_changes"
        ? { started: "Updating canvas", completed: "Canvas updated" }
        : item.tool === "add_image_from_file"
        ? { started: "Adding image to canvas", completed: "Image added" }
        : item.tool === "capture_canvas_context"
        ? { started: "Capturing canvas context", completed: "Context captured" }
        : item.tool === "replace_canvas_image_from_file"
        ? { started: "Replacing canvas image", completed: "Image replaced" }
        : {
            started: "Working on the canvas",
            completed: "Canvas tool finished",
          };
    return {
      tool: server === "drawsy" ? item.tool : `${server}/${item.tool}`,
      startedMessage:
        server === "drawsy" ? drawsyMessages.started : `Using ${item.tool}`,
      completedMessage:
        server === "drawsy"
          ? drawsyMessages.completed
          : `${item.tool} finished`,
    };
  }
  if (item.type === "commandExecution") {
    const command =
      typeof item.command === "string"
        ? item.command.replace(/\s+/g, " ").trim().slice(0, 96)
        : "command";
    return {
      tool: "commandExecution",
      startedMessage: `Running ${command}`,
      completedMessage: "Command finished",
    };
  }
  if (item.type === "fileChange") {
    const count = Array.isArray(item.changes) ? item.changes.length : 0;
    return {
      tool: "fileChange",
      startedMessage: count
        ? `Editing ${count} file${count === 1 ? "" : "s"}`
        : "Editing files",
      completedMessage: "File changes finished",
    };
  }
  if (item.type === "dynamicToolCall" && typeof item.tool === "string") {
    return {
      tool: item.tool,
      startedMessage: `Using ${item.tool}`,
      completedMessage: `${item.tool} finished`,
    };
  }
  if (item.type === "plan") {
    return {
      tool: "plan",
      startedMessage: "Building a plan",
      completedMessage: "Plan ready",
    };
  }
  if (item.type === "reasoning") {
    return {
      tool: "reasoning",
      startedMessage: "Reasoning through the request",
      completedMessage: "Reasoning complete",
    };
  }
  if (item.type === "collabAgentToolCall") {
    const tool = typeof item.tool === "string" ? item.tool : "agent task";
    return {
      tool: "collaboration",
      startedMessage: `Coordinating ${tool}`,
      completedMessage: `${tool} finished`,
    };
  }
  if (item.type === "subAgentActivity") {
    return {
      tool: "subAgent",
      startedMessage: "Agent activity started",
      completedMessage: "Agent activity finished",
    };
  }
  if (item.type === "webSearch") {
    const query =
      typeof item.query === "string" ? item.query.trim().slice(0, 72) : "";
    return {
      tool: "webSearch",
      startedMessage: query ? `Searching for “${query}”` : "Searching the web",
      completedMessage: "Web search finished",
    };
  }
  if (item.type === "imageView") {
    const fileName =
      typeof item.path === "string" ? path.basename(item.path) : "image";
    return {
      tool: "imageView",
      startedMessage: `Inspecting ${fileName}`,
      completedMessage: "Image inspected",
    };
  }
  if (item.type === "imageGeneration") {
    return {
      tool: "imageGeneration",
      startedMessage: "Generating an image",
      completedMessage: "Image generated",
    };
  }
  if (item.type === "sleep") {
    return {
      tool: "wait",
      startedMessage: "Waiting",
      completedMessage: "Wait finished",
    };
  }
  if (item.type === "enteredReviewMode") {
    return {
      tool: "review",
      startedMessage: "Starting review",
      completedMessage: "Review started",
    };
  }
  if (item.type === "exitedReviewMode") {
    return {
      tool: "review",
      startedMessage: "Finishing review",
      completedMessage: "Review finished",
    };
  }
  if (item.type === "contextCompaction") {
    return {
      tool: "context",
      startedMessage: "Organizing conversation context",
      completedMessage: "Conversation context organized",
    };
  }
  return null;
};

const toolFailure = (item: JsonObject) => {
  if (typeof item.error === "string" && item.error.trim()) {
    return item.error.trim().slice(0, 500);
  }
  if (isRecord(item.error) && typeof item.error.message === "string") {
    return item.error.message.trim().slice(0, 500);
  }
  if (!isRecord(item.result) || item.result.isError !== true) return undefined;
  const content = Array.isArray(item.result.content)
    ? item.result.content
        .filter(isRecord)
        .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
        .filter(Boolean)
        .join(" ")
    : "";
  return content ? content.slice(0, 500) : "Canvas tool failed.";
};

const DEVELOPER_INSTRUCTIONS = `You are the local Codex agent inside Drawsy AI.
- You may use normal local coding tools only inside the selected folder.
- Installed skills and plugins are available, except Browser Use, Chrome control, and Computer Use.
- Apps and connectors are unavailable. Network access is controlled by the current Drawsy session setting.
- The Drawsy MCP is permanently attached and scoped to the single current canvas.
- Read the canvas before changing it. Use apply_canvas_changes for targeted upserts/deletions.
- When visual scale, layout, annotations, or an editable source matters, use capture_canvas_context. Its preview is the rendered canvas region; its source-image paths are pristine originals.
- For generated images, pass the generator's exact saved path directly to add_image_from_file; do not copy it. If no saved path is returned, use imagegen://latest. Never create a bare image placeholder.
- For an edit of an existing canvas image, use replace_canvas_image_from_file so its geometry and identity are preserved.
- Never attempt to discover or access another canvas.
- Work autonomously within these boundaries; do not request permission escalation.`;

const BLOCKED_PLUGIN_IDS = new Set([
  "browser@openai-bundled",
  "chrome@openai-bundled",
  "computer-use@openai-bundled",
]);

const blockedCapability = (value: string) =>
  /(^|[-_\s])(browser|chrome|computer)([-_\s]|$)/i.test(value);

export class CodexAppServer {
  private readonly process: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly activeTools = new Map<string, ActiveTool>();
  private nextId = 1;
  private threadId: string | null = null;
  private turnActive = false;
  private agentMetadata: AgentMetadata | null = null;
  private accessMode: AgentAccessMode = "workspace";
  private internetEnabled = false;
  private lastControls: AgentControls | null = null;
  private resolveDrawsyMcp!: () => void;
  private rejectDrawsyMcp!: (error: Error) => void;
  private readonly drawsyMcpReady = new Promise<void>((resolve, reject) => {
    this.resolveDrawsyMcp = resolve;
    this.rejectDrawsyMcp = reject;
  });

  private constructor(
    private readonly folderPath: string,
    private readonly session: { id: string; secret: string; bridgeUrl: string },
    private readonly emit: (event: BridgeEvent) => void,
    private readonly registerGeneratedImage: (image: {
      id: string;
      savedPath?: string;
      result?: string;
    }) => void
  ) {
    this.process = spawn(
      process.env.DRAWSY_CODEX_BIN || "codex",
      [
        "app-server",
        "--stdio",
        "--strict-config",
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
    emit: (event: BridgeEvent) => void,
    registerGeneratedImage: (image: {
      id: string;
      savedPath?: string;
      result?: string;
    }) => void = () => undefined
  ) {
    const server = new CodexAppServer(
      folderPath,
      session,
      emit,
      registerGeneratedImage
    );
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
        plugins: {
          "browser@openai-bundled": { enabled: false },
          "chrome@openai-bundled": { enabled: false },
          "computer-use@openai-bundled": { enabled: false },
        },
        mcp_servers: {
          ...disabledMcpServers,
          drawsy: {
            command: process.execPath,
            args: [mcpEntry],
            env: {
              DRAWSY_BRIDGE_URL: this.session.bridgeUrl,
              DRAWSY_SESSION_ID: this.session.id,
              DRAWSY_SESSION_SECRET: this.session.secret,
              DRAWSY_WORKSPACE_ROOT: this.folderPath,
            },
            enabled: true,
            startup_timeout_sec: 15,
            tool_timeout_sec: 45,
            default_tools_approval_mode: "auto",
            tools: {
              apply_canvas_changes: { approval_mode: "approve" },
              add_image_from_file: { approval_mode: "approve" },
              replace_canvas_image_from_file: { approval_mode: "approve" },
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

  async startTurn(
    message: string,
    tags: { skills: AgentPromptTag[]; plugins: AgentPromptTag[] } = {
      skills: [],
      plugins: [],
    },
    contexts: AgentContextCapture[] = []
  ) {
    if (!this.threadId || this.turnActive) {
      throw new Error(
        this.turnActive
          ? "A Codex turn is already running."
          : "Codex is not ready."
      );
    }
    const controls = this.lastControls || (await this.getControls());
    for (const skill of tags.skills) {
      if (
        !controls.skills.some(
          (option) => option.name === skill.name && option.path === skill.path
        )
      ) {
        throw new Error(`Skill is not available: ${skill.name}`);
      }
    }
    for (const plugin of tags.plugins) {
      if (
        !controls.plugins.some(
          (option) => option.name === plugin.name && option.path === plugin.path
        )
      ) {
        throw new Error(`Plugin is not available: ${plugin.name}`);
      }
    }
    this.turnActive = true;
    try {
      await this.request("turn/start", {
        threadId: this.threadId,
        cwd: this.folderPath,
        sandboxPolicy: this.sandboxPolicy(),
        runtimeWorkspaceRoots: [this.folderPath],
        approvalPolicy: "never",
        environments: [],
        input: [
          ...tags.skills.map((skill) => ({ type: "skill", ...skill })),
          ...tags.plugins.map((plugin) => ({ type: "mention", ...plugin })),
          ...contexts.flatMap((context, index) => [
            {
              type: "text",
              text: `Canvas context ${index + 1} (${context.id}) contains ${
                context.elementIds.length
              } selected elements in bounds ${JSON.stringify(
                context.bounds
              )}. The next local image is the rendered selection including visible annotations. Pristine source-image paths: ${
                context.sourceImages.length
                  ? context.sourceImages
                      .map((source) => `${source.id}=${source.path}`)
                      .join(", ")
                  : "none"
              }.`,
              text_elements: [],
            },
            {
              type: "localImage",
              path: context.previewPath,
              detail: "original",
            },
            ...context.sourceImages.map((source) => ({
              type: "localImage",
              path: source.path,
              detail: "original",
            })),
          ]),
          { type: "text", text: message, text_elements: [] },
        ],
        personality: "pragmatic",
        summary: "concise",
      });
    } catch (error) {
      this.turnActive = false;
      throw error;
    }
  }

  async getControls(): Promise<AgentControls> {
    if (!this.threadId) {
      throw new Error("Codex is not ready.");
    }
    const [modelsResult, skillsResult, pluginsResult, mcpResult] =
      (await Promise.all([
        this.request("model/list", { limit: 100, includeHidden: false }),
        this.request("skills/list", { cwds: [this.folderPath] }),
        this.request("plugin/list", {
          cwds: [this.folderPath],
          marketplaceKinds: ["local"],
        }),
        this.request("mcpServerStatus/list", {
          limit: 100,
          detail: "toolsAndAuthOnly",
          threadId: this.threadId,
        }),
      ])) as [JsonObject, JsonObject, JsonObject, JsonObject];

    const models = Array.isArray(modelsResult.data)
      ? modelsResult.data.flatMap((value): AgentModelOption[] => {
          if (
            !isRecord(value) ||
            value.hidden === true ||
            typeof value.model !== "string"
          ) {
            return [];
          }
          const efforts = Array.isArray(value.supportedReasoningEfforts)
            ? value.supportedReasoningEfforts.flatMap((effort) =>
                isRecord(effort) &&
                typeof effort.reasoningEffort === "string" &&
                typeof effort.description === "string"
                  ? [
                      {
                        id: effort.reasoningEffort,
                        description: effort.description,
                      },
                    ]
                  : []
              )
            : [];
          return [
            {
              id: typeof value.id === "string" ? value.id : value.model,
              model: value.model,
              displayName:
                typeof value.displayName === "string"
                  ? value.displayName
                  : value.model,
              description:
                typeof value.description === "string" ? value.description : "",
              efforts,
              defaultEffort:
                typeof value.defaultReasoningEffort === "string"
                  ? value.defaultReasoningEffort
                  : efforts[0]?.id || "medium",
              isDefault: value.isDefault === true,
            },
          ];
        })
      : [];
    if (
      this.agentMetadata &&
      !models.some((model) => model.model === this.agentMetadata?.model)
    ) {
      const currentEffort = this.agentMetadata.reasoningEffort;
      models.unshift({
        id: this.agentMetadata.model,
        model: this.agentMetadata.model,
        displayName: this.agentMetadata.model,
        description: "Current Codex configuration",
        efforts: currentEffort
          ? [{ id: currentEffort, description: "Current reasoning level" }]
          : [],
        defaultEffort: currentEffort || "medium",
        isDefault: false,
      });
    }

    const skills = Array.isArray(skillsResult.data)
      ? skillsResult.data.flatMap((entry) => {
          if (!isRecord(entry) || !Array.isArray(entry.skills)) return [];
          return entry.skills.flatMap((skill) => {
            if (
              !isRecord(skill) ||
              skill.enabled !== true ||
              typeof skill.name !== "string" ||
              typeof skill.description !== "string"
            ) {
              return [];
            }
            const pathValue = typeof skill.path === "string" ? skill.path : "";
            if (
              !pathValue ||
              blockedCapability(skill.name) ||
              /\/(browser|chrome|computer-use)\//i.test(pathValue)
            ) {
              return [];
            }
            const skillInterface = isRecord(skill.interface)
              ? skill.interface
              : {};
            return [
              {
                name: skill.name,
                displayName:
                  typeof skillInterface.displayName === "string"
                    ? skillInterface.displayName
                    : skill.name,
                description: skill.description,
                path: pathValue,
              },
            ];
          });
        })
      : [];

    const plugins = Array.isArray(pluginsResult.marketplaces)
      ? pluginsResult.marketplaces.flatMap((marketplace) => {
          if (!isRecord(marketplace) || !Array.isArray(marketplace.plugins)) {
            return [];
          }
          return marketplace.plugins.flatMap((plugin) => {
            if (
              !isRecord(plugin) ||
              typeof plugin.id !== "string" ||
              typeof plugin.name !== "string" ||
              plugin.installed !== true ||
              plugin.enabled !== true ||
              plugin.availability !== "AVAILABLE" ||
              BLOCKED_PLUGIN_IDS.has(plugin.id)
            ) {
              return [];
            }
            const pluginInterface = isRecord(plugin.interface)
              ? plugin.interface
              : {};
            const pluginSource = isRecord(plugin.source) ? plugin.source : {};
            const pluginPath =
              pluginSource.type === "local" &&
              typeof pluginSource.path === "string"
                ? pluginSource.path
                : "";
            if (!pluginPath) return [];
            const capabilities = Array.isArray(pluginInterface.capabilities)
              ? pluginInterface.capabilities.filter(
                  (capability): capability is string =>
                    typeof capability === "string"
                )
              : [];
            if (capabilities.some(blockedCapability)) return [];
            return [
              {
                id: plugin.id,
                name:
                  typeof pluginInterface.displayName === "string"
                    ? pluginInterface.displayName
                    : plugin.name,
                description:
                  typeof pluginInterface.shortDescription === "string"
                    ? pluginInterface.shortDescription
                    : "Installed plugin",
                capabilities,
                path: pluginPath,
              },
            ];
          });
        })
      : [];

    const mcpServers = Array.isArray(mcpResult.data)
      ? mcpResult.data.flatMap((server) => {
          if (
            !isRecord(server) ||
            typeof server.name !== "string" ||
            blockedCapability(server.name)
          ) {
            return [];
          }
          const tools = isRecord(server.tools) ? Object.keys(server.tools) : [];
          return [
            {
              name: server.name,
              toolCount: tools.length,
              authStatus:
                typeof server.authStatus === "string"
                  ? server.authStatus
                  : "unsupported",
            },
          ];
        })
      : [];

    const controls = {
      accessMode: this.accessMode,
      internetEnabled: this.internetEnabled,
      models,
      skills,
      plugins,
      mcpServers,
    };
    this.lastControls = controls;
    return controls;
  }

  async updateSettings(settings: AgentSettingsPatch) {
    if (!this.threadId || !this.agentMetadata) {
      throw new Error("Codex is not ready.");
    }
    if (this.turnActive) {
      throw new Error("Wait for the current Codex turn to finish.");
    }
    const controls = await this.getControls();
    const nextAccessMode = settings.accessMode ?? this.accessMode;
    const nextInternet = settings.internetEnabled ?? this.internetEnabled;
    const selectedModel = settings.model
      ? controls.models.find((model) => model.model === settings.model)
      : undefined;
    if (settings.model && !selectedModel) {
      throw new Error("That model is not available in this Codex session.");
    }
    const modelForEffort =
      selectedModel ||
      controls.models.find(
        (model) => model.model === this.agentMetadata?.model
      );
    if (
      settings.effort &&
      (!modelForEffort ||
        !modelForEffort.efforts.some((effort) => effort.id === settings.effort))
    ) {
      throw new Error("That reasoning level is not available for this model.");
    }

    await this.request("thread/settings/update", {
      threadId: this.threadId,
      cwd: this.folderPath,
      approvalPolicy: "never",
      sandboxPolicy: this.sandboxPolicy(nextAccessMode, nextInternet),
      ...(selectedModel ? { model: selectedModel.model } : {}),
      ...(settings.effort ? { effort: settings.effort } : {}),
    });
    this.accessMode = nextAccessMode;
    this.internetEnabled = nextInternet;
    if (selectedModel) this.agentMetadata.model = selectedModel.model;
    if (settings.effort) this.agentMetadata.reasoningEffort = settings.effort;
    return { agent: this.metadata, controls: await this.getControls() };
  }

  private sandboxPolicy(
    accessMode = this.accessMode,
    internetEnabled = this.internetEnabled
  ): JsonObject {
    return accessMode === "readOnly"
      ? { type: "readOnly", networkAccess: internetEnabled }
      : {
          type: "workspaceWrite",
          writableRoots: [this.folderPath],
          networkAccess: internetEnabled,
          excludeTmpdirEnvVar: true,
          excludeSlashTmp: true,
        };
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
      }
    } else if (message.method === "turn/started") {
      this.emit({ type: "turn.status", data: { status: "inProgress" } });
    } else if (message.method === "item/started" && isRecord(params.item)) {
      const item = params.item;
      const activity = describeToolItem(item);
      if (activity && typeof item.id === "string") {
        this.activeTools.set(item.id, activity);
        this.emit({
          type: "tool.status",
          data: {
            itemId: item.id,
            tool: activity.tool,
            status: "inProgress",
            message: activity.startedMessage,
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
            tool: this.activeTools.get(params.itemId)?.tool || "drawsy",
            status: "inProgress",
            message: params.message,
          },
        });
      }
    } else if (
      message.method === "item/plan/delta" ||
      message.method === "item/reasoning/summaryTextDelta" ||
      message.method === "item/reasoning/summaryPartAdded" ||
      message.method === "item/reasoning/textDelta"
    ) {
      if (typeof params.itemId === "string") {
        const activity = this.activeTools.get(params.itemId);
        const reasoning = message.method.includes("reasoning");
        this.emit({
          type: "tool.status",
          data: {
            itemId: params.itemId,
            tool: activity?.tool || (reasoning ? "reasoning" : "plan"),
            status: "inProgress",
            message:
              activity?.startedMessage ||
              (reasoning ? "Reasoning through the request" : "Building a plan"),
          },
        });
      }
    } else if (message.method === "item/commandExecution/outputDelta") {
      if (typeof params.itemId === "string") {
        const activity = this.activeTools.get(params.itemId);
        if (activity) {
          this.emit({
            type: "tool.status",
            data: {
              itemId: params.itemId,
              tool: activity.tool,
              status: "inProgress",
              message: `${activity.startedMessage} · receiving output`,
            },
          });
        }
      }
    } else if (message.method === "item/fileChange/patchUpdated") {
      if (typeof params.itemId === "string") {
        const activity = this.activeTools.get(params.itemId);
        if (activity) {
          const count = Array.isArray(params.changes)
            ? params.changes.length
            : 0;
          this.emit({
            type: "tool.status",
            data: {
              itemId: params.itemId,
              tool: activity.tool,
              status: "inProgress",
              message: count
                ? `Preparing ${count} file change${count === 1 ? "" : "s"}`
                : activity.startedMessage,
            },
          });
        }
      }
    } else if (message.method === "turn/plan/updated") {
      const plan = Array.isArray(params.plan)
        ? params.plan.filter(isRecord)
        : [];
      const completed = plan.filter(
        (step) => step.status === "completed"
      ).length;
      const allCompleted = plan.length > 0 && completed === plan.length;
      const explanation =
        typeof params.explanation === "string"
          ? params.explanation.replace(/\s+/g, " ").trim().slice(0, 120)
          : "";
      const turnId =
        typeof params.turnId === "string" ? params.turnId : randomUUID();
      this.emit({
        type: "tool.status",
        data: {
          itemId: `${turnId}:plan`,
          tool: "plan",
          status: allCompleted ? "completed" : "inProgress",
          message:
            explanation ||
            (plan.length
              ? `${completed} of ${plan.length} plan steps complete`
              : "Building a plan"),
        },
      });
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
      if (
        item.type === "imageGeneration" &&
        typeof item.id === "string" &&
        item.status !== "failed"
      ) {
        const savedPath =
          typeof item.savedPath === "string" && item.savedPath.trim()
            ? item.savedPath
            : undefined;
        const result =
          typeof item.result === "string" && item.result.trim()
            ? item.result
            : undefined;
        if (savedPath || result) {
          this.registerGeneratedImage({ id: item.id, savedPath, result });
        }
      }
      if (item.type === "agentMessage" && typeof item.text === "string") {
        this.emit({
          type: "assistant.final",
          data: {
            text: item.text,
            itemId: typeof item.id === "string" ? item.id : randomUUID(),
          },
        });
      } else if (typeof item.id === "string") {
        const activity =
          this.activeTools.get(item.id) || describeToolItem(item);
        if (!activity) {
          return;
        }
        this.activeTools.delete(item.id);
        const failure = toolFailure(item);
        const status =
          item.status === "failed" ||
          item.success === false ||
          failure !== undefined ||
          (typeof item.exitCode === "number" && item.exitCode !== 0)
            ? "failed"
            : "completed";
        this.emit({
          type: "tool.status",
          data: {
            itemId: item.id,
            tool: activity.tool,
            status,
            message:
              status === "completed" ? activity.completedMessage : undefined,
            ...(failure ? { error: failure } : {}),
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
    } else if (
      message.method === "warning" ||
      message.method === "guardianWarning" ||
      message.method === "configWarning" ||
      message.method === "deprecationNotice"
    ) {
      const warning =
        typeof params.message === "string"
          ? params.message
          : typeof params.summary === "string"
          ? params.summary
          : "Codex reported a warning.";
      this.emit({
        type: "tool.status",
        data: {
          itemId: randomUUID(),
          tool: "warning",
          status: "warning",
          message: warning,
        },
      });
    } else if (message.method === "model/rerouted") {
      const from =
        typeof params.fromModel === "string" ? params.fromModel : "model";
      const to =
        typeof params.toModel === "string" ? params.toModel : "another model";
      this.emit({
        type: "tool.status",
        data: {
          itemId: randomUUID(),
          tool: "model",
          status: "warning",
          message: `Model changed from ${from} to ${to}`,
        },
      });
    } else if (
      message.method === "model/safetyBuffering/updated" &&
      params.showBufferingUi === true
    ) {
      this.emit({
        type: "tool.status",
        data: {
          itemId: randomUUID(),
          tool: "model",
          status: "warning",
          message: "The model is applying additional safety checks",
        },
      });
    }
  }

  private handleServerRequest(id: string | number, method: string) {
    if (
      method === "item/commandExecution/requestApproval" ||
      method === "item/fileChange/requestApproval"
    ) {
      this.emitPolicyWarning(
        "A requested action was blocked by the current permission policy"
      );
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
      this.emitPolicyWarning("Codex requested additional interactive input");
      this.respond(id, { answers: {} });
      return;
    }
    if (method === "mcpServer/elicitation/request") {
      this.emitPolicyWarning("An MCP server requested additional input");
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

  private emitPolicyWarning(message: string) {
    this.emit({
      type: "tool.status",
      data: {
        itemId: randomUUID(),
        tool: "permissions",
        status: "warning",
        message,
      },
    });
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
