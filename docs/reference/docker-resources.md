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
| `$OAS_VAULT_PATH` | `/workspace/vault/` | ro |
| `$OAS_VAULT_PATH/$OAS_VAULT_WRITE_DIR/` | `/workspace/vault/$OAS_VAULT_WRITE_DIR/` | rw |
| `$OAS_VAULT_PATH/.oas/` | `/workspace/vault/.oas/` | rw |
| `container/firewall-extras.txt` | `/etc/oas/firewall-extras.txt` | ro |

The read-only vault + rw write-dir is the core security invariant: the agent can read the whole vault but only write inside `$OAS_VAULT_WRITE_DIR` (unless the user grants `writeReviewed` or `writeVault` MCP tiers).

## Ports

| Purpose | Default host bind | Container connects via |
|---|---|---|
| ttyd (terminal) | `127.0.0.1:7681` (host port) | `7681` (in-container listen port) |
| MCP HTTP | `127.0.0.1:28080` (host-side, runs in the plugin) | `host.docker.internal:28080` |

`ttydBindAddress` can be set to `0.0.0.0` for LAN access (warning surfaced).

The MCP HTTP server runs **on the host** inside the Obsidian plugin — it is not a port published by the container. The container reaches it via `host.docker.internal`, which is wired to the host gateway by `docker-compose.yml`'s `extra_hosts`. Default `mcpBindAddress=127.0.0.1` keeps MCP host-only; set it to the docker bridge gateway IP (or `0.0.0.0`) to let the container reach it. The container's outbound firewall already pinholes the MCP port to `host.docker.internal`, see `explanation/security-model.md`.

## Environment variables

Injected into the container by the plugin at compose-up time (see `container/docker-compose.yml`):

- `OAS_VAULT_WRITE_DIR`, `OAS_MEMORY_FILE_NAME`
- `OAS_ALLOWED_PRIVATE_HOSTS`, `OAS_ALLOWED_DOMAINS`
- `OAS_MCP_TOKEN`, `OAS_MCP_PORT`, `OAS_HOST_IP`
- `OAS_TTYD_PORT`, `OAS_TTYD_DEBUG`, `OAS_SUDO_PASSWORD`, `TERM`
- `MEMORY_FILE_PATH` — the env var the [memory MCP server](https://github.com/modelcontextprotocol/servers/tree/main/src/memory) reads. Not prefixed (external contract).

Host-only (consumed by compose to shape the run, not visible inside the container):

- `OAS_VAULT_PATH` — bind-mount source for the vault.
- `OAS_TTYD_BIND` — host interface ttyd listens on (port mapping only).
- `OAS_CONTAINER_MEMORY`, `OAS_CONTAINER_CPUS` — resource limits.
- `OAS_IP_MASQ` — whether to enable NAT masquerading.
- `CLAUDE_UID`, `CLAUDE_GID` — build-time UID/GID for the `claude` user.

Use `verify.sh` from inside the container to see the full set of in-container values.

The full list with values (inside a running container) comes from `verify.sh`.
