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

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes (Claude config, shell history):
# docker compose down -v
```
