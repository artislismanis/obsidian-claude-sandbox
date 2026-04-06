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

Hub-and-spoke pattern. `main.ts` orchestrates leaf modules, plus a shared utility:

```
main.ts (Plugin entry, commands, lifecycle, context menu, firewall toggle)
├── settings.ts        — Settings interface + tabbed UI (General/Terminal/Advanced)
├── docker.ts          — DockerManager: WSL → docker compose commands + firewall
├── status-bar.ts      — StatusBarManager + FirewallStatusBar: state display
├── terminal-view.ts   — TerminalView: xterm.js + WebSocket to ttyd
├── ttyd-client.ts     — Pure functions: polling, auth token, URL building
├── workspace-readme.ts — README content for vault workspace folder
└── validation.ts      — Shared input validators (used by settings.ts and docker.ts)
```

No leaf module imports from another leaf — only `main.ts` wires them together. `validation.ts` is a shared utility (pure functions, no deps) that both `settings.ts` and `docker.ts` import. Exception: `settings.ts` imports the plugin type from `main.ts` for the settings tab constructor.

## Key patterns

- **Settings reactivity**: DockerManager and TerminalView accept `() => Settings` getter functions, not snapshots. Settings changes in the UI take effect immediately.
- **Generation counter**: TerminalView uses an incrementing counter to prevent race conditions when the view is rapidly closed/reopened. Each async operation checks if its generation is still current.
- **Shell escaping**: `buildWslCommand()` in docker.ts handles both bash single-quote escaping and cmd.exe double-quote escaping. Distro names are validated against `/^[\w][\w.-]*$/`.
- **ttyd protocol**: Binary WebSocket frames with ASCII command prefix. Commands are `'0'` (output/input), `'1'` (title/resize), `'2'` (preferences). Server and client use the same character codes. Connection requires `['tty']` subprotocol and a JSON handshake with `{AuthToken, columns, rows}` on open. Uses Obsidian's `requestUrl` for HTTP (bypasses CORS) and native WebSocket for the terminal stream.
- **Clipboard**: Auto-copies on text selection via `onSelectionChange`. Paste via `Ctrl+Shift+V`. Designed for `set -g mouse off` in tmux so mouse selection works without Shift.
- **Vault path injection**: Plugin auto-detects vault path via `FileSystemAdapter.getBasePath()`, converts Windows→WSL format via `windowsToWslPath()`, and passes `PKM_VAULT_PATH` env var to all docker compose commands. `start()` does stop+start to ensure fresh env vars.
- **Multiple terminals**: Each "Open Sandbox Terminal" creates an independent terminal tab with its own WebSocket connection and unique instance ID. Terminals open at the bottom via horizontal split.
- **Debounced save**: Settings saves are debounced to 500ms and flushed on plugin unload.

## Testing

Vitest test files (`npm run test`):
- `docker.test.ts` — `parseIsRunning()` static method, compose path validation
- `docker-command.test.ts` — `buildWslCommand()` escaping/validation, `buildLocalCommand()` double-quote escaping, `windowsToWslPath()` conversion, env var injection
- `status-bar.test.ts` — `StatusBarManager` state transitions and tooltips, `FirewallStatusBar` states/clicks/destroy
- `ttyd-client.test.ts` — Polling, auth token, URL construction (mocks `requestUrl`)
- `validation.test.ts` — All input validators (writeDir, privateHosts, memory, cpus, bindAddress) with octet/CIDR range checks, edge cases, DockerManager integration, busy guard

The Obsidian API-dependent modules (main.ts, settings.ts, terminal-view.ts) are not unit tested — they would require mocking Plugin, ItemView, WorkspaceLeaf, etc. Test pure logic by extracting it into testable modules (docker.ts, ttyd-client.ts, status-bar.ts).

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
