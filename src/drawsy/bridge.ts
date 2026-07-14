import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";

import { CodexAppServer } from "./codex-app-server.js";
import { pickFolder } from "./folder-picker.js";
import {
  CANVAS_REQUEST_TIMEOUT_MS,
  MAX_BODY_BYTES,
  isRecord,
  parseCanvasOperations,
  type AgentSettingsPatch,
  type AgentPromptTag,
  type BridgeEvent,
  type CanvasOperations,
} from "./protocol.js";

type FolderSelection = {
  id: string;
  path: string;
  name: string;
  expiresAt: number;
};

type CanvasPending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
};

type Session = {
  id: string;
  token: string;
  internalSecret: string;
  canvasId: string;
  canvasName: string;
  folder: FolderSelection;
  clients: Set<ServerResponse>;
  canvasPending: Map<string, CanvasPending>;
  codex: CodexAppServer;
  touchedAt: number;
};

const json = (response: ServerResponse, status: number, body: unknown) => {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
  });
  response.end(JSON.stringify(body));
};

const safeEqual = (left: string, right: string) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
};

const bearerToken = (request: IncomingMessage) => {
  const value = request.headers.authorization;
  return value?.startsWith("Bearer ") ? value.slice(7) : "";
};

const readJson = async (request: IncomingMessage) => {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Request body exceeds 5 MiB.");
    }
    chunks.push(buffer);
  }
  if (!chunks.length) {
    return {};
  }
  const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  if (!isRecord(value)) {
    throw new Error("Request body must be a JSON object.");
  }
  return value;
};

const parsePromptTags = (value: unknown, label: string): AgentPromptTag[] => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) {
    throw new Error(`${label} must be an array of at most 20 tags.`);
  }
  const tags = value.map((tag) => {
    if (
      !isRecord(tag) ||
      typeof tag.name !== "string" ||
      !tag.name.trim() ||
      typeof tag.path !== "string" ||
      !tag.path.trim()
    ) {
      throw new Error(`${label} contains an invalid tag.`);
    }
    return { name: tag.name.trim(), path: tag.path };
  });
  return tags.filter(
    (tag, index) =>
      tags.findIndex(
        (candidate) =>
          candidate.name === tag.name && candidate.path === tag.path
      ) === index
  );
};

export const createDrawsyBridge = (
  options: {
    port?: number;
    host?: string;
    allowedOrigins?: string[];
  } = {}
) => {
  const port = options.port ?? Number(process.env.PORT || 3031);
  const host = options.host ?? "127.0.0.1";
  const allowedOrigins = new Set(
    options.allowedOrigins ??
      (
        process.env.DRAWSY_ALLOWED_ORIGINS ||
        "http://localhost:3001,http://127.0.0.1:3001"
      )
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean)
  );
  const bridgeUrl = `http://${host}:${port}`;
  const selections = new Map<string, FolderSelection>();
  const sessions = new Map<string, Session>();

  const emit = (session: Session, event: BridgeEvent) => {
    const line = `${JSON.stringify(event)}\n`;
    for (const client of session.clients) {
      client.write(line);
    }
  };

  const closeSession = (session: Session) => {
    sessions.delete(session.id);
    session.codex.close();
    for (const pending of session.canvasPending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error("Drawsy session closed."));
    }
    for (const client of session.clients) {
      client.end();
    }
  };

  const requirePublicOrigin = (
    request: IncomingMessage,
    response: ServerResponse
  ) => {
    const origin = request.headers.origin;
    if (!origin || !allowedOrigins.has(origin)) {
      json(response, 403, {
        error: { code: "origin_denied", message: "Origin is not allowed." },
      });
      return false;
    }
    response.setHeader("access-control-allow-origin", origin);
    response.setHeader("vary", "Origin");
    return true;
  };

  const publicSession = (
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string
  ) => {
    const session = sessions.get(sessionId);
    if (!session || !safeEqual(bearerToken(request), session.token)) {
      json(response, 401, {
        error: { code: "authentication_required", message: "Invalid session." },
      });
      return null;
    }
    session.touchedAt = Date.now();
    return session;
  };

  const internalSession = (
    request: IncomingMessage,
    response: ServerResponse,
    sessionId: string
  ) => {
    const session = sessions.get(sessionId);
    if (!session || !safeEqual(bearerToken(request), session.internalSecret)) {
      json(response, 401, {
        error: {
          code: "authentication_required",
          message: "Invalid MCP scope.",
        },
      });
      return null;
    }
    session.touchedAt = Date.now();
    return session;
  };

  const requestCanvas = (
    session: Session,
    action: "read" | "apply",
    operations?: CanvasOperations
  ) => {
    if (!session.clients.size) {
      throw new Error("The Drawsy canvas is not connected.");
    }
    const requestId = randomUUID();
    emit(session, {
      type: "canvas.request",
      data: {
        requestId,
        action,
        canvasId: session.canvasId,
        ...(operations ? { operations } : {}),
      },
    });
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        session.canvasPending.delete(requestId);
        reject(new Error("Canvas response timed out."));
      }, CANVAS_REQUEST_TIMEOUT_MS);
      session.canvasPending.set(requestId, { resolve, reject, timer });
    });
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url || "/", bridgeUrl);

      if (request.method === "GET" && url.pathname === "/health") {
        json(response, 200, {
          ok: true,
          service: "drawsy-ai-bridge",
          version: "0.1.0",
        });
        return;
      }

      if (request.method === "OPTIONS") {
        if (!requirePublicOrigin(request, response)) return;
        response.setHeader(
          "access-control-allow-methods",
          "GET,POST,DELETE,OPTIONS"
        );
        response.setHeader(
          "access-control-allow-headers",
          "authorization,content-type"
        );
        response.writeHead(204);
        response.end();
        return;
      }

      const internalCanvas = url.pathname.match(
        /^\/internal\/sessions\/([^/]+)\/canvas\/(read|apply)$/
      );
      if (request.method === "POST" && internalCanvas) {
        const session = internalSession(
          request,
          response,
          decodeURIComponent(internalCanvas[1]!)
        );
        if (!session) return;
        const action = internalCanvas[2] as "read" | "apply";
        const body = await readJson(request);
        const result = await requestCanvas(
          session,
          action,
          action === "apply" ? parseCanvasOperations(body) : undefined
        );
        json(response, 200, result);
        return;
      }

      if (!requirePublicOrigin(request, response)) return;

      if (request.method === "POST" && url.pathname === "/v1/folders/pick") {
        const folder = await pickFolder();
        const selection: FolderSelection = {
          id: randomUUID(),
          ...folder,
          expiresAt: Date.now() + 60 * 60 * 1000,
        };
        selections.set(selection.id, selection);
        json(response, 200, {
          selectionId: selection.id,
          name: selection.name,
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/v1/sessions") {
        const body = await readJson(request);
        const selectionId =
          typeof body.selectionId === "string" ? body.selectionId : "";
        const canvasId = typeof body.canvasId === "string" ? body.canvasId : "";
        const canvasName =
          typeof body.canvasName === "string" ? body.canvasName : "Untitled";
        const folder = selections.get(selectionId);
        if (!folder || folder.expiresAt <= Date.now()) {
          json(response, 400, {
            error: {
              code: "folder_expired",
              message: "Choose the folder again.",
            },
          });
          return;
        }
        if (!canvasId) {
          json(response, 400, {
            error: {
              code: "canvas_required",
              message: "A current canvas is required.",
            },
          });
          return;
        }
        const id = randomUUID();
        const token = randomBytes(32).toString("base64url");
        const internalSecret = randomBytes(32).toString("base64url");
        let sessionRef: Session | null = null;
        const codex = await CodexAppServer.start(
          folder.path,
          { id, secret: internalSecret, bridgeUrl },
          (event) => sessionRef && emit(sessionRef, event)
        );
        const session: Session = {
          id,
          token,
          internalSecret,
          canvasId,
          canvasName,
          folder,
          clients: new Set(),
          canvasPending: new Map(),
          codex,
          touchedAt: Date.now(),
        };
        sessionRef = session;
        sessions.set(id, session);
        json(response, 201, { id, token, folderName: folder.name });
        return;
      }

      const eventsMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/events$/
      );
      if (request.method === "GET" && eventsMatch) {
        const session = publicSession(
          request,
          response,
          decodeURIComponent(eventsMatch[1]!)
        );
        if (!session) return;
        response.writeHead(200, {
          "content-type": "application/x-ndjson; charset=utf-8",
          "cache-control": "no-store",
          connection: "keep-alive",
        });
        session.clients.add(response);
        response.write(
          `${JSON.stringify({
            type: "session.ready",
            data: {
              folderName: session.folder.name,
              agent: session.codex.metadata,
            },
          })}\n`
        );
        const heartbeat = setInterval(() => response.write("\n"), 15_000);
        request.on("close", () => {
          clearInterval(heartbeat);
          session.clients.delete(response);
        });
        return;
      }

      const turnMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)\/turns$/);
      if (request.method === "POST" && turnMatch) {
        const session = publicSession(
          request,
          response,
          decodeURIComponent(turnMatch[1]!)
        );
        if (!session) return;
        const body = await readJson(request);
        const message =
          typeof body.message === "string" ? body.message.trim() : "";
        if (!message || message.length > 20_000) {
          json(response, 400, {
            error: {
              code: "invalid_message",
              message: "Message is empty or too long.",
            },
          });
          return;
        }
        await session.codex.startTurn(message, {
          skills: parsePromptTags(body.skills, "skills"),
          plugins: parsePromptTags(body.plugins, "plugins"),
        });
        json(response, 202, { accepted: true });
        return;
      }

      const controlsMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/controls$/
      );
      if (request.method === "GET" && controlsMatch) {
        const session = publicSession(
          request,
          response,
          decodeURIComponent(controlsMatch[1]!)
        );
        if (!session) return;
        json(response, 200, await session.codex.getControls());
        return;
      }

      const settingsMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/settings$/
      );
      if (request.method === "POST" && settingsMatch) {
        const session = publicSession(
          request,
          response,
          decodeURIComponent(settingsMatch[1]!)
        );
        if (!session) return;
        const body = await readJson(request);
        const allowedKeys = new Set([
          "model",
          "effort",
          "accessMode",
          "internetEnabled",
        ]);
        if (Object.keys(body).some((key) => !allowedKeys.has(key))) {
          json(response, 400, {
            error: {
              code: "invalid_settings",
              message: "Unknown Codex setting.",
            },
          });
          return;
        }
        if (
          (body.model !== undefined && typeof body.model !== "string") ||
          (body.effort !== undefined && typeof body.effort !== "string") ||
          (body.accessMode !== undefined &&
            body.accessMode !== "workspace" &&
            body.accessMode !== "readOnly") ||
          (body.internetEnabled !== undefined &&
            typeof body.internetEnabled !== "boolean")
        ) {
          json(response, 400, {
            error: {
              code: "invalid_settings",
              message: "Invalid Codex setting value.",
            },
          });
          return;
        }
        json(
          response,
          200,
          await session.codex.updateSettings(body as AgentSettingsPatch)
        );
        return;
      }

      const canvasResponseMatch = url.pathname.match(
        /^\/v1\/sessions\/([^/]+)\/canvas-responses$/
      );
      if (request.method === "POST" && canvasResponseMatch) {
        const session = publicSession(
          request,
          response,
          decodeURIComponent(canvasResponseMatch[1]!)
        );
        if (!session) return;
        const body = await readJson(request);
        const requestId =
          typeof body.requestId === "string" ? body.requestId : "";
        const pending = session.canvasPending.get(requestId);
        if (!pending) {
          json(response, 404, {
            error: {
              code: "request_not_found",
              message: "Canvas request expired.",
            },
          });
          return;
        }
        session.canvasPending.delete(requestId);
        clearTimeout(pending.timer);
        if (body.ok === true) {
          pending.resolve(body.data ?? { ok: true });
        } else {
          pending.reject(
            new Error(
              typeof body.error === "string"
                ? body.error
                : "Canvas operation failed."
            )
          );
        }
        json(response, 200, { accepted: true });
        return;
      }

      const sessionMatch = url.pathname.match(/^\/v1\/sessions\/([^/]+)$/);
      if (request.method === "DELETE" && sessionMatch) {
        const session = publicSession(
          request,
          response,
          decodeURIComponent(sessionMatch[1]!)
        );
        if (!session) return;
        closeSession(session);
        response.writeHead(204);
        response.end();
        return;
      }

      json(response, 404, {
        error: { code: "not_found", message: "Route not found." },
      });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Unexpected bridge error.";
      const status = message.includes("cancelled")
        ? 409
        : message.includes("5 MiB")
        ? 413
        : 500;
      json(response, status, { error: { code: "bridge_error", message } });
    }
  });

  const cleanup = setInterval(() => {
    const now = Date.now();
    for (const [id, selection] of selections) {
      if (selection.expiresAt <= now) selections.delete(id);
    }
    for (const session of sessions.values()) {
      if (now - session.touchedAt > 30 * 60 * 1000) closeSession(session);
    }
  }, 60_000);
  cleanup.unref();

  return {
    server,
    listen: () =>
      new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, host, () => {
          server.off("error", reject);
          resolve();
        });
      }),
    close: () =>
      new Promise<void>((resolve, reject) => {
        clearInterval(cleanup);
        for (const session of [...sessions.values()]) closeSession(session);
        server.close((error) => (error ? reject(error) : resolve()));
      }),
    address: bridgeUrl,
  };
};
