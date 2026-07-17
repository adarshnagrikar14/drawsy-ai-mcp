import { randomBytes } from "node:crypto";
import { cp, mkdir, readdir, realpath, rm } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createServer } from "node:net";
import type { Duplex } from "node:stream";
import path from "node:path";

import type { LivePreviewRequest } from "./protocol.js";

const DEFAULT_REMOTE_IDLE_MS = 20 * 60 * 1000;
const DEFAULT_PREVIEW_PORT_START = 18_000;
const DEFAULT_PREVIEW_PORT_END = 18_099;
const PREVIEW_READY_TIMEOUT_MS = 5_000;
const PREVIEW_READY_RETRY_MS = 100;
const RESERVED_DRAWSY_PORTS = new Set([3001, 3002, 3003, 3004, 3020, 3031]);
const PREVIEW_TOKEN = "previewtoken";
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade"
]);

export type RemoteRuntimeConfig = {
  workspaceRoot: string;
  previewOriginTemplate: string;
  idleMs: number;
  previewPortStart: number;
  previewPortEnd: number;
};

type PreviewTarget = {
  sessionId: string;
  previewId: string;
  token: string;
  target: URL;
  publicOrigin: URL;
  touch: () => void;
};

const isLoopbackHost = (hostname: string) =>
  hostname === "localhost" ||
  hostname === "127.0.0.1" ||
  hostname === "[::1]" ||
  hostname.endsWith(".localhost");

export const readRemoteRuntimeConfig = (): RemoteRuntimeConfig | null => {
  const workspaceRoot = process.env.DRAWSY_REMOTE_WORKSPACES_ROOT?.trim();
  const previewOriginTemplate =
    process.env.DRAWSY_PREVIEW_ORIGIN_TEMPLATE?.trim();
  if (!workspaceRoot && !previewOriginTemplate) return null;
  if (!workspaceRoot || !previewOriginTemplate) {
    throw new Error(
      "Remote execution requires both DRAWSY_REMOTE_WORKSPACES_ROOT and DRAWSY_PREVIEW_ORIGIN_TEMPLATE."
    );
  }
  if (!path.isAbsolute(workspaceRoot)) {
    throw new Error("DRAWSY_REMOTE_WORKSPACES_ROOT must be an absolute path.");
  }
  if (
    previewOriginTemplate.split("{token}").length !== 2 ||
    !previewOriginTemplate.includes("{token}")
  ) {
    throw new Error(
      "DRAWSY_PREVIEW_ORIGIN_TEMPLATE must contain exactly one {token}."
    );
  }
  const previewOrigin = new URL(
    previewOriginTemplate.replace("{token}", PREVIEW_TOKEN)
  );
  if (
    (previewOrigin.protocol !== "https:" &&
      !(
        previewOrigin.protocol === "http:" &&
        isLoopbackHost(previewOrigin.hostname)
      )) ||
    previewOrigin.username ||
    previewOrigin.password ||
    previewOrigin.pathname !== "/" ||
    previewOrigin.search ||
    previewOrigin.hash
  ) {
    throw new Error(
      "DRAWSY_PREVIEW_ORIGIN_TEMPLATE must be an HTTPS origin (or loopback HTTP for development)."
    );
  }
  const configuredIdleMs = Number(process.env.DRAWSY_REMOTE_SESSION_IDLE_MS);
  const idleMs = Number.isFinite(configuredIdleMs)
    ? configuredIdleMs
    : DEFAULT_REMOTE_IDLE_MS;
  if (
    !Number.isInteger(idleMs) ||
    idleMs < 60_000 ||
    idleMs > 24 * 60 * 60_000
  ) {
    throw new Error(
      "DRAWSY_REMOTE_SESSION_IDLE_MS must be between 60000 and 86400000."
    );
  }
  const configuredPortRange =
    process.env.DRAWSY_PREVIEW_PORT_RANGE?.trim() ||
    `${DEFAULT_PREVIEW_PORT_START}-${DEFAULT_PREVIEW_PORT_END}`;
  const portRange = configuredPortRange.match(/^(\d{1,5})-(\d{1,5})$/);
  const previewPortStart = Number(portRange?.[1]);
  const previewPortEnd = Number(portRange?.[2]);
  if (
    !portRange ||
    !Number.isInteger(previewPortStart) ||
    !Number.isInteger(previewPortEnd) ||
    previewPortStart < 1024 ||
    previewPortEnd > 65_535 ||
    previewPortEnd - previewPortStart + 1 < 5 ||
    [...RESERVED_DRAWSY_PORTS].some(
      (port) => port >= previewPortStart && port <= previewPortEnd
    )
  ) {
    throw new Error(
      "DRAWSY_PREVIEW_PORT_RANGE must provide at least five ports between 1024 and 65535 without overlapping Drawsy service ports."
    );
  }
  return {
    workspaceRoot: path.resolve(workspaceRoot),
    previewOriginTemplate,
    idleMs,
    previewPortStart,
    previewPortEnd
  };
};

const portIsAvailable = (port: number) =>
  new Promise<boolean>((resolve) => {
    const probe = createServer();
    probe.unref();
    probe.once("error", () => resolve(false));
    probe.listen({ host: "127.0.0.1", port, exclusive: true }, () => {
      probe.close((error) => resolve(!error));
    });
  });

export class PreviewPortAllocator {
  private readonly bySession = new Map<string, number>();
  private readonly leased = new Set<number>();
  private cursor: number;
  private allocationQueue = Promise.resolve();

  constructor(private readonly start: number, private readonly end: number) {
    this.cursor = start;
  }

  acquire(sessionId: string) {
    const allocation = this.allocationQueue.then(() =>
      this.acquireAvailable(sessionId)
    );
    this.allocationQueue = allocation.then(
      () => undefined,
      () => undefined
    );
    return allocation;
  }

  private async acquireAvailable(sessionId: string) {
    const existing = this.bySession.get(sessionId);
    if (existing) return existing;
    const size = this.end - this.start + 1;
    for (let offset = 0; offset < size; offset++) {
      const port = this.start + ((this.cursor - this.start + offset) % size);
      if (this.leased.has(port) || !(await portIsAvailable(port))) continue;
      this.bySession.set(sessionId, port);
      this.leased.add(port);
      this.cursor = port === this.end ? this.start : port + 1;
      return port;
    }
    return null;
  }

  release(sessionId: string) {
    const port = this.bySession.get(sessionId);
    if (port === undefined) return;
    this.bySession.delete(sessionId);
    this.leased.delete(port);
  }
}

export const createRemoteSessionWorkspace = async (
  config: RemoteRuntimeConfig,
  sessionId: string,
  sourcePath: string
) => {
  const source = await realpath(sourcePath);
  await mkdir(config.workspaceRoot, { recursive: true });
  const root = await realpath(config.workspaceRoot);
  const target = path.join(root, sessionId);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("The remote session workspace path is invalid.");
  }
  await mkdir(target, { recursive: false });
  try {
    for (const entry of await readdir(source, { withFileTypes: true })) {
      await cp(path.join(source, entry.name), path.join(target, entry.name), {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
        filter: (candidate) => {
          const candidateRelative = path.relative(source, candidate);
          return (
            candidateRelative !== path.join(".drawsy", "context") &&
            !candidateRelative.startsWith(
              `${path.join(".drawsy", "context")}${path.sep}`
            )
          );
        }
      });
    }
    return target;
  } catch (error) {
    await rm(target, { recursive: true, force: true });
    throw error;
  }
};

export const removeRemoteSessionWorkspace = async (workspacePath: string) => {
  await rm(workspacePath, { recursive: true, force: true });
};

const requestHeaders = (request: IncomingMessage, target: URL) => {
  const headers = { ...request.headers };
  for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
  delete headers.cookie;
  headers.host = target.host;
  if (headers.origin) headers.origin = target.origin;
  if (headers.referer) headers.referer = target.origin;
  headers["x-forwarded-host"] = request.headers.host || "";
  headers["x-forwarded-proto"] = "https";
  return headers;
};

const writeUpgradeResponse = (socket: Duplex, response: IncomingMessage) => {
  const lines = [`HTTP/1.1 ${response.statusCode} ${response.statusMessage}`];
  for (let index = 0; index < response.rawHeaders.length; index += 2) {
    lines.push(
      `${response.rawHeaders[index]}: ${response.rawHeaders[index + 1]}`
    );
  }
  socket.write(`${lines.join("\r\n")}\r\n\r\n`);
};

const previewResponds = (target: URL) =>
  new Promise<boolean>((resolve) => {
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const request = transport(
      target,
      { method: "GET", headers: { accept: "text/html,*/*" } },
      (response) => {
        response.resume();
        resolve(true);
      }
    );
    request.setTimeout(750, () => request.destroy());
    request.once("error", () => resolve(false));
    request.end();
  });

const waitForPreview = async (target: URL) => {
  const deadline = Date.now() + PREVIEW_READY_TIMEOUT_MS;
  do {
    if (await previewResponds(target)) return;
    await new Promise((resolve) => setTimeout(resolve, PREVIEW_READY_RETRY_MS));
  } while (Date.now() < deadline);
  throw new Error(
    `The live preview server at ${target.origin} is not running. Start it successfully before attaching it to the canvas.`
  );
};

export class RemotePreviewProxy {
  private readonly byHost = new Map<string, PreviewTarget>();
  private readonly byPreview = new Map<string, PreviewTarget>();
  private readonly previewHostnamePrefix: string;
  private readonly previewHostnameSuffix: string;

  constructor(private readonly config: RemoteRuntimeConfig) {
    const hostname = new URL(
      config.previewOriginTemplate.replace("{token}", PREVIEW_TOKEN)
    ).hostname.toLowerCase();
    const tokenIndex = hostname.indexOf(PREVIEW_TOKEN);
    this.previewHostnamePrefix = hostname.slice(0, tokenIndex);
    this.previewHostnameSuffix = hostname.slice(
      tokenIndex + PREVIEW_TOKEN.length
    );
  }

  async attach(
    sessionId: string,
    request: LivePreviewRequest,
    touch: () => void
  ): Promise<LivePreviewRequest> {
    const requestTarget = new URL(request.url);
    await waitForPreview(requestTarget);
    const previewId = request.previewId || randomBytes(16).toString("hex");
    const key = `${sessionId}:${previewId}`;
    const previous = this.byPreview.get(key);
    const token = previous?.token || randomBytes(24).toString("hex");
    const publicOrigin = new URL(
      this.config.previewOriginTemplate.replace("{token}", token)
    );
    const target: PreviewTarget = {
      sessionId,
      previewId,
      token,
      target: requestTarget,
      publicOrigin,
      touch
    };
    if (previous) this.byHost.delete(previous.publicOrigin.host.toLowerCase());
    this.byPreview.set(key, target);
    this.byHost.set(publicOrigin.host.toLowerCase(), target);
    const publicUrl = new URL(target.target.pathname, publicOrigin);
    publicUrl.search = target.target.search;
    return { ...request, previewId, url: publicUrl.toString() };
  }

  removeSession(sessionId: string) {
    for (const [key, preview] of this.byPreview) {
      if (preview.sessionId !== sessionId) continue;
      this.byPreview.delete(key);
      this.byHost.delete(preview.publicOrigin.host.toLowerCase());
    }
  }

  handleHttp(request: IncomingMessage, response: ServerResponse) {
    const preview = this.lookup(request);
    if (!preview) {
      if (!this.isPreviewHost(request)) return false;
      response.writeHead(410, {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store"
      });
      response.end(
        "This live preview has expired. Ask Drawsy to start and attach it again."
      );
      return true;
    }
    preview.touch();
    const target = this.targetUrl(preview, request.url || "/");
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = transport(
      target,
      {
        method: request.method,
        headers: requestHeaders(request, target)
      },
      (upstreamResponse) => {
        const headers = { ...upstreamResponse.headers };
        for (const name of HOP_BY_HOP_HEADERS) delete headers[name];
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        delete headers["content-security-policy-report-only"];
        headers["cache-control"] = "no-store";
        const location = headers.location;
        if (typeof location === "string") {
          try {
            const resolved = new URL(location, target);
            if (resolved.origin === preview.target.origin) {
              headers.location = new URL(
                `${resolved.pathname}${resolved.search}${resolved.hash}`,
                preview.publicOrigin
              ).toString();
            }
          } catch {
            // Preserve malformed upstream redirects; the browser will reject them.
          }
        }
        response.writeHead(upstreamResponse.statusCode || 502, headers);
        upstreamResponse.pipe(response);
      }
    );
    upstream.on("error", () => {
      if (!response.headersSent) {
        response.writeHead(502, {
          "content-type": "text/plain; charset=utf-8",
          "cache-control": "no-store"
        });
      }
      response.end("The local preview server is unavailable.");
    });
    request.pipe(upstream);
    return true;
  }

  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const preview = this.lookup(request);
    if (!preview) return false;
    preview.touch();
    const target = this.targetUrl(preview, request.url || "/");
    const transport = target.protocol === "https:" ? httpsRequest : httpRequest;
    const upstream = transport({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      path: `${target.pathname}${target.search}`,
      method: request.method,
      headers: {
        ...requestHeaders(request, target),
        connection: "Upgrade",
        upgrade: request.headers.upgrade || "websocket"
      }
    });
    upstream.on("upgrade", (upstreamResponse, upstreamSocket, upstreamHead) => {
      writeUpgradeResponse(socket, upstreamResponse);
      if (upstreamHead.length) socket.write(upstreamHead);
      if (head.length) upstreamSocket.write(head);
      upstreamSocket.pipe(socket).pipe(upstreamSocket);
    });
    upstream.on("response", (upstreamResponse) => {
      writeUpgradeResponse(socket, upstreamResponse);
      upstreamResponse.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    upstream.end();
    return true;
  }

  private lookup(request: IncomingMessage) {
    const host = request.headers.host?.toLowerCase();
    return host ? this.byHost.get(host) : undefined;
  }

  private isPreviewHost(request: IncomingMessage) {
    const host = request.headers.host;
    if (!host) return false;
    let hostname: string;
    try {
      hostname = new URL(`http://${host}`).hostname.toLowerCase();
    } catch {
      return false;
    }
    const tokenLength =
      hostname.length -
      this.previewHostnamePrefix.length -
      this.previewHostnameSuffix.length;
    return (
      tokenLength > 0 &&
      hostname.startsWith(this.previewHostnamePrefix) &&
      hostname.endsWith(this.previewHostnameSuffix)
    );
  }

  private targetUrl(preview: PreviewTarget, requestUrl: string) {
    const incoming = new URL(requestUrl, preview.publicOrigin);
    const target = new URL(preview.target.origin);
    target.pathname = incoming.pathname;
    target.search = incoming.search;
    return target;
  }
}
