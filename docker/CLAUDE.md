# CLAUDE.md — Agent Sandbox Container

## Environment

- **Docker Compose container** (Ubuntu 24.04) providing: Node 22 LTS (nvm), Python 3.12 (uv), Claude Code CLI, ttyd web terminal, tmux, ripgrep, fd, git-delta, atuin, fzf, jq, gh
- **ttyd** serves a web terminal on port 7681; the Obsidian plugin connects via HTTP/WebSocket
- **Independent sessions**: each WebSocket connection gets its own tmux session (`entrypoint.sh` creates `claude-$$` per connection)
- Vault bind-mounted **read-only** from host at `/workspace/vault/` (configured via `PKM_VAULT_PATH` in `.env`)
- Writable folder at `/workspace/vault/<PKM_WRITE_DIR>/` (default: `claude-workspace`) — the only place Claude can create or modify files inside the vault
- Changes to writable folder files are **immediately reflected on the host filesystem**

## Key Paths

| Path | Purpose |
|------|---------|
| `/workspace/` | Repository root (tooling and configuration) |
| `/workspace/vault/` | The Obsidian vault (read-only bind-mount) |
| `/workspace/vault/claude-workspace/` | Writable folder inside vault (configurable via `PKM_WRITE_DIR`) |
| `/workspace/Dockerfile` | Container image definition |
| `/workspace/docker-compose.yml` | Service configuration |
| `/workspace/scripts/` | Verification and firewall scripts |
| `/workspace/.claude/` | Claude Code project settings |

## Safety Constraints

- **Read-only vault**: the vault mount is read-only at the filesystem level. All writes must go to the writable folder (`/workspace/vault/claude-workspace/` by default)
- **Never delete** files without explicit user confirmation
- **Never modify** plugin binaries or vault config directories unless specifically asked
- **Prefer non-destructive operations**: create new files or append to existing rather than overwriting
- **Bulk operations**: always describe the scope and show a sample (3-5 files) before executing

## Vault-Specific Instructions

If present, each vault may carry its own `CLAUDE.md` with methodology, folder structure, tag taxonomy, link conventions, templates, and content workflows. Check `vault/CLAUDE.md` for vault-specific guidance.
