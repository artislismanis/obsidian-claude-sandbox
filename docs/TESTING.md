# Manual Testing Checklist

Testing the Agent Sandbox Docker container and the Obsidian plugin together.

## Prerequisites

- [ ] WSL2 with Docker Engine installed (not Docker Desktop on Windows)
- [ ] WSL2 mirrored networking enabled (`networkingMode=mirrored` in `.wslconfig`)
- [ ] An Obsidian vault with some test files
- [ ] Claude Code subscription authenticated
- [ ] Plugin built: `cd plugin && npm install && npm run build`
- [ ] Plugin installed: copy contents of `plugin/dist/` to vault's `.obsidian/plugins/obsidian-agent-sandbox/`
- [ ] Plugin enabled in Obsidian Settings > Community Plugins

---

## 1. Container Build and Start

```bash
cd docker
cp .env.example .env
# Edit .env — set PKM_VAULT_PATH to your vault
docker compose build
docker compose up -d
```

- [ ] `docker compose build` completes without errors
- [ ] `docker compose up -d` starts successfully
- [ ] `docker compose ps` shows `agent-sandbox` as **healthy**

## 2. Verify Script

```bash
docker compose exec sandbox bash /workspace/scripts/verify.sh
```

- [ ] All tool versions print (Node, npm, git, tmux, ttyd, jq, Claude, gh, delta, fzf, rg, fd, atuin, uv, Python)
- [ ] No warnings for vault mount (shows item count)
- [ ] ttyd shows as listening on port 7681

## 3. Web Terminal (ttyd)

- [ ] Open `http://localhost:7681` in browser — terminal loads
- [ ] tmux session is active (status bar visible at bottom)
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
- [ ] Writable folder exists: `ls /workspace/vault/claude-workspace/`
- [ ] Can write to writable folder: `echo "test" > /workspace/vault/claude-workspace/_test.md`
- [ ] File appears on host filesystem immediately
- [ ] Edit a file on host — change is visible inside container immediately
- [ ] Clean up: `rm /workspace/vault/claude-workspace/_test.md`

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
| 6.1 | Settings tab renders | Open Settings > Community Plugins > Agent Sandbox | All fields visible: compose path, WSL distro, ttyd port, ttyd user, ttyd password, terminal theme, auto-start toggle, auto-stop toggle |
| 6.2 | Default values | Open settings tab fresh | WSL distro = "Ubuntu", port = 7681, user = "user", password = empty, theme = "Follow Obsidian theme", both toggles off |
| 6.3 | Values persist | Change compose path, restart Obsidian | Value persists |
| 6.4 | Password field masked | Look at ttyd password field | Input type is password (dots, not plaintext) |
| 6.5 | Debounced save | Type rapidly in a text field, check `data.json` | File updates ~500ms after last keystroke |
| 6.6 | Save on unload | Change a value, immediately disable the plugin | Re-enable; changed value persists |

## 7. Container Management (requires Docker + WSL)

**Setup:** Configure compose path and WSL distro in settings.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 7.1 | Start container | Cmd palette > "Sandbox: Start Container" | Notice: "Sandbox container started." Status bar: "Sandbox: ▶ Running" |
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
| 8.15 | ttyd auth | Configure ttyd with `--credential user:pass`, set matching credentials | Connects via token auth |

## 9. Independent Sessions

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 9.1 | Multiple terminals | Open 3 terminals via command palette | 3 separate tabs: "Sandbox Terminal 1", "Sandbox Terminal 2", "Sandbox Terminal 3" |
| 9.2 | Independent sessions | Type different commands in each terminal | Each has its own shell, no shared state |
| 9.3 | tmux sessions visible | Run `tmux list-sessions` in any terminal | Shows 3 separate `claude-*` sessions |
| 9.4 | Close one | Close terminal 2 | Terminals 1 and 3 unaffected |
| 9.5 | Browser + plugin | Open `http://localhost:7681` in browser alongside plugin terminals | Browser gets its own independent session |

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
| 11.3 | Empty password | Leave password blank, no `--credential` on ttyd | Connects without auth |
| 11.4 | Console errors | Open dev tools (Ctrl+Shift+I), perform all tests | No unexpected errors |

## 12. Container Lifecycle

```bash
docker compose restart
```

- [ ] After restart, ttyd is accessible again
- [ ] tmux sessions are fresh (expected — don't persist across restarts)
- [ ] Vault mount still works

```bash
docker compose down
docker compose up -d
```

- [ ] Container comes back up healthy
- [ ] Named volumes preserve Claude Code config (`sandbox-claude-config`)
- [ ] Named volumes preserve atuin history (`sandbox-atuin-history`)

## 13. Network Firewall (optional)

```bash
docker compose exec sandbox sudo /usr/local/bin/init-firewall.sh
```

- [ ] Script runs without errors
- [ ] `curl https://api.anthropic.com` works (allowlisted)
- [ ] `curl https://example.com` fails (not allowlisted)
- [ ] Claude Code still functions
- [ ] Disable: `docker compose exec sandbox sudo iptables -F OUTPUT`

## 14. Port Remapping (optional)

```bash
# In docker/.env, set TTYD_PORT=8080
docker compose up -d
```

- [ ] ttyd accessible on `http://localhost:8080`
- [ ] Plugin connects when configured with custom port

---

## Teardown

```bash
cd docker
docker compose down
# To also remove named volumes (Claude config, atuin history):
# docker compose down -v
```
