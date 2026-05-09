# CLAUDE.md — Agent Sandbox

Monorepo containing an Obsidian plugin, its paired containerized sandbox for working with Obsidian vaults using AI coding agents, and Claude's configurable workspace.

## Quick reference

| Component | Path | Build/Check |
|-----------|------|-------------|
| Obsidian plugin | `plugin/` | `cd plugin && npm install && npm run check` |
| Sandbox container (infra) | `container/` | `cd container && docker compose build` |
| Claude's workspace | `workspace/` | Edited by Claude inside the sandbox; committed from host |

## Structure

```
plugin/     Obsidian plugin (TypeScript, xterm.js, esbuild)
container/  Infra — Dockerfile, compose, entrypoint, scripts. NOT mounted inside the running container.
workspace/  Claude's domain — .claude/, .mcp.json, skills, agents, commands. Mounted rw at /workspace/ inside.
docs/       Host-facing docs (architecture, testing checklist)
```

The split between `container/` and `workspace/` is the key architectural decision — infra vs Claude's domain. See `docs/explanation/architecture.md` for the full rationale and the three-tier extensibility model.

See `plugin/CLAUDE.md` for plugin architecture, patterns, and conventions.
See `container/CLAUDE.md` for infra rules (Dockerfile, compose, firewall).
See `workspace/CLAUDE.md` for the rules Claude follows inside the sandbox.
See `docs/explanation/architecture.md` for the architectural rationale.
See `docs/testing.md` for the test automation guide (three layers — unit, integration, e2e) and the short manual checklist.

## Naming convention

All user-visible Docker resources use an `oas-` prefix (Obsidian Agent Sandbox):
- Image: `oas-sandbox:latest`
- Container: `oas-sandbox`
- Volumes: `oas-claude-config`, `oas-shell-history`
- Compose project: `oas`

Quick check: `docker ps | grep oas-` and `docker volume ls | grep oas-`.
