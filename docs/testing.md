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

The Claude Code tests in `test/integration/claude-code.test.ts` need an authenticated subscription. Rather than burning API tokens, they **borrow auth from your live container** if available:

1. The live container's auth is in the `oas-claude-config` Docker volume (created when you first run `claude` and log in inside your real sandbox)
2. Before running Claude tests, the helper copies this volume to the test's `oas-test_oas-test-claude-config` volume
3. `docker compose down -v` at teardown removes the test volume — your live auth is untouched

If the live volume doesn't exist (you haven't used Claude inside the sandbox yet), these tests **skip gracefully** rather than fail. To enable them:

```bash
# In your live sandbox (not the test one), authenticate once:
docker compose -f container/docker-compose.yml up -d
docker compose -f container/docker-compose.yml exec sandbox claude
# Follow the auth flow, exit. Auth is now persisted in oas-claude-config volume.
```

After that, `npm run test:integration` will run the Claude -p tests.

| Suite | Covers |
|-------|--------|
| **Unit** (`src/__tests__/`) | Validation, shell escaping, tool handlers, auth, path traversal, status bar, polling |
| **Integration** (`test/integration/`) | Container health, verify.sh, vault mounts (ro/rw), mount isolation, sudo model, MCP env vars, MCP HTTP auth/routing, naming consistency, firewall, tmux sessions, port remapping |
| **E2E** (`test/e2e/specs/`) | Plugin loads, ribbon icon, commands registered, settings tabs render, MCP tier toggles, token generation/regeneration, validation fields (font size, scrollback, port), bind address warning, restart labels, settings persistence across reload, disable/enable cycle |

---

## Manual-only tests

These require human judgment, interactive LLM use, cross-process workflows, or environment-specific hardware that can't be reproduced in CI.

### Environment prerequisites (one-time per machine)

- [ ] WSL2 with Docker Engine and mirrored networking
- [ ] OR Rancher Desktop / Docker Desktop with dockerd engine
- [ ] Claude Code subscription authenticated inside container
- [ ] `http://localhost:7681` reachable from both Obsidian and a host browser

### Visual rendering

- [ ] Terminal themes: Follow Obsidian / Dark / Light look correct
- [ ] Custom font family renders when installed on system
- [ ] Status bar icons (⏹/⏳/▶/⚠/🔍, 🛡️) display correctly
- [ ] Terminal resize: drag pane edge, content reflows cleanly
- [ ] No unexpected errors in Obsidian DevTools (Ctrl+Shift+I) during a full session

### Interactive Claude Code

- [ ] `claude` authenticates via subscription
- [ ] "What MCP tools do you have?" → lists `mcp__obsidian__vault_*` tools
- [ ] "Search my vault for [term]" → calls `vault_search`, returns results
- [ ] "Create agent-workspace/test.md" → file appears in Obsidian
- [ ] "Open Welcome.md" (Navigate tier) → file opens in editor
- [ ] "Rename X to Y" (Manage tier) → file renamed, wikilinks updated
- [ ] Disable a tier, toggle MCP off/on → Claude no longer sees those tools

### Obsidian close/restart lifecycle

These span process boundaries (closing Obsidian entirely, not just `browser.reloadObsidian`).

- [ ] Auto-stop off: close Obsidian → container still running on host
- [ ] Reopen Obsidian → status bar shows Running instantly, same container ID
- [ ] Auto-stop on: close Obsidian → container stops within 10s
- [ ] Config change triggers recreate: change write dir, Start → new container ID
- [ ] Plugin disable → container stops regardless of auto-stop setting

### Cross-platform edges

- [ ] **Windows + WSL**: vault at `C:\vault` becomes `/mnt/c/vault` in WSL
- [ ] **Windows + WSL**: no WSL terminal window flashes on start/stop
- [ ] **Rancher Desktop**: path with spaces works (`C:\My Folder\container`)
- [ ] **Rancher Desktop**: Windows backslash paths resolve in compose

### Sudo password override

- [ ] Plugin setting overrides container/.env password — restart required, new password works
- [ ] Empty password effectively disables sudo

---

## Teardown

```bash
cd container
docker compose down
# To also remove named volumes:
# docker compose down -v
```
