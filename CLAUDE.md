# CLAUDE.md — Agent Sandbox

Monorepo containing an Obsidian plugin and its paired Docker container for working with Obsidian vaults using AI coding agents.

## Quick reference

| Component | Path | Build/Check |
|-----------|------|-------------|
| Obsidian plugin | `plugin/` | `cd plugin && npm install && npm run check` |
| Docker container | `docker/` | `cd docker && docker compose build` |

## Structure

```
plugin/     Obsidian plugin (TypeScript, xterm.js, esbuild)
docker/     Docker container (Ubuntu 24.04, ttyd, tmux, Claude Code CLI)
docs/       Manual testing checklist
```

See `plugin/CLAUDE.md` for plugin architecture, patterns, and conventions.
See `docker/CLAUDE.md` for container environment and safety constraints.
See `docs/TESTING.md` for the full manual testing checklist.
