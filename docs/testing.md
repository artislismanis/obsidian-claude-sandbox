# Manual Testing Checklist

Most of what this doc used to cover is now automated. Use this checklist only for what can't be automated: visual rendering, interactive LLM behavior, environment-specific setup, and user-driven workflows.

## Automated coverage (run before touching this checklist)

| Layer | Run | Covers |
|-------|-----|--------|
| Unit | `cd plugin && npm run test` | Validation, shell escaping, tool handlers, auth logic, status bar state machine — 184 tests |
| Integration | `npm run test:integration` | Real Docker container: build state, ttyd health, verify.sh, mounts (ro/rw), sudo model, MCP env injection, mount isolation, naming, MCP HTTP auth — 28 tests |
| E2E | `npm run test:e2e` | Real Obsidian: plugin loads, ribbon, status bar, commands registered, settings tabs render, MCP tab + tiers, auth token generation — 8 tests |

If a behaviour is covered by any automated layer, don't duplicate it here — fix it in code, re-run the relevant suite.

---

## 1. Environment prerequisites (one-time per machine)

Run these once when setting up a new development machine or testing on a new OS.

### Common
- [ ] An Obsidian vault to use (any existing vault works)
- [ ] Claude Code subscription authenticated
- [ ] Plugin built and installed into vault (`.obsidian/plugins/obsidian-agent-sandbox/`)
- [ ] Plugin enabled in Community Plugins

### WSL-mode specifics
- [ ] Docker Engine installed inside WSL2 (not Docker Desktop)
- [ ] WSL2 mirrored networking (`networkingMode=mirrored` in `.wslconfig`)
- [ ] `http://localhost:7681` works from both Obsidian (inside WSL) and a Windows browser

### Host-Docker / Rancher Desktop specifics
- [ ] `docker version` returns client and server info
- [ ] `docker compose version` reports compose v2.x
- [ ] `docker ps` runs without permission errors
- [ ] Rancher Desktop engine = **dockerd (moby)**, not containerd/nerdctl

---

## 2. Visual rendering

Things a human has to look at.

- [ ] **Terminal theme — follow Obsidian**: Set theme to "Follow Obsidian theme", open terminal. Colors match the current Obsidian theme.
- [ ] **Terminal theme — dark**: Force "Dark" theme. Terminal has dark background (#1e1e1e).
- [ ] **Terminal theme — light**: Force "Light" theme. Terminal has light background (#ffffff).
- [ ] **Font size applied**: Change font size to 20 in Terminal tab settings, open a new terminal. Text is visibly larger than default.
- [ ] **Font family applied**: Set a custom font (e.g. `Fira Code`) that's installed on the system. Terminal uses it.
- [ ] **Terminal resize**: Drag the Obsidian pane edge. Terminal reflows cleanly, no cut-off or visual artifacts.
- [ ] **Status bar icons render**: Container state indicator (⏹/⏳/▶/⚠/🔍) and firewall shield (🛡️) display correctly in the Obsidian status bar.
- [ ] **No Obsidian console errors**: Open DevTools (Ctrl+Shift+I), perform a full session (start → terminal → claude → stop). Console shows no unexpected errors.

---

## 3. Interactive Claude Code use

These require Claude Code running and using MCP tools — the behaviour depends on the LLM, not just the API surface (which unit tests cover).

**Setup**: container running, at least one file in the vault with frontmatter + wikilinks.

- [ ] **Claude authenticates**: Run `claude` in a terminal, subscription auth succeeds.
- [ ] **Claude discovers MCP tools**: Ask Claude "what MCP tools do you have?". It lists `mcp__obsidian__vault_*` tools.
- [ ] **Read tier works end-to-end**: "Search my vault for [term]" → Claude calls `vault_search` and returns results.
- [ ] **Write scoped works end-to-end**: "Create agent-workspace/claude-test.md with content 'hello'" → file appears in Obsidian file explorer.
- [ ] **Write scoped rejects outside**: "Create a file at vault root called test.md" → Claude gets "Path must be within the write directory" and reports it.
- [ ] **Navigate works** (if tier enabled): "Open Welcome.md" → file opens in Obsidian editor, user sees it appear.
- [ ] **Manage works** (if tier enabled): "Rename file X to Y" → file renamed in file explorer, wikilinks updated.
- [ ] **Tier disable hides tools**: Turn off Read tier in MCP settings, toggle MCP server off/on, start Claude → Claude no longer has `vault_read` etc.
- [ ] **Memory MCP**: "Remember that I prefer X" → memory entity created. Check `vault/.oas/memory.json` on host.

---

## 4. User-driven workflows (multi-step, full stack)

End-to-end flows humans do that span Obsidian UI, Docker, and Claude.

- [ ] **Full workflow**: Configure settings → Start container → Open terminal → Run `claude` → Use Claude → Stop container. All steps work without manual intervention between them.
- [ ] **Parallel Claude sessions**: Open 2 terminals, run `claude` in each. Both work independently, no shared state.
- [ ] **Browser + plugin coexistence**: Open `http://localhost:7681` in a browser alongside an Obsidian terminal. Browser gets its own independent session (different tmux/bash instance).
- [ ] **Terminal disconnect & persistent session**: In Obsidian terminal, `session work` → run long command → close tab → open new terminal → `session work` → command still running, output visible.
- [ ] **Multi-client sync**: Two Obsidian terminal tabs both `session work`. Keystroke in one shows in the other.
- [ ] **Rapid close/reopen**: Open terminal, close immediately, reopen. No duplicate panes, no errors.
- [ ] **Plugin disable while running**: Start container, disable plugin in Community Plugins. Container stops. Re-enable — no stale panes.
- [ ] **Workspace PR flow**: Branch off, have Claude edit `workspace/CLAUDE.md`, `git diff workspace/` shows change on host, `git restore workspace/` cleanly reverts.

---

## 5. Lifecycle scenarios that require closing Obsidian

Can't be automated because they span Obsidian process boundaries.

- [ ] **Auto-start on load**: Enable Auto-start, restart Obsidian, container starts automatically.
- [ ] **Auto-stop off = container persists**: Auto-stop off, start container, close Obsidian completely. On host `docker ps` still shows `oas-sandbox` running.
- [ ] **Reuse across Obsidian sessions**: With Auto-stop off, close Obsidian, reopen. Status bar shows Running instantly, container ID unchanged, previously-persisted terminal tabs reconnect.
- [ ] **Auto-stop on = container stops**: Enable Auto-stop, close Obsidian, within 10s container is stopped.
- [ ] **Config drift triggers recreate**: Change `vault write directory` setting with container running, run Start Container. Container ID changes (compose detected config drift). New mount works.
- [ ] **Explicit restart recreates**: Run Sandbox: Restart Container. Container ID changes regardless of config. /tmp is cleared, background processes gone.

---

## 6. Settings UI interactions requiring human timing

These involve modals, debounce timing, or multi-step flows that are fragile to automate.

- [ ] **Debounced save**: Type rapidly in a text field. `data.json` on host updates ~500ms after last keystroke, not on every keystroke.
- [ ] **Save on unload**: Change a value, immediately disable the plugin. Re-enable — changed value persisted (debounced save was flushed).
- [ ] **Restart prompt appears**: Change a restart-needing setting (e.g. port) with container running, close settings tab. Modal appears offering Restart.
- [ ] **Restart prompt — Later**: Click Later. Container keeps running old settings.
- [ ] **Restart prompt — Restart**: Click Restart. Container restarts, terminal sessions disconnect.
- [ ] **No prompt for non-restart settings**: Change only terminal theme, close settings. No modal.
- [ ] **No prompt when container stopped**: Change port with container stopped, close settings. No modal.

---

## 7. Terminal connection states

Race conditions and error paths that are flaky to automate reliably.

- [ ] **Connection failure**: Stop container, open new terminal. After ~30s loading, error with Retry button appears.
- [ ] **Retry works**: Click Retry after starting container. Terminal connects.
- [ ] **Close during connection**: Open terminal with container stopped, close tab within 5s. No errors in console, no zombie processes.
- [ ] **WebSocket disconnect**: Stop container while terminal is open. Terminal shows "[Connection closed]" message.
- [ ] **Auto-start modal from ribbon**: Click ribbon icon with container stopped. "The container is not running. Start it now?" modal appears. Clicking Start starts the container and opens the terminal.

---

## 8. Environment-specific edges

Cross-platform behaviors that need real hardware.

### Windows + WSL
- [ ] **Windows path translation**: Vault at `C:\vault`, `PKM_VAULT_PATH` inside WSL becomes `/mnt/c/vault`.
- [ ] **Missing distro error**: Set WSL distro to a non-installed name — clear error notice, no silent failure.
- [ ] **Mirrored networking**: `http://localhost:7681` reachable from both Windows browser and Obsidian in WSL.

### Host Docker / Rancher Desktop (Local mode)
- [ ] **No WSL window flashes**: Starting/stopping the container doesn't pop up a WSL terminal window on Windows.
- [ ] **Path with spaces**: Compose path containing a space works (shell-escaped correctly).
- [ ] **Windows backslash paths**: Path like `C:\Users\...` resolves correctly in compose.

### Firewall (requires Linux host or Linux VM)
- [ ] **Allowlisted domain reachable**: With firewall enabled, `curl https://api.anthropic.com` works.
- [ ] **Non-allowlisted blocked**: `curl https://example.com` fails.
- [ ] **Claude Code still functional**: After enabling firewall, `claude` continues to work (Anthropic API is allowlisted).
- [ ] **apt allowlist**: `sudo apt-get update` succeeds (Ubuntu mirrors are allowlisted).

### Sudo password override
- [ ] **Plugin setting overrides .env**: Set a custom Sudo password in plugin settings, restart container. Old container/.env password is rejected, new one works.
- [ ] **Empty disables sudo**: Clear plugin setting and remove SUDO_PASSWORD from .env, restart. `sudo apt-get update` rejects any password.

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes (Claude config, shell history):
# docker compose down -v
```

---

## Opportunities to automate further

Items on this list that could move into automated suites with moderate effort, if the friction of manual testing becomes an issue:

- **Font size / scrollback applied** (Section 2) → E2E: can verify xterm `.xterm` element inline style contains `font-size: 20px` and scrollback count is set. The *visible* larger-text check would stay manual.
- **Auto-start modal** (Section 7) → E2E: open terminal with container stopped, assert modal title and button text.
- **Restart prompt** (Section 6) → E2E: programmatically mutate a setting, close settings tab, assert modal appears.
- **Firewall allowlist tests** (Section 8) → INT: run inside container with firewall enabled, assert curl exit codes.
- **Lifecycle with Obsidian close** (Section 5) → E2E: `browser.reloadObsidian()` for some of these, but container persistence across the reload needs platform-specific setup.
