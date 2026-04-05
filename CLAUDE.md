# CLAUDE.md — Development Guide

This file provides context for Claude Code when working on the pkm-claude-terminal Obsidian plugin.

## What this project is

An Obsidian desktop plugin (TypeScript) that manages a Docker-based Claude Code environment. It executes Docker Compose commands via WSL, and embeds a terminal (xterm.js + ttyd WebSocket) inside Obsidian.

## Build and test

```bash
npm install          # Install dependencies
npm run build        # Type-check + bundle (produces main.js)
npm run check        # Lint + format check + type-check + tests (run this before committing)
npm run dev          # Watch mode for development
npm run test         # Run tests only
npm run lint:fix     # Auto-fix lint issues
npm run format       # Auto-format code
```

Pre-commit hooks run `lint-staged` (eslint --fix + prettier) on staged files automatically.

## Architecture

Hub-and-spoke pattern. `main.ts` orchestrates 5 leaf modules:

```
main.ts (Plugin entry, commands, lifecycle)
├── settings.ts      — Settings interface + UI tab (7 fields)
├── docker.ts        — DockerManager: WSL → docker compose commands
├── status-bar.ts    — StatusBarManager: container state display
├── terminal-view.ts — TerminalView: xterm.js + WebSocket to ttyd
└── ttyd-client.ts   — Pure functions: polling, auth token, URL building
```

No leaf module imports from another leaf — only `main.ts` wires them together. Exception: `settings.ts` imports the plugin type from `main.ts` for the settings tab constructor.

## Key patterns

- **Settings reactivity**: DockerManager and TerminalView accept `() => Settings` getter functions, not snapshots. Settings changes in the UI take effect immediately.
- **Generation counter**: TerminalView uses an incrementing counter to prevent race conditions when the view is rapidly closed/reopened. Each async operation checks if its generation is still current.
- **Shell escaping**: `buildWslCommand()` in docker.ts handles both bash single-quote escaping and cmd.exe double-quote escaping. Distro names are validated against `/^[\w][\w.-]*$/`.
- **ttyd protocol**: Binary WebSocket frames with ASCII command prefix. Commands are `'0'` (output/input), `'1'` (title/resize), `'2'` (preferences). Server and client use the same character codes. Connection requires `['tty']` subprotocol and a JSON handshake with `{AuthToken, columns, rows}` on open. Uses Obsidian's `requestUrl` for HTTP (bypasses CORS) and native WebSocket for the terminal stream.
- **Clipboard**: Auto-copies on text selection via `onSelectionChange`. Paste via `Ctrl+Shift+V`. Designed for `set -g mouse off` in tmux so mouse selection works without Shift.
- **Vault path injection**: Plugin auto-detects vault path via `FileSystemAdapter.getBasePath()`, converts Windows→WSL format via `windowsToWslPath()`, and passes `PKM_VAULT_PATH` env var to all docker compose commands. `start()` does stop+start to ensure fresh env vars.
- **Debounced save**: Settings saves are debounced to 500ms and flushed on plugin unload.

## Testing

42 tests across 4 test files using Vitest:
- `docker.test.ts` — `parseIsRunning()` static method
- `docker-command.test.ts` — `buildWslCommand()` escaping/validation, `windowsToWslPath()` conversion, env var injection
- `status-bar.test.ts` — `StatusBarManager` state transitions
- `ttyd-client.test.ts` — Polling, auth token, URL construction (mocks `requestUrl`)

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

`npm run build` produces a ready-to-install `dist/` folder containing `main.js` (minified, all dependencies bundled), `manifest.json`, and `styles.css`. Copy the contents of `dist/` to the vault's `.obsidian/plugins/pkm-claude-terminal/` directory. The `styles.css` includes the full xterm.js base styles — Obsidian loads it automatically.
