#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { MAX_BODY_BYTES, parseCanvasOperations } from "./protocol.js";

const bridgeUrl = new URL(process.env.DRAWSY_BRIDGE_URL ?? "");
const sessionId = process.env.DRAWSY_SESSION_ID;
const sessionSecret = process.env.DRAWSY_SESSION_SECRET;

if (
  !["127.0.0.1", "::1", "localhost"].includes(bridgeUrl.hostname) ||
  !sessionId ||
  !sessionSecret
) {
  throw new Error("Drawsy MCP requires a loopback bridge and session scope.");
}

const callBridge = async (action: "read" | "apply", body: unknown = {}) => {
  const response = await fetch(
    new URL(
      `/internal/sessions/${encodeURIComponent(sessionId)}/canvas/${action}`,
      bridgeUrl
    ),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${sessionSecret}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(35_000),
    }
  );
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Drawsy canvas bridge failed (${response.status}).`);
  }
  return text;
};

const server = new McpServer({
  name: "Drawsy Current Canvas",
  version: "0.1.0",
});

server.registerTool(
  "read_current_canvas",
  {
    description:
      "Read the live Drawsy canvas attached to this chat. This tool is already scoped; it cannot read any other canvas.",
    inputSchema: z.object({}),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async () => ({
    content: [{ type: "text", text: await callBridge("read") }],
  })
);

server.registerTool(
  "apply_canvas_changes",
  {
    description:
      "Apply element upserts and deletions to the attached Drawsy canvas. Read the canvas first. Omitted elements remain unchanged.",
    inputSchema: z.object({
      upsertElements: z
        .array(z.record(z.string(), z.unknown()))
        .describe("New or updated Excalidraw elements as JSON objects."),
      deleteElementIds: z
        .array(z.string().min(1))
        .default([])
        .describe("IDs of existing elements to delete."),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ upsertElements, deleteElementIds }) => {
    if (
      Buffer.byteLength(JSON.stringify(upsertElements), "utf8") >
      MAX_BODY_BYTES
    ) {
      return {
        isError: true,
        content: [{ type: "text", text: "Canvas change exceeds 5 MiB." }],
      };
    }
    try {
      const operations = parseCanvasOperations({
        upsertElements,
        deleteElementIds,
      });
      await callBridge("apply", operations);
      return {
        content: [{ type: "text", text: "Current Drawsy canvas updated." }],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error ? error.message : "Invalid canvas change.",
          },
        ],
      };
    }
  }
);

await server.connect(new StdioServerTransport());
