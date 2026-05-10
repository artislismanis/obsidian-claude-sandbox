# Reference: settings

All plugin settings live in **Obsidian → Settings → Agent Sandbox**. Settings flagged *(requires restart)* only take effect after the container is restarted.

UI labels in the table below match exactly what the plugin renders, so a setting reference here can be located in-app by searching for its label.

## General

| Setting (UI label) | Default | Notes |
|---|---|---|
| Docker mode | `WSL (Windows)` | `wsl` routes through `wsl.exe`; `local` runs `docker compose` directly. |
| Docker Compose path | `""` | Absolute path to the directory containing `docker-compose.yml`. Validated on input. |
| WSL distribution | `Ubuntu` | Only in WSL mode. Must match `wsl -l -v`. |
| Vault write directory | `agent-workspace` | Relative path inside the vault where the agent can write. Mounted rw inside the container. Empty = scoped writes are disabled (fail-closed). |
| Memory file name | `memory.json` | File in `.oas/` used as the agent's persistent memory. |
| Auto-start on load | off | Start the container automatically when Obsidian opens. |
| Auto-stop on exit | off | Stop the container on Obsidian exit (via `quit` hook). |
| Notify on agent output | `new` | `new` / `new_or_modified` / `off` — shows an Obsidian Notice when files appear under the write directory. Debounced + rate-limited. |

## Terminal

| Setting (UI label) | Default | Notes |
|---|---|---|
| Port | `7681` | Host port forwarded to ttyd inside the container. *(requires restart)* |
| Bind address | `127.0.0.1` | `127.0.0.1` (local only) or `0.0.0.0` (LAN) — the latter triggers a warning. *(requires restart)* |
| Terminal theme | `obsidian` | `obsidian` follows Obsidian's theme; `dark`/`light` override. |
| Terminal font | `""` | Empty = Obsidian's monospace. |
| Font size | `14` | 8–32. |
| Scrollback | `10000` | 100–100,000 lines. |
| Auto-copy on selection | on | Disable if selecting text for reading surprises you by overwriting the clipboard. |

## Advanced

| Setting (UI label) | Default | Notes |
|---|---|---|
| Memory limit | `8G` | Docker resource limit. Format: `<n>[KMGT]`. *(requires restart)* |
| CPU limit | `4` | Decimal allowed (e.g. `2.5`). *(requires restart)* |
| Auto-enable firewall on start | off | Invokes `init-firewall.sh` after `docker compose up -d`. |
| Allowed private hosts | `""` | Comma-separated IPs/CIDRs allowed through the firewall (e.g. `192.168.1.100, 10.0.0.0/8`). The Docker bridge gateway is always allowed regardless of this setting (otherwise the container couldn't reach `host.docker.internal`). *(requires restart)* |
| Additional firewall domains | `""` | Comma-separated domain names. Surfaces with `[plugin]` tag in `--list-sources`. *(requires restart)* |
| Sudo password | `""` | For the narrow apt-get/apt sudoers entry inside the container. Empty (default) = sudo disabled — set explicitly to enable test-installs in interactive sessions. When set, this plugin setting overrides the `SUDO_PASSWORD` value in `container/.env` (the plugin passes its setting through as `SUDO_PASSWORD` on `docker compose up`). *(requires restart)* |
| Log level | `info` | Levelled console logging from the plugin (`error` / `warn` / `info` / `debug`). Higher = more chatter in the developer console. |

## MCP

| Setting (UI label) | Default | Notes |
|---|---|---|
| Enable MCP server | on | Starts the HTTP server. The always-on tiers (`read`, `writeScoped`, `agent`) become available once the server is running — they're not individually toggleable. |
| MCP port | `28080` | Host port for the MCP HTTP endpoint. *(requires restart)* |
| MCP bind address | `127.0.0.1` | IP the MCP HTTP server binds to. Default is host-only — set to the docker bridge gateway (e.g. `172.17.0.1`) or `0.0.0.0` to let the sandbox container reach MCP via `host.docker.internal`. `0.0.0.0` exposes MCP to your LAN; bearer-token auth is the only line of defense. *(requires MCP restart)* |
| Auth token | auto-generated | Regenerable via button. Passed to the container as `OAS_MCP_TOKEN`. *(requires restart)* |
| Vault-wide writes | `None` | Dropdown — `None` (scoped only), `Reviewed` (writeReviewed tier; diff modal per change), or `Full` (writeVault tier; no review). Mutually exclusive. |
| Escalation tiers | all off | Toggles for `navigate`, `manage`, `extensions`. See `explanation/security-model.md`. |
| Allowed paths / Blocked paths | `""` | Per-path allowlist/blocklist applied inside MCP tools (not the firewall). |
| Tool timeout (seconds) | `10` | Server-side handler timeout for individual tool calls. A hung handler returns a structured error instead of stalling the proxy's request queue. |
| Review timeout (seconds) | `180` | How long the diff/batch review modal waits for human approval before auto-rejecting. Larger than tool timeout because human latency dominates. |

Claude can call the always-on `mcp_capabilities` tool to introspect which tiers are enabled and the current write directory — use this when debugging unexpected "write rejected" errors rather than guessing.

Tool calls run under the configurable handler / review timeouts shown in the MCP table above.

## Storage

Settings persist to `<vault>/.obsidian/plugins/obsidian-agent-sandbox/data.json` via Obsidian's standard plugin-data API.
