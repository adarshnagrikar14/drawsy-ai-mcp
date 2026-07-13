import assert from "node:assert/strict";
import {
  chmod,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import test from "node:test";

import { createDrawsyBridge } from "./bridge.js";
import { parseCanvasOperations } from "./protocol.js";

test("canvas operations reject malformed and ambiguous input", () => {
  assert.deepEqual(parseCanvasOperations({}), {
    upsertElements: [],
    deleteElementIds: [],
  });
  assert.throws(() => parseCanvasOperations({ upsertElements: {} }), /array/);
  assert.throws(
    () => parseCanvasOperations({ deleteElementIds: [""] }),
    /non-empty/
  );
});

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });

test("bridge starts a folder-scoped Codex session with only Drawsy MCP", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "drawsy-bridge-test-"));
  const selectedFolder = path.join(root, "workspace");
  const requestLog = path.join(root, "requests.ndjson");
  const fakeCodex = path.join(root, "fake-codex.mjs");
  await import("node:fs/promises").then(({ mkdir }) => mkdir(selectedFolder));
  const canonicalFolder = await realpath(selectedFolder);
  await writeFile(
    fakeCodex,
    `#!/usr/bin/env node
import readline from "node:readline";
import { appendFile } from "node:fs/promises";
const log = process.env.DRAWSY_TEST_REQUEST_LOG;
const send = (value) => process.stdout.write(JSON.stringify(value) + "\\n");
readline.createInterface({ input: process.stdin }).on("line", async (line) => {
  const message = JSON.parse(line);
  if (message.id) await appendFile(log, JSON.stringify(message) + "\\n");
  if (message.method === "initialize") send({ id: message.id, result: { ok: true } });
  if (message.method === "config/read") send({ id: message.id, result: { config: { mcp_servers: { inherited: { command: "bad" } } } } });
  if (message.method === "thread/start") {
    send({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-test", modelProvider: "openai", reasoningEffort: "medium", serviceTier: null, activePermissionProfile: { id: ":workspace" }, runtimeWorkspaceRoots: message.params.runtimeWorkspaceRoots, approvalPolicy: "never", sandbox: { networkAccess: false } } });
    send({ method: "mcpServer/startupStatus/updated", params: { threadId: "thread-1", name: "drawsy", status: "ready" } });
  }
  if (message.method === "turn/start") {
    send({ id: message.id, result: { turn: { id: "turn-1" } } });
    send({ method: "turn/started", params: { threadId: "thread-1", turn: { id: "turn-1", status: "inProgress" } } });
    send({ method: "item/started", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "mcpToolCall", id: "tool-1", server: "drawsy", tool: "read_current_canvas", status: "inProgress" } } });
    send({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "mcpToolCall", id: "tool-1", server: "drawsy", tool: "read_current_canvas", status: "completed", error: null } } });
    send({ method: "item/agentMessage/delta", params: { delta: "Ready", itemId: "message-1", threadId: "thread-1", turnId: "turn-1" } });
    send({ id: "server-time", method: "currentTime/read", params: {} });
  }
  if (message.id === "server-time" && message.result) {
    send({ method: "turn/completed", params: { turn: { status: "completed" } } });
  }
});
`
  );
  await chmod(fakeCodex, 0o755);

  const port = await freePort();
  const origin = "http://localhost:3001";
  const previousEnv = {
    NODE_ENV: process.env.NODE_ENV,
    DRAWSY_TEST_FOLDER: process.env.DRAWSY_TEST_FOLDER,
    DRAWSY_CODEX_BIN: process.env.DRAWSY_CODEX_BIN,
    DRAWSY_TEST_REQUEST_LOG: process.env.DRAWSY_TEST_REQUEST_LOG,
  };
  process.env.NODE_ENV = "test";
  process.env.DRAWSY_TEST_FOLDER = selectedFolder;
  process.env.DRAWSY_CODEX_BIN = fakeCodex;
  process.env.DRAWSY_TEST_REQUEST_LOG = requestLog;
  const bridge = createDrawsyBridge({ port, allowedOrigins: [origin] });

  try {
    await bridge.listen();
    const headers = { origin, "content-type": "application/json" };
    const picked = (await fetch(`${bridge.address}/v1/folders/pick`, {
      method: "POST",
      headers,
    }).then((response) => response.json())) as {
      selectionId: string;
      name: string;
    };
    assert.equal(picked.name, "workspace");

    const session = (await fetch(`${bridge.address}/v1/sessions`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        selectionId: picked.selectionId,
        canvasId: "canvas-1",
        canvasName: "Canvas 1",
      }),
    }).then((response) => response.json())) as { id: string; token: string };

    const eventsResponse = await fetch(
      `${bridge.address}/v1/sessions/${session.id}/events`,
      {
        headers: { origin, authorization: `Bearer ${session.token}` },
      }
    );
    assert.equal(eventsResponse.status, 200);
    const reader = eventsResponse.body!.getReader();
    const firstEvent = await reader.read();
    const ready = JSON.parse(new TextDecoder().decode(firstEvent.value));
    assert.equal(ready.type, "session.ready");
    assert.deepEqual(ready.data.agent, {
      model: "gpt-test",
      modelProvider: "openai",
      reasoningEffort: "medium",
      serviceTier: null,
    });

    const turnResponse = await fetch(
      `${bridge.address}/v1/sessions/${session.id}/turns`,
      {
        method: "POST",
        headers: { ...headers, authorization: `Bearer ${session.token}` },
        body: JSON.stringify({ message: "Inspect the folder." }),
      }
    );
    assert.equal(turnResponse.status, 202);

    let turnEvents = "";
    while (!turnEvents.includes('"status":"completed"')) {
      const event = await reader.read();
      assert.equal(event.done, false);
      turnEvents += new TextDecoder().decode(event.value);
    }
    assert.match(turnEvents, /"type":"tool.status"/);
    assert.match(turnEvents, /"tool":"read_current_canvas"/);
    assert.match(turnEvents, /"status":"inProgress"/);
    assert.match(turnEvents, /"status":"completed"/);

    const log = (await readFile(requestLog, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    const thread = log.find((message) => message.method === "thread/start");
    assert.equal(thread.params.permissions, ":workspace");
    assert.deepEqual(thread.params.runtimeWorkspaceRoots, [canonicalFolder]);
    assert.equal(thread.params.approvalPolicy, "never");
    assert.equal(thread.params.config.mcp_servers.inherited.enabled, false);
    assert.equal(thread.params.config.mcp_servers.drawsy.enabled, true);
    assert.equal(
      thread.params.config.mcp_servers.drawsy.tools.apply_canvas_changes
        .approval_mode,
      "approve"
    );
    const turn = log.find((message) => message.method === "turn/start");
    assert.equal(turn.params.permissions, ":workspace");
    assert.equal(turn.params.sandboxPolicy, undefined);
    assert.deepEqual(turn.params.environments, []);
    const timeResponse = log.find((message) => message.id === "server-time");
    assert.equal(typeof timeResponse.result.currentTimeAt, "number");

    await reader.cancel();
    const closeResponse = await fetch(
      `${bridge.address}/v1/sessions/${session.id}`,
      {
        method: "DELETE",
        headers: { origin, authorization: `Bearer ${session.token}` },
      }
    );
    assert.equal(closeResponse.status, 204);
  } finally {
    await bridge.close();
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});
