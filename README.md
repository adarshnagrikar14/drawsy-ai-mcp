# Drawsy AI MCP

Local, canvas-scoped MCP and Codex app-server bridge for Drawsy.

## Current scope

- Binds only to `127.0.0.1`.
- Uses Codex's `:workspace` permission profile with the selected folder as the only runtime workspace root.
- Uses `approvalPolicy: "never"`: work inside the boundary proceeds without prompts; escape attempts are denied.
- Disables command network access, web search, apps, plugins, browser/computer tools, and inherited MCP servers.
- Injects the Drawsy MCP into every Codex thread. The model never receives a canvas ID and cannot select another canvas.
- Exposes targeted canvas reads, upserts, and deletes. Existing elements are not deleted by omission.
- Uses the user's existing local Codex authentication. Drawsy has no login flow and never reads or stores credentials.

## Run locally

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm run build:drawsy
corepack pnpm run start:drawsy
```

The bridge listens at `http://127.0.0.1:3031`. Drawsy's development app is already configured to use it.

## Verify

```bash
corepack pnpm run test:drawsy
```

The focused tests cover the stdio MCP surface, loopback authentication, inherited-tool suppression, folder permission profile, and bridge session lifecycle. They use a fake Codex process and do not open a browser or contact the internet.

## Configuration

Copy `.env.example` values into the service environment when overriding defaults. Production packaging should start this bridge as a per-user local companion process; it must not be exposed on a LAN or public interface.

## Upstream

Forked from [excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp). Its Git history is retained and the source repository is configured as `upstream`.
