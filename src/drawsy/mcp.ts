#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod/v4";

import { MAX_BODY_BYTES, parseCanvasOperations } from "./protocol.js";

const bridgeUrl = new URL(process.env.DRAWSY_BRIDGE_URL ?? "");
const sessionId = process.env.DRAWSY_SESSION_ID;
const sessionSecret = process.env.DRAWSY_SESSION_SECRET;
const workspaceRoot = process.env.DRAWSY_WORKSPACE_ROOT;

if (
  !["127.0.0.1", "::1", "localhost"].includes(bridgeUrl.hostname) ||
  !sessionId ||
  !sessionSecret ||
  !workspaceRoot
) {
  throw new Error(
    "Drawsy MCP requires a loopback bridge, session scope, and workspace root."
  );
}

const callBridge = async (
  action: "read" | "apply" | "image" | "context" | "replace-image",
  body: unknown = {}
) => {
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
    let message = `Drawsy canvas bridge failed (${response.status}).`;
    try {
      const payload = JSON.parse(text) as {
        error?: { message?: unknown };
      };
      if (typeof payload.error?.message === "string") {
        message = payload.error.message;
      }
    } catch {
      // Keep the status-only error for malformed bridge responses.
    }
    throw new Error(message);
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
      Buffer.byteLength(JSON.stringify(upsertElements), "utf8") > MAX_BODY_BYTES
    ) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text: `Canvas change exceeds ${
              MAX_BODY_BYTES / (1024 * 1024)
            } MiB.`,
          },
        ],
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

server.registerTool(
  "add_image_from_file",
  {
    description:
      "Add a real PNG, JPEG, GIF, or WebP to the attached Drawsy canvas. Local files must be inside the selected folder. After image generation, pass the exact saved path returned by the generator; Drawsy securely recognizes that session-owned output. If no saved path was returned, use imagegen://latest. The image is fitted proportionally within the requested bounds.",
    inputSchema: z.object({
      sourcePath: z
        .string()
        .trim()
        .min(1)
        .describe(
          "Absolute or workspace-relative path to the generated image."
        ),
      x: z.number().finite().min(-1_000_000).max(1_000_000),
      y: z.number().finite().min(-1_000_000).max(1_000_000),
      maxWidth: z.number().finite().positive().max(100_000),
      maxHeight: z.number().finite().positive().max(100_000).optional(),
      elementId: z.string().trim().min(1).max(128).optional(),
      frameId: z.string().trim().min(1).max(128).nullable().optional(),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ sourcePath, x, y, maxWidth, maxHeight, elementId, frameId }) => {
    try {
      const result = JSON.parse(
        await callBridge("image", {
          sourcePath,
          x,
          y,
          maxWidth,
          maxHeight,
          elementId,
          frameId,
        })
      ) as { elementId: string; width: number; height: number };
      return {
        content: [
          {
            type: "text",
            text: `Image added to the current canvas as ${result.elementId} (${result.width} × ${result.height}).`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message
                : "Image could not be added.",
          },
        ],
      };
    }
  }
);

server.registerTool(
  "capture_canvas_context",
  {
    description:
      "Capture a precise visual region of the current Drawsy canvas as a local PNG, with pristine source-image paths when requested. Use elementIds for a semantic selection or bounds for an exact area. The returned files are session-scoped inside the selected folder and can be inspected or passed to image editing.",
    inputSchema: z
      .object({
        elementIds: z
          .array(z.string().trim().min(1).max(128))
          .min(1)
          .max(250)
          .optional(),
        bounds: z
          .object({
            x: z.number().finite().min(-1_000_000).max(1_000_000),
            y: z.number().finite().min(-1_000_000).max(1_000_000),
            width: z.number().finite().positive().max(2_000_000),
            height: z.number().finite().positive().max(2_000_000),
          })
          .optional(),
        includeSourceImages: z.boolean().default(true),
        maxDimension: z.number().int().min(256).max(4096).default(2048),
      })
      .refine((value) => Boolean(value.elementIds) !== Boolean(value.bounds), {
        message: "Choose either elementIds or bounds.",
      }),
    annotations: { readOnlyHint: true, destructiveHint: false },
  },
  async (input) => {
    try {
      const context = JSON.parse(await callBridge("context", input)) as {
        id: string;
        previewPath: string;
        elementIds: string[];
        sourceImages: Array<{ id: string; path: string }>;
      };
      const sources = context.sourceImages.length
        ? ` Pristine source images: ${context.sourceImages
            .map((source) => `${source.id}=${source.path}`)
            .join(", ")}.`
        : "";
      return {
        content: [
          {
            type: "text",
            text: `Canvas context ${context.id} captured at ${context.previewPath}.${sources}`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message
                : "Canvas context could not be captured.",
          },
        ],
      };
    }
  }
);

server.registerTool(
  "replace_canvas_image_from_file",
  {
    description:
      "Replace the raster content of an existing image element on the current canvas while preserving its geometry, frame, ordering, bindings, and element identity. Use the exact image element id and a selected-folder path or recognized image-generation output path.",
    inputSchema: z.object({
      targetElementId: z.string().trim().min(1).max(128),
      sourcePath: z.string().trim().min(1),
    }),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  async ({ targetElementId, sourcePath }) => {
    try {
      await callBridge("replace-image", { targetElementId, sourcePath });
      return {
        content: [
          {
            type: "text",
            text: `Canvas image ${targetElementId} replaced while preserving its placement.`,
          },
        ],
      };
    } catch (error) {
      return {
        isError: true,
        content: [
          {
            type: "text",
            text:
              error instanceof Error
                ? error.message
                : "Canvas image could not be replaced.",
          },
        ],
      };
    }
  }
);

await server.connect(new StdioServerTransport());
