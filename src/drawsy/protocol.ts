export const MAX_BODY_BYTES = 5 * 1024 * 1024;
export const CANVAS_REQUEST_TIMEOUT_MS = 30_000;

export type JsonObject = Record<string, unknown>;

export type CanvasSnapshot = {
  canvasId: string;
  canvasName: string;
  elements: unknown[];
  appState?: JsonObject;
  files?: JsonObject;
};

export type CanvasOperations = {
  upsertElements: unknown[];
  deleteElementIds: string[];
};

export type AgentMetadata = {
  model: string;
  modelProvider: string;
  reasoningEffort: string | null;
  serviceTier: string | null;
};

export type AgentAccessMode = "workspace" | "readOnly";

export type AgentModelOption = {
  id: string;
  model: string;
  displayName: string;
  description: string;
  efforts: Array<{ id: string; description: string }>;
  defaultEffort: string;
  isDefault: boolean;
};

export type AgentSkillOption = {
  name: string;
  displayName: string;
  description: string;
  path: string;
};

export type AgentPluginOption = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  path: string;
};

export type AgentMcpOption = {
  name: string;
  toolCount: number;
  authStatus: string;
};

export type AgentControls = {
  accessMode: AgentAccessMode;
  internetEnabled: boolean;
  models: AgentModelOption[];
  skills: AgentSkillOption[];
  plugins: AgentPluginOption[];
  mcpServers: AgentMcpOption[];
};

export type AgentSettingsPatch = {
  model?: string;
  effort?: string;
  accessMode?: AgentAccessMode;
  internetEnabled?: boolean;
};

export type AgentPromptTag = {
  name: string;
  path: string;
};

export type BridgeEvent =
  | {
      type: "session.ready";
      data: { folderName: string; agent: AgentMetadata };
    }
  | { type: "assistant.delta"; data: { delta: string; itemId: string } }
  | { type: "assistant.final"; data: { text: string; itemId: string } }
  | { type: "turn.status"; data: { status: string; error?: string } }
  | {
      type: "tool.status";
      data: {
        itemId: string;
        tool: string;
        status: "inProgress" | "completed" | "failed" | "warning";
        message?: string;
        error?: string;
      };
    }
  | {
      type: "canvas.request";
      data: {
        requestId: string;
        action: "read" | "apply";
        canvasId: string;
        operations?: CanvasOperations;
      };
    }
  | { type: "error"; data: { message: string; code: string } };

export const isRecord = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const parseCanvasOperations = (value: unknown): CanvasOperations => {
  if (!isRecord(value)) {
    throw new Error("Canvas operations must be an object.");
  }
  const upsertElements = value.upsertElements ?? [];
  const deleteElementIds = value.deleteElementIds ?? [];
  if (!Array.isArray(upsertElements)) {
    throw new Error("upsertElements must be an array.");
  }
  if (
    !Array.isArray(deleteElementIds) ||
    deleteElementIds.some((id) => typeof id !== "string" || !id.trim())
  ) {
    throw new Error("deleteElementIds must contain non-empty strings.");
  }
  return { upsertElements, deleteElementIds };
};
