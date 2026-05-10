# Reference: Docker resources

All user-visible resources use the `oas-` prefix so they're easy to inspect and clean up.

## Image

| Resource | Name |
|---|---|
| Image | `oas-sandbox:latest` |
| Build context | `container/` |

Built via `cd container && docker compose build`.

## Container

| Resource | Name |
|---|---|
| Container | `oas-sandbox` |
| Compose project | `oas` |
| Compose service | `sandbox` |

Inspect: `docker ps | grep oas-`.

## Volumes

| Volume | Mount target inside container | Purpose |
|---|---|---|
| `oas-claude-config` | `/home/claude/.claude` | Claude Code auth, session history, personal config. Survives container rebuilds. |
| `oas-shell-history` | `/home/claude/.shell-history` | Bash/zsh history. Survives container rebuilds. |

Inspect: `docker volume ls | grep oas-`.

## Bind mounts

| Host path | Container path | Mode |
|---|---|---|
| `workspace/` | `/workspace/` | rw |
| `$PKM_VAULT_PATH` | `/workspace/vault/` | ro |
| `$PKM_VAULT_PATH/$PKM_WRITE_DIR/` | `/workspace/vault/$PKM_WRITE_DIR/` | rw |
| `$PKM_VAULT_PATH/.oas/` | `/workspace/vault/.oas/` | rw |
| `container/firewall-extras.txt` | `/etc/oas/firewall-extras.txt` | ro |

The read-only vault + rw write-dir is the core security invariant: the agent can read the whole vault but only write inside `$PKM_WRITE_DIR` (unless the user grants `writeReviewed` or `writeVault` MCP tiers).

## Ports

| Purpose | Default host bind | Container connects via |
|---|---|---|
| ttyd (terminal) | `127.0.0.1:7681` (host port) | `7681` (in-container listen port) |
| MCP HTTP | `127.0.0.1:28080` (host-side, runs in the plugin) | `host.docker.internal:28080` |

`ttydBindAddress` can be set to `0.0.0.0` for LAN access (warning surfaced).

The MCP HTTP server runs **on the host** inside the Obsidian plugin — it is not a port published by the container. The container reaches it via `host.docker.internal`, which is wired to the host gateway by `docker-compose.yml`'s `extra_hosts`. Default `mcpBindAddress=127.0.0.1` keeps MCP host-only; set it to the docker bridge gateway IP (or `0.0.0.0`) to let the container reach it. The container's outbound firewall already pinholes the MCP port to `host.docker.internal`, see `explanation/security-model.md`.

## Environment variables

Injected into the container by the plugin at compose-up time (see `container/docker-compose.yml`):

- `PKM_VAULT_PATH`, `PKM_WRITE_DIR`, `MEMORY_FILE_NAME`, `MEMORY_FILE_PATH`
- `ALLOWED_PRIVATE_HOSTS`, `OAS_ALLOWED_DOMAINS`
- `OAS_MCP_TOKEN`, `OAS_MCP_PORT`, `OAS_HOST_IP`
- `TTYD_PORT`, `SUDO_PASSWORD`

The full list with values (inside a running container) comes from `verify.sh`.
