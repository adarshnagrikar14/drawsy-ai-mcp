import assert from "node:assert/strict";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

test("stdio MCP exposes only current-canvas tools and authenticates to loopback", async () => {
  const secret = "test-secret";
  let appliedBody = "";
  const server = createServer(async (request, response) => {
    assert.equal(request.headers.authorization, `Bearer ${secret}`);
    if (request.url?.endsWith("/read")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ canvasId: "canvas-1", elements: [] }));
      return;
    }
    for await (const chunk of request) appliedBody += chunk.toString();
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
    },
    stderr: "pipe",
  });
  const client = new Client({ name: "drawsy-test", version: "0.1.0" });

  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "apply_canvas_changes",
      "read_current_canvas",
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
    });
  } finally {
    await client.close();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
});
