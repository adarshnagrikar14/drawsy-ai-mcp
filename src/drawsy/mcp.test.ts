import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP exposes only current-canvas tools and authenticates to loopback", async () => {
  const secret = "test-secret";
  const testRoot = await mkdtemp(path.join(tmpdir(), "drawsy-mcp-test-"));
  const workspaceRoot = path.join(testRoot, "workspace");
  await mkdir(workspaceRoot);
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
    "base64"
  );
  await writeFile(path.join(workspaceRoot, "generated.png"), png);
  await writeFile(path.join(testRoot, "outside.png"), png);
  let appliedBody = "";
  const connectorRequests: Array<{ url: string; body: unknown }> = [];
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    if (request.url?.endsWith("/connectors/list")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          sources: [
            {
              connectionId: "google-one",
              capability: "mail",
              label: "gmail",
              accountLabel: "person@example.com",
            },
          ],
        })
      );
      return;
    }
    if (
      request.url?.endsWith("/connectors/search") ||
      request.url?.endsWith("/connectors/read")
    ) {
      let body = "";
      for await (const chunk of request) body += chunk.toString();
      connectorRequests.push({ url: request.url, body: JSON.parse(body) });
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        request.url.endsWith("/search")
          ? JSON.stringify({
              operation: "search",
              capability: "mail",
              items: [{ id: "opaque-message", title: "Project update" }],
              nextCursor: null,
            })
          : JSON.stringify({
              operation: "read",
              capability: "mail",
              item: { id: "opaque-message", content: "Status is green." },
            })
      );
      return;
    }
    if (request.url?.endsWith("/read")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ canvasId: "canvas-1", elements: [] }));
      return;
    }
    for await (const chunk of request) appliedBody += chunk.toString();
    if (request.url?.endsWith("/image")) {
      const body = JSON.parse(appliedBody);
      if (body.sourcePath === "../outside.png") {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            error: { message: "The image must be inside the selected folder." },
          })
        );
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ elementId: "image-1", width: 320, height: 320 })
      );
      return;
    }
    if (request.url?.endsWith("/context")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(
        JSON.stringify({
          id: "context-1",
          previewPath: path.join(
            workspaceRoot,
            ".drawsy/context/selection.png"
          ),
          elementIds: ["image-1", "note-1"],
          sourceImages: [
            {
              id: "source-1",
              path: path.join(workspaceRoot, ".drawsy/context/source.png"),
            },
          ],
        })
      );
      return;
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: true }));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const mcpPath = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "mcp.js"
  );
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpPath],
    env: {
      PATH: process.env.PATH || "",
      DRAWSY_BRIDGE_URL: `http://127.0.0.1:${address.port}`,
      DRAWSY_SESSION_ID: "session-1",
      DRAWSY_SESSION_SECRET: secret,
      DRAWSY_WORKSPACE_ROOT: workspaceRoot,
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "drawsy-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "add_image_from_file",
      "apply_canvas_changes",
      "capture_canvas_context",
      "list_connected_sources",
      "read_connected_item",
      "read_current_canvas",
      "replace_canvas_image_from_file",
      "search_connected_source",
    ]);
    assert.equal(
      tools.tools.some(
        (tool) => "canvasId" in (tool.inputSchema.properties || {})
      ),
      false
    );

    const read = await client.callTool({
      name: "read_current_canvas",
      arguments: {},
    });
    assert.match(JSON.stringify(read.content), /canvas-1/);
    const apply = await client.callTool({
      name: "apply_canvas_changes",
      arguments: {
        upsertElements: [{ id: "r1", type: "rectangle" }],
        deleteElementIds: ["old"],
      },
    });
    assert.equal(apply.isError, undefined);
    assert.deepEqual(JSON.parse(appliedBody), {
      upsertElements: [{ id: "r1", type: "rectangle" }],
      deleteElementIds: ["old"],
      files: [],
    });

    appliedBody = "";
    const image = await client.callTool({
      name: "add_image_from_file",
      arguments: {
        sourcePath: "generated.png",
        x: 40,
        y: 60,
        maxWidth: 320,
      },
    });
    assert.equal(image.isError, undefined);
    assert.deepEqual(JSON.parse(appliedBody), {
      sourcePath: "generated.png",
      x: 40,
      y: 60,
      maxWidth: 320,
    });
    assert.match(JSON.stringify(image.content), /image-1 \(320 × 320\)/);

    appliedBody = "";
    const escaped = await client.callTool({
      name: "add_image_from_file",
      arguments: {
        sourcePath: "../outside.png",
        x: 0,
        y: 0,
        maxWidth: 100,
      },
    });
    assert.equal(escaped.isError, true);
    assert.match(JSON.stringify(escaped.content), /selected folder/);

    appliedBody = "";
    const context = await client.callTool({
      name: "capture_canvas_context",
      arguments: {
        elementIds: ["image-1", "note-1"],
        includeSourceImages: true,
        maxDimension: 2048,
      },
    });
    assert.equal(context.isError, undefined);
    assert.deepEqual(JSON.parse(appliedBody), {
      elementIds: ["image-1", "note-1"],
      includeSourceImages: true,
      maxDimension: 2048,
    });
    assert.match(JSON.stringify(context.content), /selection\.png/);
    assert.match(JSON.stringify(context.content), /source\.png/);

    appliedBody = "";
    const replacement = await client.callTool({
      name: "replace_canvas_image_from_file",
      arguments: {
        targetElementId: "image-1",
        sourcePath: "generated.png",
      },
    });
    assert.equal(replacement.isError, undefined);
    assert.deepEqual(JSON.parse(appliedBody), {
      targetElementId: "image-1",
      sourcePath: "generated.png",
    });

    const sources = await client.callTool({
      name: "list_connected_sources",
      arguments: {},
    });
    assert.match(JSON.stringify(sources.content), /person@example\.com/);
    const search = await client.callTool({
      name: "search_connected_source",
      arguments: {
        capability: "mail",
        connectionId: "google-one",
        query: "project update",
      },
    });
    assert.match(JSON.stringify(search.content), /opaque-message/);
    const connectedItem = await client.callTool({
      name: "read_connected_item",
      arguments: {
        capability: "mail",
        connectionId: "google-one",
        resourceId: "opaque-message",
      },
    });
    assert.match(JSON.stringify(connectedItem.content), /Status is green/);
    assert.deepEqual(connectorRequests, [
      {
        url: "/internal/sessions/session-1/connectors/search",
        body: {
          capability: "mail",
          connectionId: "google-one",
          query: "project update",
          limit: 10,
        },
      },
      {
        url: "/internal/sessions/session-1/connectors/read",
        body: {
          capability: "mail",
          connectionId: "google-one",
          resourceId: "opaque-message",
        },
      },
    ]);
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
    await rm(testRoot, { recursive: true, force: true });
  }
});
