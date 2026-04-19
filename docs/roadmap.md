# Roadmap

## Phase 1: Stabilize & Polish (Current)

Bug fixes and UX improvements identified during testing.

### Bug Fixes
- [x] Surface real error messages in backgroundStartup() and healthCheck()
- [x] Fix Local Docker mode on Windows / Rancher Desktop
- [x] Fix MCP path traversal vulnerability
- [x] Fix MCP timing-safe auth, body size limit, error handling

### UX Quick Wins
- [x] Terminal font size setting (hardcoded to 14)
- [x] Auto-start container when opening terminal (instead of error notice)
- [x] Per-setting restart labels (replace blanket warning)
- [x] Bind address security warning when set to 0.0.0.0
- [x] Compose path validation on input (check docker-compose.yml exists)
- [x] Terminal scrollback size setting (hardcoded to 10000)

## Phase 2: Release Automation (BRAT)

Enable managed beta testing via Obsidian BRAT.

- [x] Create `plugin/versions.json` (maps plugin version → minAppVersion)
- [x] Create `plugin/version-bump.mjs` (syncs manifest.json + versions.json on `npm version`)
- [x] Create `plugin/.npmrc` (`tag-version-prefix=""` so `npm version 0.2.0` tags as `0.2.0`, not `v0.2.0`)
- [x] Create `.github/workflows/release.yml` (build + GitHub Release on version tags; verifies tag matches manifest.json; uploads main.js / manifest.json / styles.css)
- [x] Create `.github/workflows/check.yml` (lint + format + type-check + tests on PRs touching plugin/)
- [x] Add `"version"` script to plugin/package.json
- [ ] First BRAT-compatible release — bump to 0.2.0, push the tag, verify the Release and BRAT install against a clean Obsidian profile

## Phase 3: Documentation (Diátaxis)

Restructure docs for beta tester audience using the Diátaxis framework.

### Tutorials (learning, practical)
- [x] `docs/tutorials/getting-started.md` — first-time setup through running Claude
- [x] `docs/tutorials/first-agent-task.md` — walk through a real Claude + vault task

### How-to Guides (working, practical)
- [x] `docs/how-to/install-via-brat.md`
- [x] `docs/how-to/configure-firewall.md`
- [x] `docs/how-to/persistent-sessions.md`
- [x] `docs/how-to/use-multiple-terminals.md`
- [x] `docs/how-to/add-tools-to-container.md`
- [x] `docs/how-to/customize-workspace.md`
- [x] `docs/how-to/update-plugin.md`

### Reference (working, theoretical)
- [x] `docs/reference/commands.md`
- [x] `docs/reference/settings.md`
- [x] `docs/reference/keyboard-shortcuts.md`
- [x] `docs/reference/docker-resources.md`
- [x] `docs/reference/project-structure.md`

### Explanation (learning, theoretical)
- [x] Moved `docs/architecture.md` → `docs/explanation/architecture.md`
- [x] `docs/explanation/security-model.md`
- [x] `docs/explanation/container-lifecycle.md`
- [x] `docs/explanation/design-decisions.md`

### README
- [ ] Add GIF/screenshot of core workflow at top (follow-up — needs capture)
- [x] Slim down — moved detailed sections into docs/ tree
- [x] Added link grid to docs/ structure (Diátaxis quadrants)

## Phase 4: MCP Server Enhancements

Extend the MCP server with deeper Obsidian integration. Patterns informed by existing ecosystem projects (aaronsb/obsidian-mcp-plugin, cyanheads/obsidian-mcp-server, coddingtonbear/obsidian-local-rest-api, kepano/obsidian-skills).

### Surgical Editing (inspired by Local REST API + cyanheads)
- [x] `vault_search_replace` — find and replace within a file (regex support, case sensitivity flag)
- [x] `vault_patch` — insert content relative to a heading or line number
- [x] `vault_prepend` — prepend content after frontmatter
- [x] `vault_frontmatter_delete` — remove a frontmatter property

### Graph & Knowledge Tools (inspired by aaronsb)
- [x] `vault_graph_neighborhood` — all notes within N hops of a file
- [x] `vault_graph_path` — shortest link path between two notes
- [x] `vault_graph_clusters` — find densely connected note groups
- [x] `vault_search_fuzzy` — fuzzy search using Obsidian's prepareFuzzySearch (score-sorted)
- [x] `vault_properties` — list all properties across vault with counts
- [x] `vault_recent` — recently modified files (sorted by mtime)

### Plugin API Integrations (inspired by aaronsb + enhanced server)
Access capabilities of other installed Obsidian plugins via `app.plugins.getPlugin()`. All tools land in `plugin/src/mcp-extensions.ts` under a single `registerExtensionTools()` entry point.
- [x] `vault_dataview_query` — execute DQL queries (requires Dataview)
- [x] `vault_templater_create` — create note from template (requires Templater; delegates to `create_new_note_from_template`)
- [x] `vault_tasks_query` — list/filter tasks with date and priority parsing (installed-Tasks-gated; parses Tasks-format shorthand ourselves)
- [x] `vault_tasks_toggle` — toggle task status by file + line reference (delegates to `apiV1.executeToggleTaskDoneCommand`)
- [x] `vault_periodic_note` — access daily/weekly/monthly notes (requires Periodic Notes; computes path from plugin settings)
- [x] `vault_canvas_read` — read canvas structure as JSON
- [x] `vault_canvas_modify` — add/remove nodes and edges (cascades edges on node removal)
- [x] New **Extensions** permission tier for plugin-dependent tools (wiring + settings only)
- [x] Graceful handling when target plugin is not installed — structural (tool absent from `tools/list`) rather than runtime error. `plugin_extensions_list` tool surfaces which integrations are live.

### Workflow & Context (inspired by aaronsb)
- [x] `vault_context` — return current note + backlinks + outgoing links + frontmatter in one call
- [x] `vault_suggest_links` — find notes that could be linked based on content overlap
- [x] `vault_batch_frontmatter` — set/delete a property across multiple files matching a query

### Security Hardening (inspired by aaronsb's security model)
- [x] Path-based allowlists/blocklists (protect specific folders)
- [x] Rate limiting per tool (token-bucket, 60/min reads, 20/min writes)
- [x] Operation audit log (in-memory ring buffer, GET /mcp/audit endpoint)
- [x] Review guard covers all 8 write operations (was create+modify only — silent bypass via append/patch/search_replace/frontmatter/prepend closed)
- [x] Capability tiers vs escalation tiers — settings UI split; `read`/`writeScoped` always-on when MCP enabled, gated toggles for `writeReviewed`/`writeVault`/`navigate`/`manage`/`extensions`
- [x] Symlink resolution in path validation (`isRealPathWithinBase` with `FileSystemAdapter.realpathSync`, applied to reads + create paths + folder creation)

### Format Awareness
Obsidian markdown conventions (wikilinks, callouts, embeds, properties) are handled separately via kepano/obsidian-skills packaged as standalone skills — not part of this plugin's core.

### Infrastructure
- [x] MCP server status in status bar tooltip
- [x] Auto-restart MCP server on tier setting changes
- [x] Health check endpoint (GET /mcp/health)
- [x] In-memory cache for vault-wide operations with metadata-change invalidation (VaultCache)
- [x] Configurable response size limits per tool (500KB, auto-truncate)

### Human-in-the-Loop Review (new permission tier)
- [x] `DiffReviewModal` — Obsidian Modal showing file path, operation type, unified diff with colored additions/removals, Approve/Reject buttons
- [x] `computeUnifiedDiff()` — lightweight line-by-line diff algorithm
- [x] New **Write (reviewed)** permission tier — sits between Write Scoped and Write Vault
- [x] Wire into `addWriteTools()` factory — reviewed-tier tools call reviewFn before executing
- [x] Review modal for file creation — show proposed path + content
- [x] Review modal for file modification — show old vs new content diff
- [x] Review modal for append/prepend/patch/search_replace — full-file diff preview
- [x] Review modal for frontmatter set/delete — JSON-stringified old vs new frontmatter preview
- [x] `WriteOperation` union type replaces stringly-typed operation; modal shows human labels
- [x] `runWrite` helper — structural review gate that makes bypass impossible to reintroduce
- [x] Review modal for rename/move/delete — `affectedLinks` list (backlinks), wired via `runWrite` on all three manage handlers
- [x] Batch review option — `BatchReviewModal` with per-item checkboxes; `vault_batch_frontmatter` uses it when `writeReviewed` is enabled
- [x] File-based audit trail — append-only JSONL at `vault/.oas/mcp-audit.jsonl` with 1 MB single-generation rotation; `GET /mcp/audit` still returns the in-memory ring buffer

### Skills (workflow guidance)
Curated skills living under `workspace/.claude/skills/` that teach Claude how to chain MCP tools for common vault tasks.
- [x] `research-topic` — discovery via `vault_search` → `vault_context` → `vault_graph_neighborhood`
- [x] `link-hygiene` — `vault_unresolved` + `vault_orphans` + `vault_suggest_links` + fix loop
- [x] `reviewed-edit` — safe out-of-workspace writes via `_reviewed` tools
- [x] `tag-audit` — `vault_tags` + `vault_properties` → merge/rename via `vault_search_replace`
- [x] `daily-review` — `vault_recent` + `vault_context` for "what did I work on this week"
- [x] `note-refactor` — `vault_backlinks` pre-check before rename/move/delete

## Phase 5: UX & Integration Depth

Deeper Obsidian integration and workflow improvements.

### Obsidian Integration
- [x] File context menu → "Analyze in Sandbox" submenu listing prompt templates; custom-prompt modal when templates dir is empty.
- [x] Agent output sync — `vault.on("create"|"modify")` scoped to the write dir, debounced 2 s / rate-limited 5 s, configurable via `agentOutputNotify` setting (new | new_or_modified | off).
- [x] URI handler — `obsidian://agent-sandbox/open-terminal` and `obsidian://agent-sandbox/analyze?path=&template=`.
- [x] Quick-Switcher-style session picker — `Sandbox: Switch to Sandbox session…` command opens a filterable modal listing open terminal tabs.

### Container Improvements
- [x] Container ID verification — captures `docker compose ps -q sandbox` on start/restart; drift detected on health poll triggers a Notice and detaches terminal leaves so they reopen against the new container.
- [x] Port conflict pre-flight — `docker.checkPortConflicts` test-binds ttyd + MCP ports on the ttyd bind address before `docker compose up -d`; aborts with an actionable Notice listing the offending ports.
- [x] Firewall state refresh (detect out-of-band changes) — event-driven on focus / status-bar hover / container-state transitions, plus 5-min safety-net poll; replaced the prior unconditional 30s exec
- [x] Stale tmux session cleanup — `Sandbox: Clean up empty sessions` command lists unattached sessions with per-row checkboxes and kills only the selected ones. No auto-cleanup by design.

### Firewall allowlist expansion
The container's `init-firewall.sh` allowlist stays minimal by default (Anthropic, GitHub, npm, PyPI, CDNs, apt mirrors). Per-user expansion via two additive routes: a plugin setting and a host-managed config file.
- [x] Plugin setting `additionalFirewallDomains` (validated domain list) → `OAS_ALLOWED_DOMAINS` env var tagged `[plugin]`.
- [x] Host-managed `container/firewall-extras.txt` mounted read-only at `/etc/oas/firewall-extras.txt`, tagged `[file]`. Invisible to Claude.
- [x] `init-firewall.sh --list-sources` inspects the effective allowlist grouped by origin; displayed in plugin Security tab (Refresh button) and `verify.sh`. No override semantics — all sources additive.
- [x] `docs/how-to/configure-firewall.md` documents the three sources, when to use each, and skip-worktree for keeping personal edits out of git.

### Activity feedback
Inspired by Windows Terminal's Claude Code status icon — show the user whether Claude is working or waiting for input without them having to look at the terminal tab.
- [x] MCP-based transport: new `agent_status_set` tool in always-on `agent` tier. No new filesystem contract, reuses existing MCP auth/audit path.
- [x] Per-tab title prefix (`⚙ Session: x` working, `❓ Session: x` awaiting input). Each `TerminalView` routes its own session updates via `setActivityPrefix`.
- [x] Generic status-bar attention badge (`⚠`) + tooltip listing affected sessions when ≥1 session is `awaiting_input`.
- [x] Claude Code hook integration: `workspace/.claude/hooks/notify-status.sh` called from `UserPromptSubmit` / `Stop` / `Notification` hooks in `settings.json`.
- [ ] Optional audible or tray notification when Claude transitions to "awaiting input" after a long-running task (deferred to a follow-up).

### Terminal Polish
- [x] Clipboard auto-copy opt-out setting — `clipboardAutoCopy` (default on) gates `onSelectionChange` handler in TerminalView.
- [x] Connection retry with exponential backoff — 500 ms × 1.5ⁿ capped at 5 s, max 15 attempts (was fixed 1 s × 30). Retry UI surfaces the current wait (`attempt 3/15, retry in 1.1s`).
- [x] Startup progress indicator — status-bar detail cycles through "checking Docker availability… → probing WSL… → probing container status… → docker compose up -d (auto-start)…" instead of a static "checking".

## Phase 6: Community Plugin Submission

Prepare for the official Obsidian community plugin directory.

- [ ] Remove `--prerelease` flag from release workflow
- [ ] Ensure manifest.json meets community requirements
- [ ] Final documentation pass
- [ ] Submit PR to `obsidianmd/obsidian-releases`
- [ ] Add root-level manifest.json if required by community review
- [ ] Respond to review feedback

## Remaining items across phases

Quick rollup so it's easy to see what's actually left:

- **Phase 2:** cut the first BRAT-compatible release (`npm version 0.2.0` + push tags; follow `docs/how-to/release.md`).
- **Phase 3:** capture a GIF/screenshot of the core workflow for the README.
- **Phase 5 Activity feedback:** optional audible or tray notification on transitions to `awaiting_input` (deferred follow-up).
- **Phase 6:** all six items — follows Phase 2 stabilisation and beta feedback.

Everything else on the roadmap is delivered.

## Completed

- [x] Windows Local Docker mode (buildLocalWindowsCommand)
- [x] MCP server with granular vault permissions (22 tools, 5 tiers)
- [x] MCP security hardening (path traversal, timing-safe auth, body limit, try-catch)
- [x] MCP settings tab (4th tab with server config + permission toggles)
- [x] MCP manual testing checklist (sections 21-30)
- [x] Code review and simplification (/simplify pass)
- [x] Surface real error messages in Docker error handlers
- [x] CRLF line ending fix (.gitattributes eol=lf for shell scripts, Dockerfile, etc.)
- [x] host.docker.internal routing for Rancher Desktop / WSL2 (OAS_HOST_IP via os.networkInterfaces)
- [x] MCP stdio→HTTP proxy: per-request connectivity probe with 30s positive cache
- [x] Container firewall: auto-allow MCP port to host.docker.internal
- [x] E2E test selector fixes (XPath replacing invalid :has() CSS selectors)
- [x] Test automation documentation (docs/testing.md — three layers, prerequisites, coverage)
- [x] Phase 1 UX Quick Wins: font size, scrollback, auto-start prompt, per-setting restart labels, bind address warning, compose path validation
- [x] Phase 4H MCP simplification pass: tier restructure (capabilities vs escalations), review-bypass fix across 8 write handlers, `runWrite` + `forEachMarkdownChunked` helpers, VaultCache wired into link graph, ttyd protocol enum cleanup, `addWriteTools` config object, event-driven firewall refresh, status-bar change detection, vault_search/suggest_links/batch_frontmatter chunked parallelism
- [x] Full skill set: `research-topic`, `link-hygiene`, `reviewed-edit`, `tag-audit`, `daily-review`, `note-refactor`
- [x] `/simplify` S1–S6 series: `McpServerConfig.hooks` consolidation; inline modal/settings styles → CSS classes; `ActivityUi` + `AgentOutputNotifier` extracted to `src/activity.ts`; `AnalyzeManager` extracted to `src/analyze.ts`; `showSessionPicker` + `showSessionCleanup` extracted to `src/session-ui.ts`; `defineTool` helper wraps all tool registrations in runtime zod parsing for typed handler args.
- [x] Post-review bug fixes: `ActivityUi` tooltip reset on attention-count 1→0 (and on `clear()`); `AgentOutputNotifier` re-arms debounce under rate-limit instead of dropping buffered events; `AnalyzeManager` pre-warms template cache at onload so context-menu submenu has no async-after-render race; `showSessionPicker` re-queries leaves per render + revalidates at click; `VIEW_TYPE_TERMINAL` moved to `src/view-types.ts` so activity/session-ui are importable from tests without xterm.
- [x] Tests grown from 233 → 326 (review coverage, tier derivation, chunked early-exit, cache invalidation, `agent_status_set` + ActivityUi transitions + AgentOutputNotifier debounce/rate-limit + AnalyzeManager template loading/caching/substitution, symlink path validation, batch-review, rename/move/delete affectedLinks, Canvas/Dataview/Tasks/Templater/Periodic-Notes integration handlers).

## Ecosystem References

Projects studied for patterns, tool design, and best practices:

| Project | Stars | What we borrowed |
|---------|-------|-----------------|
| [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | 24.8k | Format-aware tooling (packaged separately as standalone skills) |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | 3.4k | Simplicity-first tool design |
| [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) | 2.1k | Surgical editing patterns, PATCH operations |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | 456 | Search-replace, frontmatter management, caching |
| [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin) | 283 | Graph traversal, Dataview integration, security model, workflow hints |
