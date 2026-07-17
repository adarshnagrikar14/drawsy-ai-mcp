import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createRemoteSessionWorkspace,
  PreviewPortAllocator,
  RemotePreviewProxy,
  removeRemoteSessionWorkspace
} from "./remote-runtime.js";

const listen = (server: ReturnType<typeof createServer>) =>
  new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Test server did not bind to TCP."));
        return;
      }
      resolve(address.port);
    });
  });

const close = (server: ReturnType<typeof createServer>) =>
  new Promise<void>((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve()))
  );

const get = (port: number, host: string, requestPath: string) =>
  new Promise<{ status: number; body: string }>((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: "127.0.0.1",
        port,
        path: requestPath,
        headers: { host }
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () =>
          resolve({
            status: response.statusCode || 0,
            body: Buffer.concat(chunks).toString("utf8")
          })
        );
      }
    );
    request.on("error", reject);
    request.end();
  });

test("remote sessions isolate files and proxy a private loopback preview", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drawsy-remote-test-"));
  const source = path.join(root, "source");
  const workspaces = path.join(root, "sessions");
  await mkdir(path.join(source, ".drawsy", "context", "stale"), {
    recursive: true
  });
  await writeFile(path.join(source, "package.json"), '{"name":"demo"}\n');
  await writeFile(
    path.join(source, ".drawsy", "context", "stale", "capture.png"),
    "old"
  );

  const upstream = createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/plain" });
    response.end(`preview:${request.url}`);
  });
  const upstreamPort = await listen(upstream);
  let proxy!: RemotePreviewProxy;
  const gateway = createServer((request, response) => {
    if (!proxy.handleHttp(request, response)) {
      response.writeHead(404);
      response.end("not found");
    }
  });
  const gatewayPort = await listen(gateway);
  const config = {
    workspaceRoot: workspaces,
    previewOriginTemplate: `http://{token}.preview.localhost:${gatewayPort}`,
    idleMs: 20 * 60 * 1000,
    previewPortStart: 18_000,
    previewPortEnd: 18_099
  };
  proxy = new RemotePreviewProxy(config);

  try {
    const workspace = await createRemoteSessionWorkspace(
      config,
      "session-one",
      source
    );
    assert.equal(
      await readFile(path.join(workspace, "package.json"), "utf8"),
      '{"name":"demo"}\n'
    );
    await assert.rejects(
      stat(path.join(workspace, ".drawsy", "context", "stale")),
      /ENOENT/
    );

    let touched = 0;
    const attached = proxy.attach(
      "session-one",
      {
        previewId: "preview-one",
        url: `http://127.0.0.1:${upstreamPort}/dashboard?mode=dev`
      },
      () => touched++
    );
    const publicUrl = new URL(attached.url);
    assert.equal(publicUrl.pathname, "/dashboard");
    assert.equal(publicUrl.search, "?mode=dev");
    const response = await get(
      gatewayPort,
      publicUrl.host,
      "/assets/app.js?hot=1"
    );
    assert.deepEqual(response, {
      status: 200,
      body: "preview:/assets/app.js?hot=1"
    });
    assert.equal(touched, 1);

    proxy.removeSession("session-one");
    assert.equal(
      (await get(gatewayPort, publicUrl.host, "/dashboard")).status,
      404
    );
    await removeRemoteSessionWorkspace(workspace);
    await assert.rejects(stat(workspace), /ENOENT/);
  } finally {
    await close(gateway);
    await close(upstream);
    await rm(root, { recursive: true, force: true });
  }
});

test("preview ports are unique per concurrent session and reusable", async () => {
  const allocator = new PreviewPortAllocator(18_100, 18_104);
  const ports = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      allocator.acquire(`session-${index}`)
    )
  );
  assert.equal(
    ports.every((port) => port !== null),
    true
  );
  assert.equal(new Set(ports).size, 5);
  allocator.release("session-2");
  const replacement = await allocator.acquire("session-replacement");
  assert.equal(typeof replacement, "number");
  assert.equal(ports.includes(replacement), true);
});
