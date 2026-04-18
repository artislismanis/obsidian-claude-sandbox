# Testing

## Automated test suites

Run these first. If a behavior is covered here, don't test it manually — fix the code and re-run.

```bash
cd plugin

npm run test              # Layer 1: unit tests (184 tests, <2s)
npm run test:integration  # Layer 2: container integration (~40 tests, ~20s, needs Docker)
npm run test:e2e          # Layer 3: real Obsidian UI (~21 tests, ~20s, needs Obsidian)
```

### Claude Code authentication for integration tests

The Claude Code tests in `test/integration/claude-code.test.ts` need an authenticated Claude subscription inside the test container. Auth is stored in the **`oas-test-claude-config`** Docker volume, which is declared `external` in `docker-compose.test.yml` and therefore **survives `compose down -v`** — you sign in once and it persists across all subsequent test runs.

#### One-time setup (per machine)

```bash
# 1. Bring the test container up (env vars match what globalSetup uses)
cd plugin
PKM_VAULT_PATH=$(pwd)/test/fixtures/vault \
PKM_WRITE_DIR=agent-workspace \
TEST_HOST_TTYD_PORT=17681 \
OAS_MCP_TOKEN=integration-test-token \
OAS_MCP_PORT=38080 \
docker compose -f test/docker-compose.test.yml up -d

# 2. Sign in inside the container (must run as the claude user — Claude Code refuses root)
docker exec -it -u claude oas-test-sandbox claude
# Follow the browser auth flow, then exit

# 3. Stop the container (volumes are kept — no -v flag)
docker compose -f test/docker-compose.test.yml down
```

After this, `npm run test:integration` finds auth in `oas-test-claude-config` and runs the Claude Code tests.

To reset auth (e.g. subscription expired):
```bash
docker volume rm oas-test-claude-config
# Then repeat the one-time setup above
```

| Suite | Covers |
|-------|--------|
| **Unit** (`src/__tests__/`) | Validation, shell escaping, tool handlers (24 MCP tools), MCP auth, path traversal, status bar, polling |
| **Integration** (`test/integration/`) | Container health, verify.sh, vault mounts (ro/rw), mount isolation, sudo narrow scope + password unset, MCP env vars, MCP HTTP auth/routing/CORS, MCP tools/list per tier (exact counts: read=11, writeScoped=15, all=24), MCP tool invocation (vault_list, vault_search, vault_read, vault_create), write-directory path-traversal enforcement, disabled-tier call rejected, naming consistency, firewall enable/allowlist/disable, tmux session create/list/persist, port remapping, Claude Code auth + prompt execution + MCP memory tool use + filesystem Read tool |
| **E2E** (`test/e2e/specs/`) | Plugin loads + enabled, ribbon icon, status bar renders, 9 commands registered, 4 settings tabs render, 5 MCP permission tiers visible, token auto-generation/regeneration, font size/scrollback/MCP port validation with error styling, bind address 0.0.0.0 security warning toggle, per-setting restart labels |

---

## Manual-only tests

These require human judgment, interactive LLM sessions, real Obsidian UI, process-boundary events, or platform-specific hardware that cannot be reproduced in CI.

### Environment prerequisites (one-time per machine)

- [ ] WSL2 with Docker Engine and mirrored networking, OR Rancher Desktop / Docker Desktop with dockerd
- [ ] `http://localhost:7681` reachable from both Obsidian and a host browser
- [ ] Plugin installed in Obsidian vault (copy `dist/` to `.obsidian/plugins/obsidian-agent-sandbox/`)

---

### Visual rendering

**Setup:** Obsidian open, plugin enabled, terminal tab open.

| What to check | Expected |
|---|---|
| Terminal theme set to "Follow Obsidian" / Dark / Light | Terminal background and text colours match the selected theme |
| Custom font family set to a font installed on this machine | Terminal text renders in that font |
| Status bar icons ⏹ ⏳ ▶ ⚠ 🔍 🛡️ | Correct icon shown for each container/firewall state |
| Drag the terminal pane edge to resize | Terminal content reflows cleanly, no character artifacts |
| Open Obsidian DevTools (Ctrl+Shift+I), run a full session | Console shows no unexpected errors |

---

### Interactive Claude Code with the live Obsidian MCP server

The integration suite covers `claude -p` with auth, memory MCP, and filesystem tools. The tests below require the **Obsidian MCP server to be running** (plugin enabled, MCP enabled in settings) — a live setup integration tests cannot replicate.

**Setup:**
1. Container running: sandbox terminal open and healthy
2. Obsidian plugin enabled with MCP turned on (Settings → Agent Sandbox → MCP)
3. Claude authenticated inside the container (see one-time setup above)

#### Available MCP tools are announced

**Actions:** Inside the container: `claude -p "What MCP tools do you have?"`

**Expected:** Response lists `mcp__obsidian__vault_search`, `mcp__obsidian__vault_read`, and other `vault_*` tools.

#### Vault search

**Actions:** `claude -p "Search my vault for [a term that exists in a note]"`

**Expected:** Claude calls `vault_search` and returns file paths with matching snippets.

#### Create a note (Write Scoped tier)

**Actions:** `claude -p "Create a file called agent-workspace/hello.md containing the text Hello world"`

**Expected:** `hello.md` appears under the write directory in Obsidian's file explorer.

#### Open a file in the editor (Navigate tier)

**Setup:** Navigate tier must be enabled in MCP settings.

**Actions:** `claude -p "Open Welcome.md in the editor"`

**Expected:** The file opens as the active tab in Obsidian.

#### Rename a file (Manage tier)

**Setup:** Manage tier must be enabled in MCP settings. A file `test-rename.md` exists.

**Actions:** `claude -p "Rename test-rename.md to test-renamed.md"`

**Expected:** File is renamed in Obsidian; any wikilinks pointing to it are updated.

#### Tier disable removes tools

**Actions:**
1. Disable the "Write Scoped" tier in MCP settings, toggle MCP off then on
2. `claude -p "What MCP tools do you have?"`

**Expected:** `vault_create` and other writeScoped tools no longer appear in the response.

---

### Obsidian close/restart lifecycle

These span process boundaries (full Obsidian close, not `browser.reloadObsidian`).

#### Auto-stop off: container survives Obsidian close

**Setup:** Auto-stop disabled in plugin General settings.

**Actions:** Note the container ID in the status bar, then close Obsidian completely.

**Expected:** `docker ps` still shows `oas-sandbox` running with the same container ID.

#### Auto-stop on: container stops on Obsidian close

**Setup:** Auto-stop enabled in plugin General settings.

**Actions:** Close Obsidian completely.

**Expected:** Container stops within ~10 seconds (`docker ps` shows no `oas-sandbox`).

#### Reopen Obsidian attaches to running container

**Setup:** Auto-stop off, container running.

**Actions:** Close and reopen Obsidian.

**Expected:** Status bar shows Running immediately; same container ID as before.

#### Config change triggers container recreate

**Actions:** Change the Write Directory setting, then click Start (or restart).

**Expected:** A new container ID appears in the status bar (old container was replaced).

#### Plugin disable stops the container

**Actions:** Disable the plugin via Settings → Community Plugins.

**Expected:** Container stops regardless of the auto-stop setting.

#### Settings persist across Obsidian reload

**Actions:**
1. Settings → Agent Sandbox → Terminal → change Font size to 18
2. Close and reopen Obsidian

**Expected:** Settings → Agent Sandbox → Terminal still shows font size 18.

#### Plugin survives disable/enable cycle

**Actions:**
1. Settings → Community Plugins → disable "Agent Sandbox"
2. Re-enable it

**Expected:** Plugin loads cleanly — ribbon icon appears, all 9 commands are registered, no console errors.

---

### Cross-platform edges

#### Windows + WSL: vault path conversion

**Setup:** Windows host, WSL2 Docker mode, vault at `C:\vault`.

**Actions:** Start the container.

**Expected:** Inside the container, `$PKM_VAULT_PATH` resolves to `/mnt/c/vault`; no WSL terminal window flashes during start/stop.

#### Rancher Desktop: path with spaces

**Setup:** Rancher Desktop on Windows, compose path contains a space (e.g. `C:\My Folder\container`).

**Actions:** Start the container.

**Expected:** Container starts without path errors; Windows backslash paths in the compose file resolve correctly.

---

### Sudo password override

**Setup:** Plugin installed, container not yet running.

**Actions:**
1. Set a custom sudo password in Settings → Agent Sandbox → General (Advanced)
2. Click Restart (forces container recreate)
3. Open a terminal, run `sudo echo test` with the new password

**Expected:** `sudo` accepts the new password. Restarting with an empty password effectively disables `sudo`.

---

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes:
# docker compose down -v
```
