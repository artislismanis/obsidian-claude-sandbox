# Testing

The project is covered by three layers of automated tests plus a short manual checklist for things that require human judgment or cross-process workflows. Run the automated suites first — if a behavior is covered, fix the code, don't re-verify by hand.

## Quick reference

```bash
cd plugin
npm install               # one-time, installs all test tooling

npm run test              # Layer 1 — unit tests              (~1.5s,   no deps)
npm run test:integration  # Layer 2 — container integration   (~30s,    needs Docker)
npm run test:e2e          # Layer 3 — real Obsidian UI        (~25s,    needs display / xvfb)
npm run test:e2e:headless # same as above but wrapped in xvfb-run
npm run check             # lint + format:check + tsc + unit tests (run before committing)
```

Exit code `0` means the suite passed. Any non-zero code = one or more failures. Vitest and WebDriverIO both print a per-test summary at the end.

## Prerequisites

### All layers

- **Node.js 20+** and **npm 10+**
- From `plugin/`: `npm install` (installs vitest, wdio, esbuild, eslint, prettier)

### Integration tests (Layer 2)

- **Docker Engine** running and reachable via `docker info`
- **Image built:** `cd container && docker compose build` (or let CI build it)
  - Helpers check for `oas-sandbox:latest` and skip the whole suite if missing
- **Ports 17681 (ttyd) and 38080 (MCP)** free on `127.0.0.1` — the test compose remaps away from production defaults so it can run alongside a live container
- **Optional — Claude Code auth seeding:** to run the `claude-code.test.ts` subsuite you need a live `oas_oas-claude-config` Docker volume. See "Claude Code authentication" below. Without it the Claude tests skip; everything else still runs.

### E2E tests (Layer 3)

- **Obsidian desktop** — `wdio-obsidian-service` downloads it automatically the first time, cached in `plugin/.obsidian-cache/`
- **A display server** — locally any X/Wayland session works; in CI or SSH use `npm run test:e2e:headless` which wraps the runner in `xvfb-run`
- **Built plugin artifacts** — the `pretest:e2e` npm hook runs `npm run build` automatically; `dist/main.js`, `dist/manifest.json`, `dist/styles.css` must exist before the suite launches Obsidian

On first run, wdio will download Obsidian from GitHub releases. If you see a 504 or network error, just retry — the download is resumable and transient GitHub failures are common.

## Running the suites

### Layer 1 — unit tests

```bash
npm run test              # one-shot
npm run test:watch        # vitest watch mode
```

No Docker, no Obsidian, no network. Covers pure logic: validators, shell escaping, ttyd polling, MCP auth + path traversal, tool handlers, status bar state machines. Runs in under 2 seconds and should always pass locally.

Expected output ends with:

```
 Test Files  8 passed (8)
      Tests  184 passed (184)
```

### Layer 2 — integration tests

```bash
npm run test:integration
```

All four integration spec files share **one** container, brought up once by `test/integration/globalSetup.ts` and torn down at the end. This keeps the suite to ~30 seconds. Tests are serialized (`fileParallelism: false`, `sequence.concurrent: false`) to avoid `docker exec` races.

Skip behavior: if Docker isn't running or `oas-sandbox:latest` isn't built, all tests are marked `skipped` and the process exits 0. Look for `[integration] Docker unavailable — tests will skip` in the output.

Expected output ends with:

```
 Test Files  4 passed (4)
      Tests  40 passed (40)
```

Or, when Docker is unavailable:

```
 Test Files  4 skipped (4)
      Tests  40 skipped (40)
```

The test harness uses an isolated Docker Compose project (`oas-test` prefix) so it never touches your real `oas-sandbox` container, volumes, or network.

### Layer 3 — end-to-end (real Obsidian)

```bash
npm run test:e2e             # local dev (needs a display)
npm run test:e2e:headless    # CI / SSH (wraps in xvfb-run)
```

Each spec file launches its own fresh Obsidian instance against an ephemeral copy of `test/e2e/vaults/simple/`. The `wdio-obsidian-service` installs the built `dist/` as a plugin and enables it automatically.

Expected output for a full run:

```
» test/e2e/specs/smoke.e2e.ts
  8 passing
» test/e2e/specs/settings.e2e.ts
  10 passing

Spec Files:	 2 passed, 2 total (100% completed) in 00:00:25
```

To run a single spec file:

```bash
npx wdio run ./wdio.conf.mts --spec test/e2e/specs/settings.e2e.ts
```

Test matrix — set `OBSIDIAN_VERSIONS` to target multiple versions:

```bash
OBSIDIAN_VERSIONS="latest/latest earliest/earliest" npm run test:e2e
```

### Claude Code authentication for integration tests

The Claude Code tests in `test/integration/claude-code.test.ts` need an authenticated subscription. Rather than burning API tokens, they **borrow auth from your live container** if available.

How it works:

1. Your live container's auth lives in the `oas_oas-claude-config` Docker volume (created the first time you run `claude` and complete the login flow inside your real sandbox). The `oas_` prefix is docker-compose's project name.
2. Before running Claude tests, `seedClaudeAuth()` copies this volume into the test project's `oas-test_oas-test-claude-config` volume via a throwaway alpine container.
3. `docker compose down -v` at teardown removes only the test volume — your live auth is never touched and never mutated.

If the live volume doesn't exist (you haven't used Claude inside the sandbox yet), these tests **skip gracefully** rather than fail. To enable them:

```bash
# In your live sandbox (not the test one), authenticate once:
cd container
docker compose up -d
docker compose exec sandbox claude
# Complete the login flow, then exit. Auth is persisted in the volume.
```

After that, `npm run test:integration` will include the four Claude tests (`claude --version`, basic prompt, memory MCP tool use, filesystem `Read` tool).

## Coverage by suite

| Suite | Path | Tests | What's covered |
|-------|------|-------|----------------|
| **Unit** | `src/__tests__/*.test.ts` | 184 | Input validation (write dir, private hosts, memory, CPUs, bind address, port), WSL + Windows shell escaping, WSL path conversion, env var injection, `parseIsRunning` state machine, ttyd polling / URL construction, status bar state transitions, firewall status bar, timing-safe MCP auth, path traversal protection, all 22 MCP tool handlers |
| **Integration** | `test/integration/*.test.ts` | 40 | Container health + `verify.sh`, vault ro/rw mounts + mount isolation, narrow sudo scope + `SUDO_PASSWORD` unset after drop-privileges, MCP env var injection, MCP HTTP auth / routing / CORS, Docker resource naming (`oas-test` prefix), firewall enable / allowlist / disable, tmux session create + list + persist, ttyd port remapping, Claude Code auth + `claude -p` execution + memory MCP tool use + filesystem `Read` tool |
| **E2E** | `test/e2e/specs/*.e2e.ts` | 18 | Plugin loads and is enabled, ribbon icon present, status bar renders, 9 commands registered, 4 settings tabs render, 5 MCP permission tiers visible with correct defaults, MCP token auto-generates and regenerates, font size + scrollback + MCP port validation adds/removes `sandbox-input-error` class, bind address `0.0.0.0` security warning toggles dynamically, per-setting "Requires restart" labels appear on restart-needing settings only |

## What's NOT covered (and why)

Some scenarios can't be reliably automated in this harness:

- **Settings persistence across full Obsidian restart** — `wdio-obsidian-service` uses an ephemeral vault copy per launch, so `data.json` is wiped between sessions. The in-memory save path is covered by validation tests; durable persistence is Obsidian's responsibility.
- **Plugin disable/enable cycle via the UI** — after `disablePluginAndSave`, the service's plugin files are no longer on disk in a re-loadable state, so re-enable fails with ENOENT. This is a harness limitation. Unload cleanup is covered by unit tests on `StatusBarManager.destroy()`, `FirewallStatusBar.destroy()`, etc.
- **Interactive Claude conversations against the plugin's running MCP server** — integration tests cover `claude -p` against memory + filesystem MCP servers, but the plugin's own Obsidian MCP server needs a real Obsidian instance listening. See the manual checklist below.
- **Cross-platform Docker edges (WSL path conversion, Rancher Desktop, Docker Desktop on Windows)** — shell escaping and path conversion are unit-tested, but the full round-trip through `wsl.exe` / Docker Desktop only runs on actual Windows hosts.
- **Visual rendering** — xterm themes, status bar icons, font fallback, terminal resize. Xvfb can't judge "does it look right".

## Interpreting failures

- **Unit failure** → almost always a real bug in the code under test. Stack trace points to the assertion and source line.
- **Integration failure** → usually either (a) the container is unhealthy (check `docker logs oas-test-sandbox`), (b) a port conflict on 17681/38080, or (c) a real regression. The helpers dump container logs + compose status on health-check timeouts.
- **E2E failure** → typically a selector issue (DOM structure changed), a timing issue (bump the `pause()` or `waitForExist` timeout), or the build artifacts are stale (re-run `npm run build`).
- **First-run e2e 504** → GitHub release download for Obsidian failed transiently. Re-run; the launcher retries with exponential backoff and caches on success.

## Running in CI

A typical CI job looks like:

```yaml
- run: cd plugin && npm ci
- run: cd plugin && npm run check          # lint + format + unit
- run: cd container && docker compose build
- run: cd plugin && npm run test:integration
- run: cd plugin && npm run test:e2e:headless
```

Cache `plugin/.obsidian-cache/` by the key printed at the start of an e2e run (`obsidian-cache-key: [...]`).

---

## Manual-only checklist

These require human judgment, interactive LLM use, cross-process workflows, or environment-specific hardware that can't be reproduced in the automated harness.

### Environment prerequisites (one-time per machine)

- [ ] WSL2 with Docker Engine and mirrored networking, OR Rancher Desktop / Docker Desktop with dockerd
- [ ] `http://localhost:7681` reachable from both Obsidian and a host browser
- [ ] Plugin installed in Obsidian vault (copy `dist/` to `.obsidian/plugins/obsidian-agent-sandbox/`)

> Claude Code authentication inside the container is **automatically verified** by the integration suite whenever the live `oas_oas-claude-config` volume exists. See "Claude Code authentication" above for the one-time login.

### Visual rendering

- [ ] Terminal themes: Follow Obsidian / Dark / Light all look correct
- [ ] Custom font family renders when installed on system
- [ ] Status bar icons (⏹/⏳/▶/⚠/🔍, 🛡️) display correctly
- [ ] Terminal resize: drag pane edge, content reflows cleanly
- [ ] No unexpected errors in Obsidian DevTools (Ctrl+Shift+I) during a full session

### Interactive Claude Code against the live Obsidian MCP server

The integration suite covers `claude -p` against memory and filesystem MCP servers. These manual tests cover the **plugin's own Obsidian MCP server** (which only listens when the real plugin is running in Obsidian).

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

### Human-in-the-loop review modals

Unit tests cover that every reviewed-tier write calls `reviewFn` and aborts on rejection, but the **modal's actual rendering** can only be judged by a human.

#### Content diff preview renders correctly

**Setup:** `writeReviewed` tier on. A file `notes/example.md` with at least 5 lines of content exists.

**Actions:** Inside the container: `claude -p "Modify notes/example.md: change line 3 to 'EDITED'."`

**Expected:** A modal appears with `Review: Modify file` as the title. The diff area shows:
- Unchanged context lines prefixed `  ` (two spaces).
- The old line prefixed `- ` in red.
- The new line prefixed `+ ` in green.
- Scroll works if the diff is taller than the panel.

Approve → file is modified. Reject → file is untouched; Claude receives "Change rejected by user."

#### Frontmatter review shows JSON diff

**Setup:** `writeReviewed` on. File `notes/fm.md` with frontmatter `{ status: "draft" }`.

**Actions:** `claude -p "Set frontmatter 'tags' to ['a', 'b'] on notes/fm.md"`

**Expected:** Modal title is `Review: Set frontmatter`. Diff shows JSON-stringified old vs new FM (not the full file body). Approve → FM is set correctly, body untouched.

#### Rename/move/delete shows affected-links list

**Setup:** `writeReviewed` and `manage` tiers both on. `notes/old.md` has two other notes linking to it.

**Actions:** `claude -p "Rename notes/old.md to notes/new.md"`

**Expected:** Modal title is `Review: Rename file`. Description reads `Rename notes/old.md → notes/new.md`. Below the description, a list appears headed `2 note(s) link here:` listing both backlink paths. No content diff (rename doesn't change content).

Approve → file renamed; backlinks automatically updated by `fileManager.renameFile`.

#### Batch review checkboxes

**Setup:** `writeReviewed` on. Three notes tagged `#test`.

**Actions:** `claude -p "Use vault_batch_frontmatter to set property status=review on all files matching '#test' (dryRun false)."`

**Expected:** `BatchReviewModal` appears listing all three paths with checkboxes (default on). Uncheck one. Click **Approve selected**. Only the two checked files get the frontmatter update; the unchecked one is untouched.

---

### Activity feedback

#### Tab title + status bar update on Claude state

**Setup:** Container running. Open a sandbox terminal, attach to a named session (e.g. `work`). Inside, start `claude`.

**Actions:**
1. Submit a long-running prompt in Claude.
2. Wait for Claude to finish.

**Expected:**
- While Claude is working: tab title shows `⚙ Session: work`.
- While Claude is idle (between prompts): tab title shows `Session: work`.
- When Claude hits its "waiting for input" notification state: tab title shows `❓ Session: work` and the sandbox status-bar pill grows a `⚠` badge with tooltip "1 session awaiting input: work".

Close and reopen Obsidian → badge clears (activity is ephemeral).

#### Multiple sessions track independently

**Setup:** Two named sessions open (`work` and `research`), both running `claude`.

**Actions:** Submit a prompt in `work`, leave `research` idle.

**Expected:** Only `work`'s tab title gets the `⚙` prefix. `research` stays plain. Badge count reflects only sessions awaiting input.

#### Hook script fails silently when MCP is off

**Setup:** Toggle MCP off in Settings. Attach to a session, open a terminal.

**Actions:** `bash .claude/hooks/notify-status.sh awaiting_input`

**Expected:** The script exits 0. No error messages. No plugin crash.

---

### Plugin API integrations (extensions tier)

Unit tests stub each target plugin's API. **Real-plugin interaction** needs a vault with the target plugin installed.

#### Dataview query returns real DQL results

**Setup:** `extensions` tier on. Dataview plugin installed + enabled. A few notes with frontmatter `rating`.

**Actions:** `claude -p "Run DQL: TABLE rating FROM \"\" SORT rating DESC LIMIT 5"`

**Expected:** Claude calls `vault_dataview_query` and returns a JSON object with `headers` and `values` — the same data Dataview would render in a code block.

With Dataview disabled, the tool should not appear in `tools/list`.

#### Tasks toggle updates the file with recurring handling

**Setup:** `extensions` on. Tasks plugin installed + enabled. A note containing a recurring task, e.g. `- [ ] weekly thing 🔁 every week 📅 2026-04-19`.

**Actions:** `claude -p "Toggle the task at notes/recurring.md line 5"`

**Expected:** `vault_tasks_toggle` delegates to `apiV1.executeToggleTaskDoneCommand`. The file now contains both the completed original and the next occurrence (per Tasks' recurring behaviour).

#### Templater creates from a template

**Setup:** `extensions` on. Templater installed + enabled. A template at `Templates/daily.md`.

**Actions:** `claude -p "Create a note from Templater template Templates/daily.md named 2026-04-19 in folder Daily"`

**Expected:** A new file `Daily/2026-04-19.md` exists with the template's content rendered (Templater's own tag expansion fires).

#### Periodic Notes resolves + creates

**Setup:** `extensions` on. Periodic Notes installed, daily notes configured with folder `Daily` and format `YYYY-MM-DD`.

**Actions:**
1. `claude -p "What's the path of today's daily note?"` — expect Claude to use `vault_periodic_note` with `periodicity=daily`. If today's note exists it says "Exists: ..."; otherwise error "Not found".
2. `claude -p "Create today's daily note if missing"` — expect `vault_periodic_note` with `create=true` to succeed.

**Expected:** Path matches the plugin's configured folder + date format. The template (if any) is seeded into the new file.

#### Canvas read/modify round-trips

**Setup:** `extensions` on. Create a canvas `board.canvas` in the vault via Obsidian UI with 2 nodes + 1 edge.

**Actions:**
1. `claude -p "Show me the JSON structure of board.canvas"` — `vault_canvas_read` returns the canvas document.
2. `claude -p "Add a text node with id 'n3' to board.canvas"` — `vault_canvas_modify` writes the file.

**Expected:** Opening `board.canvas` in Obsidian shows the new node. No target plugin required — this is Obsidian's native JSON format.

#### Discovery tool reports available integrations

**Actions:** `claude -p "List the plugin_extensions available"`

**Expected:** `plugin_extensions_list` returns a line per integration with `enabled` / `not available` / `always (native format)`. Matches the actual plugin-enabled state.

---

### Symlink path resolution

Unit tests cover `isRealPathWithinBase` with mocked realpath. **Real filesystem** verification requires creating an actual symlink.

#### Read of escaping symlink is denied

**Setup:** Container running, MCP on. Inside the vault (from a host shell):

```bash
cd <vault-root>
ln -s /etc/hosts evil.md
```

**Actions:** `claude -p "Read the file evil.md"`

**Expected:** `vault_read` returns "File not found." (symlink resolution detected the escape). The real `/etc/hosts` is never returned.

Delete the symlink afterwards: `rm <vault-root>/evil.md`.

#### Create into symlinked directory is denied

**Setup:** Inside the vault, create a symlinked dir:

```bash
ln -s /tmp escape
```

**Actions:** `claude -p "Create a file escape/note.md with 'hi' content"`

**Expected:** `vault_create` returns "Path resolves outside the vault (symlink)."

Cleanup: `rm <vault-root>/escape`.

---

### Firewall allowlist extension

Manual because it involves container network state.

#### Plugin-setting domain reaches host

**Setup:** `Additional firewall domains` = `example.com`. Restart container. Enable firewall.

**Actions:** In a terminal: `curl -I https://example.com`

**Expected:** Returns `HTTP/2 200`. A domain NOT in the allowlist (e.g. `curl -I https://example.org`) times out or is blocked by iptables.

#### Host file entry works + isn't visible to Claude

**Setup:** Edit `container/firewall-extras.txt` to add a line `internal.corp.example`. Restart container.

**Actions:**
1. In a terminal: `curl -I https://internal.corp.example` — reaches the host.
2. `claude -p "Read the file /etc/oas/firewall-extras.txt"` — must fail (path outside `/workspace`).

**Expected:** Route works; the source file is not reachable from Claude.

#### --list-sources tags origins

**Actions:** In a terminal: `sudo /usr/local/bin/init-firewall.sh --list-sources`

**Expected:** Output lines prefixed with `[baseline]`, `[plugin]`, `[file]` matching the three configured sources. Settings tab's **Effective allowlist** (Refresh button) displays the same content.

---

### URI handlers + context menu

#### obsidian:// open-terminal

**Actions:** Paste `obsidian://agent-sandbox/open-terminal` into a browser URL bar (or trigger from an OS launcher).

**Expected:** Obsidian focuses and opens a new terminal tab. Requires container running — otherwise a Notice explains it's not running.

#### obsidian:// analyze

**Actions:** `obsidian://agent-sandbox/analyze?path=notes/foo.md&template=summarize`

**Expected:** Obsidian opens a new terminal. After Claude starts, the first line typed is the summarize template with `@notes/foo.md` substituted.

#### Context menu: Analyze in Sandbox

**Actions:** Right-click a vault note → **Analyze in Sandbox** → pick a template.

**Expected:** New terminal opens; Claude starts with the templated prompt as its initial argument.

With `workspace/.claude/prompts/` empty, the submenu collapses to a single **Custom prompt…** item that opens a modal — entering text and clicking Run injects a one-off prompt.

---

### Container improvements

#### Out-of-band container recreation detected

**Setup:** Container running.

**Actions:** From a host shell: `cd container && docker compose down && docker compose up -d` (recreates the container out of the plugin's control).

**Expected:** Within 30 s (next health poll), a Notice appears: "Sandbox container was recreated outside the plugin. Terminal sessions may be disconnected; reopen to reconnect." Open terminal tabs are detached.

#### Port conflict pre-flight

**Setup:** Occupy the MCP port before starting:

```bash
nc -l 28080 &
```

**Actions:** Click **Sandbox: Start Container**.

**Expected:** A Notice "Port conflict: 28080 already in use on 127.0.0.1. Stop the other process or change the port in settings." The container does NOT start.

Kill the `nc` process, retry — start succeeds.

#### Clean up empty sessions

**Setup:** Create two tmux sessions, attach to one in Obsidian, leave the other detached.

**Actions:** Command palette → **Sandbox: Clean up empty sessions**.

**Expected:** Modal lists only the detached session. Uncheck it to keep; check it to kill. Click **Kill selected**. Notice confirms `1/1 killed`.

---

### Agent output notices

#### Debounced notice on burst creation

**Setup:** `Notify on agent output` = `new`. Container running.

**Actions:** `claude -p "Create three files under agent-workspace/: a.md b.md c.md each with just 'x'."`

**Expected:** A single Notice appears ~2 s after the last create: "Agent output: 3 created" (not three separate notices). Further creates within 5 s are suppressed (rate limit).

Toggle setting to `new_or_modified` → subsequent `vault_modify` calls also fire notices. Toggle to `off` → no notices.

---

### Session switcher

**Setup:** Three terminal tabs open, two with session names, one without.

**Actions:** Command palette → **Sandbox: Switch to Sandbox session…**.

**Expected:** Modal lists all three (`Session: work`, `Session: research`, `Session: (unnamed)`). Typing filters the list. Enter or click activates the matching tab.

---

### Terminal polish

#### Clipboard auto-copy opt-out

**Setup:** Terminal open with some output.

**Actions:**
1. `Settings → Agent Sandbox → Terminal → Auto-copy on selection` = off.
2. Select text in the terminal with mouse drag.

**Expected:** Clipboard is NOT overwritten. `Ctrl+C` after selection still copies (that's xterm.js's explicit copy).

#### Connection retry with exponential backoff

**Setup:** Stop the container (`docker compose down`). Open a terminal tab in Obsidian (will fail to connect).

**Actions:** Observe the loading status.

**Expected:** Message updates like `Connecting to terminal… (attempt 2/15, retry in 0.8s)`. Intervals grow up to 5s. Starting the container mid-retry → connection establishes and the terminal renders.

#### Startup progress indicator

**Setup:** Obsidian closed, container stopped.

**Actions:** Open Obsidian. Watch the status bar tooltip.

**Expected:** Detail cycles through "Starting: checking Docker availability…" → "Starting: probing WSL (5s fast-fail)…" → "Starting: probing container status…" → (if auto-start) "Starting: docker compose up -d (auto-start)…".

---

### Release automation

#### Check workflow runs on PRs

**Setup:** CI workflows pushed to `main` (requires a PAT with `workflow` scope).

**Actions:** Open a PR changing any file under `plugin/src/`.

**Expected:** `plugin check` workflow runs, reports green. Modifications to other paths don't trigger it.

#### Release workflow produces signed assets

**Setup:** Maintainer ready to cut `0.2.0` per `docs/how-to/release.md`.

**Actions:**

```bash
cd plugin
npm version 0.2.0
git push && git push --tags
```

**Expected:** `release` workflow runs; tag-vs-manifest check passes; build succeeds; a pre-release GitHub Release `0.2.0` appears with `main.js` + `manifest.json` + `styles.css` attached. `npm version` left the working tree clean (no stale uncommitted changes after `version-bump.mjs` ran).

#### BRAT install from Release

**Setup:** Clean Obsidian profile (no plugins). BRAT installed.

**Actions:** **BRAT: Add a beta plugin for testing** → paste the repo URL.

**Expected:** BRAT downloads the three assets from the latest Release. **Community plugins → enable Agent Sandbox**. Plugin loads; settings tab renders; ribbon icon appears.

---

### Post-review bug fixes (from `/review` follow-up)

Manual verification of behaviour that was fixed after the S1–S6 refactor round.

#### Attention-badge tooltip clears when sessions return to idle

**Setup:** `writeReviewed` + `agent` tiers on (agent is always on). Two terminal sessions `a` and `b` attached.

**Actions:**
1. In session `a`, trigger Claude to emit `awaiting_input` (e.g. ask a question that requires approval).
2. Hover the sandbox status-bar pill — tooltip should read "Sandbox running. 1 session(s) awaiting input: a".
3. In session `a`, answer the question so the agent transitions back to `idle`.
4. Hover the sandbox status-bar pill again.

**Expected:** The `⚠` badge is gone and the tooltip has reverted to the default running-tooltip (container/MCP/firewall status). Pre-fix it kept the stale "1 session(s) awaiting input: a" text until something else overwrote it.

Also check that toggling MCP off via **Sandbox: Toggle MCP Server** while a session is `awaiting_input` clears the badge AND the tooltip.

#### Agent output notices don't drop under bursts

**Setup:** `agentOutputNotify` = `new`. Container running.

**Actions:** Within a ~3 s window, have Claude create ~5 files under `$PKM_WRITE_DIR` across two separate invocations (so the second batch lands inside the 5 s rate-limit window after the first notice).

**Expected:**
- First batch surfaces a Notice ~2 s after the last create (e.g. "Agent output: 3 created").
- Second batch arriving inside the rate-limit window is **not** lost. About 5 s after the first notice, a second Notice appears reporting the batched remainder (e.g. "Agent output: 2 created").

Pre-fix: the second batch was silently dropped.

#### "Analyze in Sandbox" submenu shows templates on first open

**Setup:** `workspace/.claude/prompts/` populated with the four shipped templates. Fresh Obsidian reload.

**Actions:** Immediately after Obsidian finishes loading, right-click a vault note → **Analyze in Sandbox**.

**Expected:** Submenu shows all configured template labels (Summarize, Critique, Explain, Extract TODOs, plus "Custom prompt…"). Pre-fix the first right-click often showed only "Custom prompt…" because the async template load raced against menu render.

#### Session picker handles tabs closed mid-session

**Setup:** Two terminal tabs open with distinct session names.

**Actions:**
1. Run **Sandbox: Switch to Sandbox session…**.
2. While the modal is open, type to filter so both rows are visible.
3. Close one of the tabs (`Ctrl+W` or tab X) from a different pane **without** dismissing the modal.
4. Click the row for the now-closed tab.

**Expected:** A Notice "That session has closed." appears. The modal closes cleanly. No crash or stale leaf activation.

#### MCP tool calls with malformed arguments return a clear error

**Setup:** Container running, MCP on.

**Actions:** Via an MCP client (or inside Claude Code), invoke a tool with a deliberately wrong argument type, e.g. `vault_search` with `{ "query": 123 }` or `vault_read` with `{}` (no file / path).

**Expected:** The tool returns an `isError: true` result with a message starting `Invalid arguments:` followed by the zod validation detail. Pre-`defineTool`, these would silently cast to `undefined` and downstream handlers would hit confusing errors like "File not found" for a missing path.

Valid calls behave identically to before — schema validation is a guard, not a new gate.

#### Failed tmux kills are logged

**Setup:** Two empty tmux sessions. One of them has a name with a character that tmux will reject (e.g. you manually `docker compose exec sandbox tmux rename-session -t X "weird\x00name"` outside the normal flow).

**Actions:** Run **Sandbox: Clean up empty sessions** → check both → Kill selected.

**Expected:** The valid one is killed; the invalid one's failure is logged to DevTools console (`[Agent Sandbox] failed to kill tmux session '...':`). The aggregate Notice reports `1/2 session(s)` killed instead of silently omitting the failure.

---

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes:
# docker compose down -v
```

The integration harness cleans up its own `oas-test-*` resources automatically via `globalSetup.ts`, even on crash — so you don't normally need to touch test containers/volumes manually. If something gets wedged:

```bash
docker rm -f oas-test-sandbox
docker volume rm oas-test_oas-test-claude-config oas-test_oas-test-shell-history
docker network rm oas-test_default
```
