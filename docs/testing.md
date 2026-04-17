# Manual Testing Checklist

Testing the Agent Sandbox container and the Obsidian plugin together.

## Docker environments

The plugin supports two Docker modes, each exercising a different code path:

| Mode | When to use | Plugin setting |
|------|-------------|----------------|
| **WSL** | Windows host with Docker Engine installed *inside* WSL2 (no Docker Desktop) | Docker mode = WSL |
| **Local** | Docker Engine available directly on the host — Linux, Mac, or Windows with Rancher Desktop / Docker Desktop | Docker mode = Local |

Run the full checklist at least once per mode you care about. Sections 14 (Host Docker / Rancher Desktop) and 15 (WSL specifics) cover the mode-specific edges.

## Prerequisites (common)

- [ ] An Obsidian vault with some test files
- [ ] Claude Code subscription authenticated
- [ ] Plugin built: `cd plugin && npm install && npm run build`
- [ ] Plugin installed: copy contents of `plugin/dist/` to vault's `.obsidian/plugins/obsidian-agent-sandbox/`
- [ ] Plugin enabled in Obsidian Settings > Community Plugins

### WSL-mode prerequisites

- [ ] WSL2 with Docker Engine installed inside the distro (not Docker Desktop on Windows)
- [ ] WSL2 mirrored networking enabled (`networkingMode=mirrored` in `.wslconfig`)

### Host-Docker / Rancher Desktop prerequisites

- [ ] Rancher Desktop (or Docker Desktop / native Docker) running and reachable via `docker ps` from the host shell
- [ ] `dockerd` provides the Docker API to Obsidian via the default socket for the OS (`/var/run/docker.sock` on Linux/Mac, named pipe on Windows)
- [ ] Host shell has `docker compose` on PATH (Rancher Desktop ships compose v2 by default)

---

## 1. Container Build and Start

```bash
cd container
cp .env.example .env
# Edit .env — set PKM_VAULT_PATH to your vault (SUDO_PASSWORD defaults to "sandbox")
docker compose build
docker compose up -d
```

- [ ] `docker compose build` completes without errors
- [ ] Built image is tagged `oas-sandbox:latest` (`docker images | grep oas-sandbox`)
- [ ] `docker compose up -d` starts successfully
- [ ] `docker compose ps` shows `oas-sandbox` as **healthy**

## 2. Verify Script

```bash
docker compose exec sandbox verify.sh
```

- [ ] `verify.sh` exits 0 — no `not found` entries under **Tool versions**. When a new tool is added to `container/Dockerfile` + `container/scripts/verify.sh`, no checklist edit is needed; verify.sh's own exit code covers it.
- [ ] **Mount points** section lists `/workspace` (rw), `/workspace/vault` (ro), `/workspace/vault/agent-workspace` (rw), `/workspace/vault/.oas` (rw), `/home/claude/.claude` (rw), `/home/claude/.shell-history` (rw)
- [ ] **Container env** section shows `TERM`, `TTYD_PORT`, `PKM_WRITE_DIR`, `MEMORY_FILE_NAME`, `ALLOWED_PRIVATE_HOSTS`, `MEMORY_FILE_PATH` (host-side compose knobs like `PKM_VAULT_PATH`, `CONTAINER_MEMORY`, `TTYD_BIND` are intentionally not injected into the container — verify their effect via Mount points above and cgroup `/sys/fs/cgroup/memory.max`, `/sys/fs/cgroup/cpu.max` instead)
- [ ] **Privileges** section shows `running as: claude` and `sudo apt-get: allowed WITH password` **without prompting for a password** (the probe is non-interactive and derives the answer from sudo's own error message)
- [ ] **Node globals** section shows `@anthropic-ai/claude-code` and `@modelcontextprotocol/server-memory`
- [ ] No warnings for vault mount (shows item count)
- [ ] ttyd shows as listening on port 7681

## 3. Web Terminal (ttyd)

- [ ] Open `http://localhost:7681` in browser — terminal loads
- [ ] bash login shell is active
- [ ] Can type commands and see output
- [ ] Terminal resizes when browser window resizes (`-W` flag working)

> **Note:** Hold **Shift** while selecting text in the browser to ensure the browser handles selection (bypassing terminal capture), then copy with `Ctrl+C`.

## 4. Vault Mount (read-only + writable folder)

```bash
# Inside the container
ls /workspace/vault/
```

- [ ] Vault files are visible inside container
- [ ] Vault is read-only: `echo "test" > /workspace/vault/test.md` **fails** with "Read-only file system"
- [ ] Writable folder exists: `ls /workspace/vault/agent-workspace/`
- [ ] Can write to writable folder: `echo "test" > /workspace/vault/agent-workspace/_test.md`
- [ ] File appears on host filesystem immediately
- [ ] Edit a file on host — change is visible inside container immediately
- [ ] Clean up: `rm /workspace/vault/agent-workspace/_test.md`
- [ ] `/workspace/` itself is writable: `touch /workspace/_scratch && rm /workspace/_scratch` succeeds
- [ ] `/workspace/CLAUDE.md` is visible (workspace rules for Claude)

## 5. Claude Code CLI

```bash
# Inside the container
claude --version
claude
```

- [ ] `claude --version` prints version
- [ ] `claude` launches and authenticates via subscription
- [ ] Claude can read vault files (ask it to list files in `/workspace/vault/`)
- [ ] Claude can create a file in the vault
- [ ] Clean up any test files

---

## 6. Plugin Settings Tab

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 6.1 | Settings tab renders | Open Settings > Community Plugins > Agent Sandbox | All fields visible: compose path, WSL distro, ttyd port, bind address, terminal theme, auto-start toggle, auto-stop toggle |
| 6.2 | Default values | Open settings tab fresh | WSL distro = "Ubuntu", port = 7681, bind address = "127.0.0.1", theme = "Follow Obsidian theme", both toggles off |
| 6.3 | Values persist | Change compose path, restart Obsidian | Value persists |
| 6.4 | Debounced save | Type rapidly in a text field, check `data.json` | File updates ~500ms after last keystroke |
| 6.5 | Save on unload | Change a value, immediately disable the plugin | Re-enable; changed value persists |

## 7. Container Management (requires Docker + WSL)

**Setup:** Configure compose path and WSL distro in settings.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 7.1 | Start container | Cmd palette > "Sandbox: Start Container" | Notice: "Sandbox container started." Status bar: "Sandbox: ▶ Running". `docker ps` from host shell shows `oas-sandbox`. |
| 7.2 | Container status | Cmd palette > "Sandbox: Container Status" | Notice shows JSON output |
| 7.3 | Restart container | Cmd palette > "Sandbox: Restart Container" | Status bar briefly "⏳ Starting", then "▶ Running" |
| 7.4 | Stop container | Cmd palette > "Sandbox: Stop Container" | Notice: "Sandbox container stopped." Status bar: "⏹ Stopped" |
| 7.5 | Error - no Docker | Stop Docker daemon, run Start | Notice: "Docker is not running..." Status bar: "⚠ Error" |
| 7.6 | Error - bad distro | Set WSL distro to "NonExistent", run Start | Notice: "WSL distribution 'NonExistent' not found..." |
| 7.7 | Status bar on load | Enable plugin with auto-start OFF | Status bar shows "Sandbox: ⏹ Stopped" |
| 7.8 | Auto-start | Enable auto-start, restart Obsidian | Container starts automatically |
| 7.9 | Auto-stop | Enable auto-stop, disable plugin | Container stops on plugin unload |

## 8. Terminal View (requires running container)

**Setup:** Start the container first (test 7.1).

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 8.1 | Open via ribbon | Click terminal icon in left ribbon | Terminal pane opens at bottom |
| 8.2 | Open via command | Cmd palette > "Open Sandbox Terminal" | New terminal pane opens |
| 8.3 | Terminal connects | With container running | Loading message, then xterm.js terminal renders |
| 8.4 | Terminal is interactive | Type commands | Input/output works, shell responds |
| 8.5 | Theme - follow Obsidian | Set theme to "Follow Obsidian theme", open terminal | Colors match Obsidian theme |
| 8.6 | Theme - dark | Set theme to "Dark", open terminal | Dark background (#1e1e1e) |
| 8.7 | Theme - light | Set theme to "Light", open terminal | Light background (#ffffff) |
| 8.8 | Resize | Drag the pane edge | Terminal reflows to fit new dimensions |
| 8.9 | Connection failure | Stop container, open terminal | Loading ~30s, then error with "Retry" button |
| 8.10 | Retry works | Click Retry after starting container | Terminal connects |
| 8.11 | Close during poll | Open terminal with container stopped, close within 5s | No errors, no zombie processes |
| 8.12 | Rapid close/reopen | Open, close, immediately reopen | No duplicate terminals, no errors |
| 8.13 | Plugin reload | Disable and re-enable plugin | No stale panes, can open fresh terminal |
| 8.14 | WebSocket disconnect | Stop container while terminal is open | Terminal shows "[Connection closed]" in red |

## 9. Independent Sessions

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 9.1 | Multiple terminals | Open 3 terminals via command palette | 3 separate tabs: "Sandbox Terminal 1", "Sandbox Terminal 2", "Sandbox Terminal 3" |
| 9.2 | Independent sessions | Type different commands in each terminal | Each has its own shell, no shared state |
| 9.3 | Close one | Close terminal 2 | Terminals 1 and 3 unaffected |
| 9.4 | Browser + plugin | Open `http://localhost:7681` in browser alongside plugin terminals | Browser gets its own independent session |

## 10. Integration

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 10.1 | Full workflow | Configure → Start → Open terminal → Use Claude Code → Stop | All steps work end-to-end |
| 10.2 | Vault access | In terminal, `ls /workspace/vault` | Vault files visible |
| 10.3 | Settings change | Change ttyd port, close and reopen terminal | New port used |
| 10.4 | Parallel Claude | Open 2 terminals, run `claude` in each | Both instances work independently |

## 11. Edge Cases

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 11.1 | Compose path with spaces | Set path with spaces | Commands execute correctly (shell-escaped) |
| 11.2 | Invalid port | Type "abc" in port field | Silently rejected, previous port retained |
| 11.3 | Console errors | Open dev tools (Ctrl+Shift+I), perform all tests | No unexpected errors |

## 12. Container Lifecycle

### Container-level (shell, from the host)

```bash
docker compose restart
```

- [ ] After restart, ttyd is accessible again
- [ ] bash sessions are fresh (expected — don't persist across restarts)
- [ ] Vault mount still works

```bash
docker compose down
docker compose up -d
```

- [ ] Container comes back up healthy
- [ ] Named volumes preserve Claude Code config (`oas-claude-config`)
- [ ] Named volumes preserve shell history (`oas-shell-history`)

### Plugin-level (reuse, recreate, auto-stop semantics)

The plugin runs `docker compose up -d` on Start (idempotent: reuses the running container when config matches, recreates on config drift). Restart explicitly does `down` + `up -d` for a forced clean recreate. These tests confirm the difference.

**Reuse across Obsidian sessions** (the original auto-stop trap):

- [ ] Set **Auto-stop on exit** to **off** in plugin settings.
- [ ] Start the container from the Obsidian command palette. Note the container ID: `docker compose ps --format json | jq -r '.[0].ID'` (or `docker compose ps` and copy the ID column).
- [ ] Open a terminal in Obsidian, run `date; atuin history list | head`. Note the current time and history.
- [ ] Close Obsidian completely. Confirm on the host: `docker compose ps` — container still running.
- [ ] Reopen Obsidian. Status bar shows `Running` **within a second**, no `Starting` phase.
- [ ] Container ID is **unchanged** from before close.
- [ ] Click **Open Sandbox Terminal**. Terminal connects in under a second. `atuin history list | head` shows the commands from before close.
- [ ] Previously-persisted terminal tabs (if any were open when Obsidian closed) re-attach: they show "Connecting…" then a fresh shell prompt, not a permanent error. The scrollback from the old session is gone (expected — it lived in the previous xterm.js instance), but the container is the same.

**Config-change triggers recreate** (the other half — reuse doesn't mean stuck):

- [ ] With the container running, change **Vault write directory** in plugin settings to something new (e.g. `agent-workspace-test`).
- [ ] Run **Sandbox: Start Container** from the command palette.
- [ ] Compose detects the env-var change and recreates: container ID **changes**.
- [ ] Open a terminal — `ls /workspace/vault/agent-workspace-test/` succeeds (the new mount took effect).
- [ ] Revert the setting and Start again — container recreates back.

**Explicit clean restart**:

- [ ] With the container running, run **Sandbox: Restart Container** from the command palette.
- [ ] Container ID **changes** regardless of whether config changed (explicit down + up).
- [ ] `/tmp` is empty, any background processes from before are gone.

**Auto-stop on = stops on close**:

- [ ] Set **Auto-stop on exit** to **on**.
- [ ] Start the container. Confirm running on the host.
- [ ] Close Obsidian. Within 10 seconds, `docker compose ps` shows no `oas-sandbox` container (or it's in the `Exit` state).
- [ ] Reopen Obsidian, manually Start — fresh container, new ID.

**Auto-stop off = does not stop on close** (the fix):

- [ ] Set **Auto-stop on exit** to **off**. Start the container.
- [ ] Close Obsidian. `docker compose ps` on the host still shows `oas-sandbox` running.
- [ ] This behaviour is what makes the reuse test above possible.

**Plugin disable always stops regardless of setting**:

- [ ] Set **Auto-stop on exit** to **off**. Start the container.
- [ ] Disable the plugin from Obsidian settings (don't close Obsidian).
- [ ] `docker compose ps` on the host shows the container is stopped.
- [ ] Re-enable the plugin; if Auto-start is off, the container stays stopped.

**Persistent shell sessions**:

- [ ] `tmux -V` inside the container prints a version.
- [ ] `type session` inside an interactive login shell reports it as a function.
- [ ] `session work` enters a fresh bash prompt (inside tmux session `work`). No visible status line, no prefix-key weirdness.
- [ ] Inside, run `echo pre-disconnect` then `(sleep 600 && echo done) &`. Note the PID.
- [ ] Close the Obsidian tab. On the host: `docker compose exec sandbox pgrep -a sleep` shows the PID still alive.
- [ ] Reopen a terminal, run `sessions` — shows `work: ...`. Run `session work` — reattaches. `jobs` shows the background sleep.
- [ ] `atuin history list | head` — the `echo pre-disconnect` entry is recorded (tmux is transparent to atuin's preexec hooks).
- [ ] Multi-client sync: open a SECOND Obsidian terminal tab, run `session work`. Both tabs show the same session; a keystroke in either shows up in both. Close one tab; the other remains connected.
- [ ] Nesting-awareness: while inside `session work`, run `session other`. You should be swapped to `other` via `switch-client` with no "sessions should be nested" error. `session work` from inside `other` swaps back.
- [ ] Press `Ctrl-\` to detach. You're back at the outer bash.
- [ ] `docker compose restart sandbox` — sessions are wiped. `sessions` shows `(no sessions)`.

## 13. Network Firewall (optional)

```bash
docker compose exec --user root sandbox /usr/local/bin/init-firewall.sh
```

- [ ] Script runs without errors
- [ ] `curl https://api.anthropic.com` works (allowlisted)
- [ ] `curl https://example.com` fails (not allowlisted)
- [ ] Claude Code still functions
- [ ] `sudo apt-get update` inside the container succeeds (Ubuntu mirrors are in the allowlist)
- [ ] Disable: `docker compose exec --user root sandbox /usr/local/bin/init-firewall.sh --disable`
- [ ] Status: `docker compose exec --user root sandbox /usr/local/bin/init-firewall.sh --status`
- [ ] Claude user inside container cannot run `sudo /usr/local/bin/init-firewall.sh` (sudoers scope is narrow — only apt-get/apt)

## 14. Port Remapping (optional)

```bash
# In container/.env, set TTYD_PORT=8080
docker compose up -d
```

- [ ] ttyd accessible on `http://localhost:8080`
- [ ] Plugin connects when configured with custom port

## 15. Host Docker / Rancher Desktop (Local mode)

**Goal:** verify the plugin works when Docker runs on the host rather than inside WSL. Rancher Desktop is the reference environment; Docker Desktop and native Linux/Mac Docker should behave the same.

### 15.1 Prerequisites check

- [ ] `docker version` from a host shell returns both client and server info
- [ ] `docker compose version` reports compose v2.x
- [ ] `docker ps` runs without permission errors
- [ ] Rancher Desktop's container engine is set to **dockerd (moby)**, not **containerd/nerdctl** (check Preferences > Container Engine)

### 15.2 Plugin configuration

In **Settings > Agent Sandbox > General**:

- [ ] **Docker mode** = `Local (Linux / Mac / Windows)`
- [ ] **Docker Compose path** points to the absolute host path of the `container/` directory (e.g. `C:\Users\me\obsidian-agent-sandbox\container` on Windows, `/Users/me/obsidian-agent-sandbox/container` on Mac)
- [ ] **WSL distribution** field is hidden (WSL-only setting)

### 15.3 Start and connect

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 15.3.1 | Start container | Cmd palette > "Sandbox: Start Container" | Notice: "Sandbox container started." Status bar: "▶ Running". No WSL window flashes. |
| 15.3.2 | Container visible to host | Run `docker ps` on the host | `oas-sandbox` listed as running |
| 15.3.3 | Open terminal | Ribbon icon or "Open Sandbox Terminal" | Terminal renders, bash prompt visible |
| 15.3.4 | Claude Code works | Run `claude --version` in the terminal | Version prints, no errors |
| 15.3.5 | Memory MCP works | Run `claude` and ask it to store a fact in memory | Memory file appears at `<vault>/.oas/memory.json` on host |
| 15.3.6 | Vault mount | Run `ls /workspace/vault` in terminal | Host vault files visible |
| 15.3.7 | Stop container | "Sandbox: Stop Container" | Notice: "Sandbox container stopped." No errors. |

### 15.4 Path handling edge cases

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 15.4.1 | Path with spaces | Set compose path with a space (e.g. `C:\My Vault\container`) | Commands execute correctly |
| 15.4.2 | Relative path rejection | Set compose path to a relative value | Plugin shows validation error or fails loud |
| 15.4.3 | Windows drive letter | On Windows with Rancher Desktop, set path with backslashes | `docker compose` resolves the path correctly |

### 15.5 Lifecycle

- [ ] Auto-start on load → container starts when Obsidian launches
- [ ] Auto-stop on exit → container stops cleanly when Obsidian closes (no WSL window)
- [ ] Plugin disable → container stops via `onunload`
- [ ] Firewall toggle works (Linux host only — Rancher Desktop on Mac/Windows uses a VM and iptables rules apply inside the VM)

### 15.6 Known differences vs WSL mode

- **No WSL path translation**: `windowsToWslPath()` is bypassed. Vault paths are passed as-is to docker compose.
- **No distro name**: the WSL distribution setting is irrelevant.
- **Socket vs VM**: On Rancher Desktop, Docker runs in a lightweight VM. Host paths are auto-mounted by Rancher Desktop's VFS; bind mounts should work transparently but may be slower than native Linux.
- **Firewall caveat**: `init-firewall.sh` uses iptables and runs *inside* the container. It works the same in Local mode but host-side networking behavior may differ if Rancher Desktop's VM has its own routing.

## 16. WSL-specific (WSL mode)

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 16.1 | Path translation | Start with vault at `C:\vault` | `PKM_VAULT_PATH` is converted to `/mnt/c/vault` before being passed to compose |
| 16.2 | Distro validation | Set WSL distro to `NonExistent!@#` | Plugin rejects invalid distro name |
| 16.3 | Missing distro | Set WSL distro to a real but uninstalled name | Clear error notice, no silent failure |
| 16.4 | Mirrored networking | Verify `http://localhost:7681` works from both Obsidian and a Windows browser | Both reach the container via the same address |

## 17. Mount Isolation (new)

Verify that the restructured mounts give Claude access to `workspace/` but NOT to `container/` infra.

```bash
# On the host
docker compose exec sandbox bash -lc 'ls /workspace'
```

- [ ] `/workspace/.claude/settings.json` is visible
- [ ] `/workspace/.mcp.json` is visible
- [ ] `/workspace/CLAUDE.md` is visible (workspace rules)
- [ ] `/workspace/vault/` is visible
- [ ] Writing from inside works: `touch /workspace/_tier1_test && rm /workspace/_tier1_test` succeeds

## 18. Naming Consistency (OAS prefix, new)

From a host shell with the container running:

- [ ] `docker compose config` shows `name: oas`
- [ ] `docker compose config` shows `container_name: oas-sandbox` and `image: oas-sandbox:latest`
- [ ] `docker ps --format '{{.Names}}' | grep oas-` shows `oas-sandbox`
- [ ] `docker volume ls --format '{{.Name}}' | grep oas-` shows `oas-claude-config` and `oas-shell-history`
- [ ] `docker images --format '{{.Repository}}:{{.Tag}}' | grep oas-sandbox` shows `oas-sandbox:latest`

## 19. Sudo Model (new)

Verify the narrow sudo contract and password gating.

Default password path (plugin setting empty, `container/.env` has `SUDO_PASSWORD=sandbox`):

- [ ] In a ttyd session, `sudo -l` shows only `/usr/bin/apt-get` and `/usr/bin/apt`
- [ ] `sudo apt-get update` prompts for password, `sandbox` works
- [ ] `sudo apt-get install -y htop` installs successfully, `htop` runs
- [ ] `sudo bash` is rejected with "not allowed"
- [ ] `sudo rm /etc/hostname` is rejected with "not allowed"
- [ ] `env | grep SUDO_PASSWORD` returns nothing (entrypoint unsets it before dropping privileges)

Plugin override:

- [ ] In Obsidian settings > Agent Sandbox > Advanced, set "Sudo password" to a new value
- [ ] Restart the container via the plugin
- [ ] In a new ttyd session, the old `sandbox` password is rejected and the new password works

Disabled sudo:

- [ ] Set plugin "Sudo password" to empty, remove `SUDO_PASSWORD` from `container/.env`, restart container
- [ ] `sudo apt-get update` in a ttyd session fails with password prompt that rejects anything typed (or account locked) — confirms sudo is effectively disabled

## 20. Workspace PR Workflow (new)

End-to-end check that the "branch first, Claude edits, host commits" flow works.

```bash
# On the host, from the monorepo root
git checkout -b feature/test-workspace-flow
```

- [ ] Open Obsidian, start the container via the plugin
- [ ] Open a terminal, run `claude`, ask it to append a test comment to `workspace/CLAUDE.md` (e.g. "<!-- test marker -->")
- [ ] Close the session, back on host shell: `git status` shows `workspace/CLAUDE.md` as modified
- [ ] `git diff workspace/` shows the Claude-made change
- [ ] `git restore workspace/` cleanly reverts the change (the rollback path works)
- [ ] Alternative: `git add workspace/ && git commit -m "test" && git push -u origin feature/test-workspace-flow` succeeds
- [ ] Clean up: checkout main, delete the test branch, delete the remote branch if pushed

---

## 21. MCP Server — Settings

**Setup:** Plugin installed and enabled. No container needed for settings tests.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 21.1 | MCP tab renders | Open Settings > Agent Sandbox > MCP tab | All fields visible: Enable toggle, port, auth token, and 5 permission tier toggles |
| 21.2 | Default values | Check MCP tab on first install | Enable = on, Port = 28080, Token = auto-generated (32-char hex), Read = on, Write (scoped) = on, Write (vault-wide) = off, Navigate = off, Manage = off |
| 21.3 | Token auto-generated | Disable plugin, delete `data.json`, re-enable | A new token is auto-generated |
| 21.4 | Token regenerate | Click "Regenerate" button next to token | Token changes to a new value, field updates immediately |
| 21.5 | Token persists | Note token value, restart Obsidian | Same token value after restart |
| 21.6 | Port validation | Type "abc" in port field | Input gets red border, previous valid port retained |
| 21.7 | Tier toggles persist | Toggle Write (vault-wide) on, restart Obsidian | Toggle state persists |

## 22. MCP Server — Lifecycle

**Setup:** Plugin installed and enabled, MCP enabled in settings (default).

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 22.1 | Auto-start on load | Enable MCP (default), restart Obsidian | MCP server starts. Verify: `curl http://localhost:28080/mcp` returns 401 Unauthorized (auth required — server is listening) |
| 22.2 | Toggle off via command | Cmd palette > "Sandbox: Toggle MCP Server" | Notice: "MCP server stopped." `curl http://localhost:28080/mcp` returns connection refused |
| 22.3 | Toggle on via command | Cmd palette > "Sandbox: Toggle MCP Server" (again) | Notice: "MCP server listening on port 28080." Curl returns 401 again |
| 22.4 | Disabled in settings | Turn off "Enable MCP server" in settings, restart Obsidian | Server does not start. Curl returns connection refused |
| 22.5 | Port change | Change MCP port to 28081, restart Obsidian | Server listens on new port. `curl http://localhost:28081/mcp` returns 401 |
| 22.6 | Port conflict | Set MCP port to same as ttyd (7681), restart | Error notice: "MCP server failed to start: ..." (EADDRINUSE) |
| 22.7 | Plugin unload stops server | Disable plugin while MCP is running | Server stops. Curl returns connection refused |

## 23. MCP Server — Authentication

**Setup:** MCP server running. Note the auth token from MCP settings tab.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 23.1 | No auth | `curl -X POST http://localhost:28080/mcp -H "Content-Type: application/json" -d '{}'` | 401 `{"error":"Unauthorized"}` |
| 23.2 | Wrong token | `curl -X POST http://localhost:28080/mcp -H "Authorization: Bearer wrongtoken" -H "Content-Type: application/json" -d '{}'` | 401 `{"error":"Unauthorized"}` |
| 23.3 | Correct token | `curl -X POST http://localhost:28080/mcp -H "Authorization: Bearer <token>" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'` | 200 with JSON-RPC response containing server info and capabilities |
| 23.4 | Wrong path | `curl -X POST http://localhost:28080/other -H "Authorization: Bearer <token>"` | 404 Not Found |
| 23.5 | CORS preflight | `curl -X OPTIONS http://localhost:28080/mcp` | 204 with CORS headers (Access-Control-Allow-Origin, etc.) |

## 24. MCP Server — Container Integration

**Setup:** MCP server running, container running with Docker Compose path configured.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 24.1 | Env vars injected | Open terminal, run `echo $OAS_MCP_TOKEN` | Prints the same token shown in MCP settings tab |
| 24.2 | Port var injected | In terminal: `echo $OAS_MCP_PORT` | Prints the MCP port (default 28080) |
| 24.3 | Host reachable | In terminal: `curl -s -o /dev/null -w "%{http_code}" http://host.docker.internal:28080/mcp` | Returns `401` (server reachable, auth required) |
| 24.4 | Container auth works | In terminal: `curl -X POST http://host.docker.internal:$OAS_MCP_PORT/mcp -H "Authorization: Bearer $OAS_MCP_TOKEN" -H "Content-Type: application/json" -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"1.0"}}}'` | 200 with server capabilities |
| 24.5 | MCP disabled omits vars | Turn off MCP in settings, restart container | `echo $OAS_MCP_TOKEN` is empty inside container |
| 24.6 | Claude Code discovers tools | In terminal: `claude` then ask "what MCP tools do you have?" | Claude lists `mcp__obsidian__vault_*` tools (if .mcp.json is configured). If MCP env vars are missing Claude reports obsidian server connection failed — expected when MCP is off |

## 25. MCP Server — Read Tier Tools

**Setup:** MCP server running, container running, at least a few markdown files in the vault with frontmatter, tags, and wikilinks.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 25.1 | vault_read | In Claude session: "read the file Welcome.md from my vault" | Claude calls `vault_read`, returns file contents |
| 25.2 | vault_list | "list all markdown files in my vault" | Claude calls `vault_list`, returns file paths |
| 25.3 | vault_list filtered | "list files in the agent-workspace folder" | Only files within that folder shown |
| 25.4 | vault_search | "search my vault for [term that exists]" | Returns matching files with context snippets |
| 25.5 | vault_search no match | "search my vault for xyzzy123nonsense" | "No matches found." |
| 25.6 | vault_file_info | "show me info about Welcome.md" | Returns path, name, extension, size, created, modified |
| 25.7 | vault_tags | "what tags are used in my vault?" | Lists tags with occurrence counts, sorted by frequency |
| 25.8 | vault_tags per file | "what tags does [specific file] have?" | Lists only that file's tags |
| 25.9 | vault_frontmatter | "show me the frontmatter of [file with YAML]" | Returns parsed frontmatter as JSON |
| 25.10 | vault_frontmatter property | "what is the 'status' property of [file]?" | Returns just that property's value |
| 25.11 | vault_links | "what does [file] link to?" | Lists outgoing wikilinks with counts |
| 25.12 | vault_backlinks | "what files link to [file]?" | Lists files that contain wikilinks to the target |
| 25.13 | vault_headings | "show me the outline of [file]" | Lists headings indented by level |
| 25.14 | vault_orphans | "find orphan notes in my vault" | Lists files with no incoming links |
| 25.15 | vault_unresolved | "are there any broken links in my vault?" | Lists unresolved wikilinks with source files |
| 25.16 | Read tier disabled | Turn off Read in MCP settings, restart MCP server (toggle command) | Claude cannot find `vault_read` or any read tools. Other tiers still work if enabled |

## 26. MCP Server — Write Scoped Tier Tools

**Setup:** MCP server running, container running, Write (scoped) enabled (default). Write directory is `agent-workspace`.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 26.1 | vault_create | "create a file called agent-workspace/mcp-test.md with content 'Hello from MCP'" | File created. Visible in Obsidian file explorer under agent-workspace/ |
| 26.2 | vault_create outside write dir | "create a file called test-root.md with content 'test'" | Error: "Path must be within the write directory 'agent-workspace'." |
| 26.3 | vault_modify | "replace the contents of agent-workspace/mcp-test.md with 'Updated via MCP'" | File contents replaced. Open in Obsidian to verify |
| 26.4 | vault_append | "append '## New Section' to agent-workspace/mcp-test.md" | Content appended to end of file |
| 26.5 | vault_frontmatter_set | "set the 'status' property to 'draft' on agent-workspace/mcp-test.md" | Frontmatter added/updated. Open file to verify YAML block |
| 26.6 | Modify outside write dir | "modify Welcome.md to add 'test' at the end" | Error: "Path must be within the write directory" |
| 26.7 | Write scoped disabled | Turn off Write (scoped) in settings, restart MCP | Claude cannot find `vault_create`, `vault_modify`, etc. Read tools still work |
| 26.8 | Clean up | Delete `agent-workspace/mcp-test.md` from Obsidian or terminal | File removed |

## 27. MCP Server — Write Vault Tier Tools

**Setup:** MCP server running, container running, Write (vault-wide) enabled in settings (off by default — turn it on).

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 27.1 | vault_create_anywhere | "create a file called mcp-vault-test.md at the vault root with content 'Vault-wide write'" | File created at vault root. Visible in Obsidian |
| 27.2 | vault_modify_anywhere | "update mcp-vault-test.md with new content 'Modified anywhere'" | File contents replaced |
| 27.3 | vault_append_anywhere | "append a line to mcp-vault-test.md" | Content appended |
| 27.4 | vault_frontmatter_set_anywhere | "add a 'created-by' property with value 'mcp' to mcp-vault-test.md" | Frontmatter updated |
| 27.5 | Tier disabled hides tools | Turn off Write (vault-wide), restart MCP | `vault_*_anywhere` tools not available. Scoped writes still work if that tier is on |
| 27.6 | Clean up | Delete `mcp-vault-test.md` | File removed |

## 28. MCP Server — Navigate Tier Tools

**Setup:** MCP server running, container running, Navigate enabled in settings (off by default — turn it on). Have a file open in Obsidian.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 28.1 | vault_open | "open Welcome.md in Obsidian" | File opens in the Obsidian editor. User sees the file appear |
| 28.2 | vault_open new tab | "open Welcome.md in a new tab" | File opens in a new tab alongside existing content |
| 28.3 | vault_open nonexistent | "open nonexistent-file.md" | Error: "File not found." |
| 28.4 | Navigate disabled | Turn off Navigate, restart MCP | `vault_open` not available |

## 29. MCP Server — Manage Tier Tools

**Setup:** MCP server running, container running, Manage enabled in settings (off by default — turn it on). Create a test file `agent-workspace/manage-test.md` with a wikilink `[[manage-test]]` in another file.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 29.1 | vault_rename | "rename manage-test.md to manage-renamed.md" | File renamed. Wikilinks in other files updated to `[[manage-renamed]]` |
| 29.2 | vault_move | "move manage-renamed.md to agent-workspace/subfolder/" | File moved. Links updated |
| 29.3 | vault_delete | "delete agent-workspace/subfolder/manage-renamed.md" | File moved to trash (not permanently deleted) |
| 29.4 | vault_create_folder | "create a folder called agent-workspace/new-folder" | Folder created. Visible in Obsidian file explorer |
| 29.5 | Manage disabled | Turn off Manage, restart MCP | `vault_rename`, `vault_move`, `vault_delete`, `vault_create_folder` not available |
| 29.6 | Clean up | Remove test folders/files if any remain | Clean state |

## 30. MCP Server — Permission Tier Combinations

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 30.1 | All tiers off | Disable all 5 tiers, restart MCP | Claude sees no obsidian tools. MCP server is running but has zero tools |
| 30.2 | Only Read | Enable only Read | Claude can search/read but cannot create, modify, open, rename, or delete |
| 30.3 | Read + Write scoped | Enable Read and Write (scoped) (the defaults) | Claude can read anything, write only within agent-workspace/ |
| 30.4 | All tiers on | Enable all 5 tiers | Claude has full vault access. Verify all tool categories work |
| 30.5 | Tier change requires restart | Change a tier toggle while MCP is running, don't restart | Tools don't change until MCP is toggled off/on (or Obsidian restarted) |

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes (Claude config, shell history):
# docker compose down -v
```
