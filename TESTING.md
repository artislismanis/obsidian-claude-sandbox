# PKM Claude Terminal — Manual Testing Checklist

## Prerequisites

- [ ] Docker installed inside WSL2 (not Docker Desktop on Windows)
- [ ] WSL2 networking mode set to `mirrored` in `~/.wslconfig`
- [ ] pkm-workspace repo with `docker-compose.yml` configured
- [ ] Container includes: `ttyd` (port 7681), `tmux` (with `set -g mouse off`), Claude Code CLI
- [ ] `ANTHROPIC_API_KEY` set as environment variable for the container
- [ ] Plugin built: `npm install && npm run build`
- [ ] Plugin installed: copy `main.js`, `manifest.json`, `styles.css` to vault's `.obsidian/plugins/pkm-claude-terminal/`
- [ ] Plugin enabled in Obsidian Settings > Community Plugins

---

## 1. Settings Tab

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 1.1 | Settings tab renders | Open Settings > Community Plugins > PKM Claude Terminal | All 7 fields visible: compose path, WSL distro, ttyd port, ttyd user, ttyd password, auto-start toggle, auto-stop toggle |
| 1.2 | Default values | Open settings tab fresh | WSL distro = "Ubuntu", port = 7681, user = "user", password = empty, both toggles off |
| 1.3 | Values persist | Change compose path to `/home/user/test`, restart Obsidian | Value still shows `/home/user/test` |
| 1.4 | Password field masked | Look at ttyd password field | Input type is password (dots, not plaintext) |
| 1.5 | Debounced save | Type rapidly in a text field, check vault's `.obsidian/plugins/pkm-claude-terminal/data.json` | File updates ~500ms after last keystroke, not on every key |
| 1.6 | Save on unload | Change a value, immediately disable the plugin | Re-enable plugin; changed value persists |

---

## 2. Container Management (requires Docker + WSL)

**Setup:** Configure compose path and WSL distro in settings to match your pkm-workspace location.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 2.1 | Start container | Cmd palette > "PKM: Start Container" | Notice: "PKM container started." Status bar: "PKM: ▶ Running" |
| 2.2 | Container status | Cmd palette > "PKM: Container Status" | Notice shows `docker compose ps` JSON output |
| 2.3 | Restart container | Cmd palette > "PKM: Restart Container" | Status bar briefly shows "⏳ Starting", then "▶ Running". Notice confirms restart |
| 2.4 | Stop container | Cmd palette > "PKM: Stop Container" | Notice: "PKM container stopped." Status bar: "PKM: ⏹ Stopped" |
| 2.5 | Error handling - no Docker | Stop Docker daemon, run Start | Notice: "Docker is not running..." Status bar: "⚠ Error" |
| 2.6 | Error handling - bad distro | Set WSL distro to "NonExistent" in settings, run Start | Notice: "WSL distribution 'NonExistent' not found..." |
| 2.7 | Status bar on load | Enable plugin with auto-start OFF | Status bar shows "PKM: ⏹ Stopped" |
| 2.8 | Auto-start | Enable auto-start in settings, restart Obsidian | Container starts automatically, status bar shows Running |
| 2.9 | Auto-stop | Enable auto-stop, disable plugin | Container stops on plugin unload |

---

## 3. Terminal View (requires running container with ttyd)

**Setup:** Start the container first (test 2.1), ensure ttyd is running on port 7681.

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 3.1 | Open via ribbon | Click terminal icon in left ribbon | Terminal pane opens in right sidebar |
| 3.2 | Open via command | Cmd palette > "Open Claude Terminal" | Terminal pane opens (or reveals if already open) |
| 3.3 | Terminal connects | With container running | Loading message, then xterm.js terminal renders with Obsidian theme colors |
| 3.4 | Terminal is interactive | Type commands in the terminal | Input/output works, shell responds |
| 3.5 | Theming | Switch between light and dark Obsidian themes | Terminal background/foreground match the theme (requires reopen) |
| 3.6 | Resize | Drag the sidebar wider/narrower | Terminal reflowed to fit new dimensions |
| 3.7 | Connection failure | Stop container, then open terminal | Loading message for ~30s, then error with "Retry" button |
| 3.8 | Retry works | Click Retry after starting the container | Terminal connects successfully |
| 3.9 | Close during poll | Open terminal with container stopped, close the pane within 5s | No errors in console, no zombie processes |
| 3.10 | Rapid close/reopen | Open terminal, close it, immediately reopen | No duplicate terminals, no errors |
| 3.11 | Singleton pane | Click ribbon icon when terminal is already open | Existing pane revealed, no second pane created |
| 3.12 | Plugin reload | Disable and re-enable plugin | No stale terminal panes, can open fresh terminal |
| 3.13 | WebSocket disconnect | Stop container while terminal is open | Terminal shows "[Connection closed]" in red |
| 3.14 | ttyd auth | Configure ttyd with `--credential user:pass`, set matching credentials in settings | Terminal connects via token auth |

---

## 4. Integration Tests

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 4.1 | Full workflow | Configure settings → Start container → Open terminal → Use Claude Code → Stop container | All steps work end-to-end |
| 4.2 | tmux multiplexing | In the terminal, create tmux windows/panes | Multiple sessions work within single terminal |
| 4.3 | Vault file access | In terminal, `ls /workspace/vault` (or configured mount path) | Vault files visible from container |
| 4.4 | Settings change + reconnect | Change ttyd port in settings, close and reopen terminal | New port used for connection |

---

## 5. Edge Cases

| # | Test | Steps | Expected |
|---|------|-------|----------|
| 5.1 | Compose path with spaces | Set path to `/home/user/my projects/pkm` | Commands execute correctly (path is shell-escaped) |
| 5.2 | Invalid port | Type "abc" in port field | Value silently rejected, previous valid port retained |
| 5.3 | Empty password | Leave password blank, connect to ttyd without `--credential` | Connects without auth (token fetch fails silently, falls back to no-auth) |
| 5.4 | Console errors | Open Obsidian dev tools (Ctrl+Shift+I), perform all tests | No unexpected errors or warnings in console |
