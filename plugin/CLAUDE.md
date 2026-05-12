# CLAUDE.md — Obsidian Plugin Development

## Build and test

```bash
npm install          # Install dependencies
npm run build        # Type-check + bundle (produces dist/main.js)
npm run check        # Lint + format check + type-check + tests (run this before committing)
npm run dev          # Watch mode for development
npm run test         # Run tests only
npm run lint:fix     # Auto-fix lint issues
npm run format       # Auto-format code
```

Pre-commit hooks run `lint-staged` (eslint --fix + prettier) on staged files automatically.

## Architecture

Hub-and-spoke. `main.ts` orchestrates leaf modules; a few small shared utilities cross-cut.

```
main.ts (Plugin entry, commands, lifecycle, context menu, firewall toggle)
├── settings.ts          — Settings interface + tabbed UI (General/Terminal/Advanced/MCP)
├── docker.ts            — DockerManager: WSL → docker compose commands + firewall
├── status-bar.ts        — StatusBarManager + FirewallStatusBar: state + composed tooltip
├── terminal-view.ts     — TerminalView: xterm.js + WebSocket to ttyd
├── ttyd-client.ts       — Pure functions: polling, auth token, URL building
├── analyze.ts           — AnalyzeManager: prompt-template runner for "Analyze in Sandbox"
├── session-ui.ts        — Session picker / cleanup modals
├── modals.ts            — confirmModal / inputModal helpers (reused across modules)
├── activity.ts          — ActivityUi (per-session prefix routing) + AgentOutputNotifier
├── diff-review-modal.ts — DiffReviewModal + BatchReviewModal for reviewed writes
├── mcp-server.ts        — ObsidianMcpServer: HTTP+SSE transport, auth, audit log
├── mcp-tools.ts         — buildTools(): all read/write/manage MCP tools
├── mcp-extensions.ts    — Extensions tier: Dataview / Templater / Tasks / Canvas / Periodic Notes
├── mcp-cache.ts         — VaultCache: graph + tag/property counts, invalidated on metadata `resolved`
├── permission-tiers.ts  — Tier metadata + reviewsRequired() / vaultWriteTiers() derivations
├── prompt-template.ts   — Tiny template-string interpolator used by analyze.ts
├── templater-adapter.ts — Templater plugin probe + folder-template resolution
├── obsidian-internals.ts — Centralised casts for unstable Obsidian internals
├── view-types.ts        — VIEW_TYPE_TERMINAL constant (shared between activity.ts and terminal-view.ts to avoid a cycle)
├── validation.ts        — Shared input validators (used by settings.ts, docker.ts, mcp-*.ts)
└── logger.ts            — Levelled logger + errMsg() helper
```

`main.ts` wires the leaves together. Most leaves are independent, but a few have intentional in-tree dependencies — e.g. `mcp-tools.ts` re-exports `gateVaultWrite` to `mcp-extensions.ts`, `activity.ts` uses `view-types.ts` to talk about terminal leaves without importing `terminal-view.ts`, and several MCP modules share `obsidian-internals.ts`. `validation.ts` and `logger.ts` are leaf-of-leaves, used everywhere.

## Key patterns

- **Settings reactivity**: DockerManager and TerminalView accept `() => Settings` getter functions, not snapshots. Settings changes in the UI take effect immediately.
- **Generation counter**: TerminalView uses an incrementing counter to prevent race conditions when the view is rapidly closed/reopened. Each async operation checks if its generation is still current.
- **Shell escaping**: `buildWslCommand()` in docker.ts handles both bash single-quote escaping and cmd.exe double-quote escaping. Distro names are validated against `/^[\w][\w.-]*$/`.
- **ttyd protocol**: Binary WebSocket frames with ASCII command prefix. Commands are `'0'` (output/input), `'1'` (title/resize), `'2'` (preferences). Server and client use the same character codes. Connection requires `['tty']` subprotocol and a JSON handshake with `{columns, rows}` on open. Uses Obsidian's `requestUrl` for HTTP polling (bypasses CORS) and native WebSocket for the terminal stream. No authentication — security relies on the bind address (127.0.0.1 by default).
- **Clipboard**: Auto-copies on text selection via `onSelectionChange`. Paste via `Ctrl+Shift+V`.
- **Vault path injection**: Plugin auto-detects vault path via `FileSystemAdapter.getBasePath()`, converts Windows→WSL format via `windowsToWslPath()`, and passes `OAS_VAULT_PATH` env var to all docker compose commands.
- **Container lifecycle**: `DockerManager.start()` runs `docker compose up -d` only — compose's own idempotency reconciles config changes (reuses the running container when env vars match, recreates when they differ). `restart()` is the explicit `down` + `up -d` escape hatch for forcing a clean recreate. `stop()` and `stopDetached()` both run `docker compose down`. `main.ts` gates terminal-leaf detachment on `DockerManager.parseIsRunning()` at layout-ready so persisted terminal tabs can re-attach to a still-running container after Obsidian reopens.
- **Multiple terminals**: Each "Open Sandbox Terminal" creates an independent terminal tab with its own WebSocket connection and unique instance ID. Terminals open at the bottom via horizontal split.
- **Debounced save**: Settings saves are debounced to 500ms and flushed on plugin unload.

## Testing

Three automated layers — see `docs/testing.md` for full setup, prerequisites, and coverage.

| Layer | Command | Time | Dependencies |
|-------|---------|------|--------------|
| Unit (`src/__tests__/`) | `npm run test` | ~1.5s | none |
| Integration (`test/integration/`) | `npm run test:integration` | ~30s | Docker + built `oas-sandbox:latest` |
| E2E (`test/e2e/specs/`) | `npm run test:e2e` / `test:e2e:headless` | ~25s | Obsidian (auto-downloaded); display or xvfb |

Vitest unit test files (`npm run test`) live in `src/__tests__/`:
- `docker.test.ts` / `docker-command.test.ts` — DockerManager status parsing + WSL/local command building, escaping, env-var injection
- `status-bar.test.ts` — StatusBarManager state transitions, tooltip composition, FirewallStatusBar
- `ttyd-client.test.ts` — Polling and URL construction (mocks `requestUrl`)
- `validation.test.ts` — All input validators
- `settings-tiers.test.ts` — Tier-toggle wiring through settings into the MCP server config
- `mcp-server.test.ts` — Transport/auth/rate-limit/timeout integration; `mcp-symlink.test.ts` — symlink-traversal guard
- `mcp-tool-handlers.test.ts` — Tool registration + per-handler behaviour
- `mcp-review.test.ts` / `mcp-batch-review.test.ts` — Review-gating for writeReviewed and batch flows
- `mcp-activity.test.ts` — `agent_status_set` and onActivity routing
- `mcp-extensions.test.ts` — Dataview / Templater / Tasks / Canvas / Periodic Notes tools
- `mcp-cache.test.ts` — VaultCache invalidation on `resolved`
- `activity.test.ts` — ActivityUi attention propagation; AgentOutputNotifier debounce
- `analyze.test.ts` / `prompt-templates.test.ts` — AnalyzeManager + the template interpolator
- `diff-review-modal.test.ts` — Diff modal approval/rejection flow
- `fixtures.ts` — Shared mock app / TFile builders (no tests of its own)

Integration tests share one `oas-test-sandbox` container via `globalSetup.ts`. The container is isolated from your live `oas-sandbox` via the `oas-test` compose project prefix. Claude-Code subsuite seeds auth from the live `oas_oas-claude-config` volume when present (see `docs/testing.md` for setup), otherwise skips.

E2E tests use `wdio-obsidian-service`. Each spec launches a fresh Obsidian against an ephemeral copy of `test/e2e/vaults/simple/`.

The Obsidian API-dependent modules (main.ts, settings.ts, terminal-view.ts) are not unit tested — they would require mocking Plugin, ItemView, WorkspaceLeaf, etc. Instead they're exercised end-to-end by the e2e suite. Keep pure logic in testable modules (docker.ts, ttyd-client.ts, status-bar.ts, validation.ts, mcp-*.ts).

## Conventions

- TypeScript strict mode enabled
- ESLint with typescript-eslint (flat config)
- Prettier: tabs, semicolons, double quotes, trailing commas, 100 char width
- Type-only imports enforced: `import type { Foo }` not `import { Foo }`
- No `console.log` in production code (ESLint warns)
- Obsidian API externalized in esbuild — never bundled

## Key files for common tasks

| Task | Files |
|------|-------|
| Add a new setting | `src/settings.ts` (interface + default + UI) |
| Add a new command | `src/main.ts` (register in `onload()`) |
| Change Docker command behavior | `src/docker.ts` |
| Change terminal connection logic | `src/ttyd-client.ts` + `src/terminal-view.ts` |
| Change status bar display | `src/status-bar.ts` |
| Add a test | `src/__tests__/` (follow existing patterns) |

## Deployment

`npm run build` produces a ready-to-install `dist/` folder containing `main.js` (minified, all dependencies bundled), `manifest.json`, and `styles.css`. Copy the contents of `dist/` to the vault's `.obsidian/plugins/obsidian-agent-sandbox/` directory. The `styles.css` includes the full xterm.js base styles — Obsidian loads it automatically.
