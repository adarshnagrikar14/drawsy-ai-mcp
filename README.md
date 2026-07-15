# Drawsy AI MCP

Local, surface-scoped MCP and Codex app-server bridge for Drawsy.

## Current scope

- Binds only to `127.0.0.1`.
- Uses Codex's `:workspace` permission profile with the selected folder as the only runtime workspace root.
- Keeps Codex's local execution environment enabled, so its built-in filesystem, patch, and shell tools can work naturally in that folder. Repository-native files such as `DRAW.md` require no separate filesystem MCP.
- Uses `approvalPolicy: "never"`: work inside the boundary proceeds without prompts; escape attempts are denied.
- Disables command network access, web search, apps, plugins, browser/computer tools, and inherited MCP servers.
- Injects a surface-aware Drawsy MCP into every Codex thread. Canvas and presentation chats receive only their current visual surface; a tagged Kanban turn can resolve the exact open board; tagged Jira remains read-only; neutral pages receive no product context unless the user explicitly adds a resource tag.
- Exposes only sources tagged in the current message. Each tagged turn receives exact, short-lived, read-only grants; provider credentials never enter Codex or the local MCP process.
- Treats `@kanban` and `@jira` as first-party Drawsy resources rather than external connector accounts. Their separate turn grant reaches only the Drawsy backend: Jira remains read-only, while Kanban mutations reuse its role-aware, revisioned, audited command service.
- Gives attached sources provider-native read tools for mail filters, calendar ranges, recent Drive and Notion content, Slack channels/history, and deep item reads. GitHub additionally supports selected-repository discovery, directory browsing, exact text-file reads, issues, and pull requests; it never clones or writes to repositories. `@aws` exposes enabled regions, live Resource Explorer inventory, and CloudFormation stack templates/resources through temporary cross-account sessions. `@read` and `@fireflies` discover and call the providers' official remote MCP tools through the same turn grant, with mutation tools filtered out by the backend.
- On canvas surfaces, exposes targeted reads, upserts, deletes, real raster-image insertion/replacement, and selection or region context capture. Existing elements are not deleted by omission, and canvas tools are absent from non-canvas sessions.
- Local images stay restricted to the selected folder. Image-generator outputs cross through a short-lived, session-only capability recorded from Codex itself; all images are MIME-sniffed, size-limited, content-hashed, and transferred with their Excalidraw file record instead of rendering as placeholders.
- Canvas context combines a rendered PNG (including visible annotations) with pristine selected raster sources. Context files live under the selected folder's ignored `.drawsy/context` directory and are removed when the session closes.
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

The focused tests cover the stdio MCP surface, loopback authentication, turn-scoped connector and first-party resource grants, inherited-tool suppression, folder permission profile, raster validation, image transfer, context materialization, path-escape rejection, and bridge session lifecycle. They use a fake Codex process and do not open a browser or contact the internet.

## Configuration

Copy `.env.example` values into the service environment when overriding defaults. `DRAWSY_CONNECTOR_BACKEND_URL` may be a loopback HTTP URL for local development or an HTTPS URL in production. Production packaging should start this bridge as a per-user local companion process; it must not be exposed on a LAN or public interface.

## Upstream

Forked from [excalidraw/excalidraw-mcp](https://github.com/excalidraw/excalidraw-mcp). Its Git history is retained and the source repository is configured as `upstream`.
