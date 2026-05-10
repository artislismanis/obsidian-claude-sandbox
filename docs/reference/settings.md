# Reference: settings

All plugin settings live in **Obsidian → Settings → Agent Sandbox**. Settings flagged *(requires restart)* only take effect after the container is restarted.

## General

| Setting | Default | Notes |
|---|---|---|
| Docker mode | `WSL (Windows)` | `wsl` routes through `wsl.exe`; `local` runs `docker compose` directly. |
| Compose file path | `""` | Absolute path to the directory containing `docker-compose.yml`. Validated on input. |
| WSL distro name | `Ubuntu` | Only in WSL mode. Must match `wsl -l -v`. |
| Vault write directory | `agent-workspace` | Relative path inside the vault where the agent can write. Mounted rw inside the container. |
| Memory file name | `memory.json` | File in `.oas/` used as the agent's persistent memory. |
| Auto-start container | off | Start the container automatically when Obsidian opens. |
| Auto-stop on exit | off | Stop the container on Obsidian exit (via `quit` hook). |
| Notify on agent output | `new` | `new` / `new_or_modified` / `off` — shows an Obsidian Notice when files appear under the write directory. Debounced + rate-limited. |

## Terminal

| Setting | Default | Notes |
|---|---|---|
| ttyd port | `7681` | Host port forwarded to ttyd inside the container. *(requires restart)* |
| Bind address | `127.0.0.1` | `127.0.0.1` (local only) or `0.0.0.0` (LAN) — the latter triggers a warning. *(requires restart)* |
| Theme | `obsidian` | `obsidian` follows Obsidian's theme; `dark`/`light` override. |
| Font | `""` | Empty = Obsidian's monospace. |
| Font size | `14` | 8–32. |
| Scrollback | `10000` | 100–100,000 lines. |
| Auto-copy on selection | on | Disable if selecting text for reading surprises you by overwriting the clipboard. |

## Advanced

| Setting | Default | Notes |
|---|---|---|
| Container memory | `8G` | Docker resource limit. Format: `<n>[KMGT]`. *(requires restart)* |
| Container CPUs | `4` | Decimal allowed (e.g. `2.5`). *(requires restart)* |
| Auto-enable firewall on start | off | Invokes `init-firewall.sh` after `docker compose up -d`. |
| Allowed private hosts | `""` | Comma-separated IPs/CIDRs allowed through the firewall (e.g. `192.168.1.100, 10.0.0.0/8`). *(requires restart)* |
| Additional firewall domains | `""` | Comma-separated domain names. Surfaces with `[plugin]` tag in `--list-sources`. *(requires restart)* |
| Sudo password | `""` | For the narrow apt-get/apt sudoers entry inside the container. Empty (default) = sudo disabled — set explicitly to enable test-installs in interactive sessions. *(requires restart)* |

## MCP

| Setting | Default | Notes |
|---|---|---|
| MCP enabled | on | Starts the HTTP server; toggles the always-on `read` / `writeScoped` / `agent` tiers on/off globally. |
| MCP port | `28080` | Host port for the MCP HTTP endpoint. *(requires restart)* |
| MCP bind address | `127.0.0.1` | IP the MCP HTTP server binds to. Default is host-only — set to the docker bridge gateway (e.g. `172.17.0.1`) or `0.0.0.0` to let the sandbox container reach MCP via `host.docker.internal`. `0.0.0.0` exposes MCP to your LAN; bearer-token auth is the only line of defense. *(MCP restart)* |
| Auth token | auto-generated | Regenerable via button. Passed to the container as `OAS_MCP_TOKEN`. *(requires restart)* |
| Vault-wide writes | `None` | Dropdown — `None` (scoped only), `Reviewed` (writeReviewed tier; diff modal per change), or `Full` (writeVault tier; no review). Mutually exclusive. |
| Escalation tiers | all off | Toggles for `navigate`, `manage`, `extensions`. See `explanation/security-model.md`. |
| Allowed paths / Blocked paths | `""` | Per-path allowlist/blocklist applied inside MCP tools (not the firewall). |

Claude can call the always-on `mcp_capabilities` tool to introspect which tiers are enabled and the current write directory — use this when debugging unexpected "write rejected" errors rather than guessing.

Tool calls run under a configurable server-side handler timeout (default 10 s, settable via "Tool timeout" in MCP settings; review-modal prompts use a separate "Review timeout" defaulting to 180 s). A hung handler returns a structured error rather than stalling the proxy's request queue.

## Storage

Settings persist to `<vault>/.obsidian/plugins/obsidian-agent-sandbox/data.json` via Obsidian's standard plugin-data API.
