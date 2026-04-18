# Roadmap

## Phase 1: Stabilize & Polish (Current)

Bug fixes and UX improvements identified during testing.

### Bug Fixes
- [x] Surface real error messages in backgroundStartup() and healthCheck()
- [x] Fix Local Docker mode on Windows / Rancher Desktop
- [x] Fix MCP path traversal vulnerability
- [x] Fix MCP timing-safe auth, body size limit, error handling

### UX Quick Wins
- [ ] Terminal font size setting (hardcoded to 14)
- [ ] Auto-start container when opening terminal (instead of error notice)
- [ ] Per-setting restart labels (replace blanket warning)
- [ ] Bind address security warning when set to 0.0.0.0
- [ ] Compose path validation on input (check docker-compose.yml exists)
- [ ] Terminal scrollback size setting (hardcoded to 10000)

## Phase 2: Release Automation (BRAT)

Enable managed beta testing via Obsidian BRAT.

- [ ] Create `plugin/versions.json`
- [ ] Create `plugin/version-bump.mjs` (syncs manifest.json + versions.json)
- [ ] Create `plugin/.npmrc` (tag-version-prefix="")
- [ ] Create `.github/workflows/release.yml` (build + GitHub Release on version tags)
- [ ] Create `.github/workflows/check.yml` (lint + test on PRs touching plugin/)
- [ ] Add `"version"` script to plugin/package.json
- [ ] First BRAT-compatible release

## Phase 3: Documentation (Diátaxis)

Restructure docs for beta tester audience using the Diátaxis framework.

### Tutorials (learning, practical)
- [ ] `docs/tutorials/getting-started.md` — first-time setup through running Claude
- [ ] `docs/tutorials/first-agent-task.md` — walk through a real Claude + vault task

### How-to Guides (working, practical)
- [ ] `docs/how-to/install-via-brat.md`
- [ ] `docs/how-to/configure-firewall.md`
- [ ] `docs/how-to/persistent-sessions.md`
- [ ] `docs/how-to/use-multiple-terminals.md`
- [ ] `docs/how-to/add-tools-to-container.md`
- [ ] `docs/how-to/customize-workspace.md`
- [ ] `docs/how-to/update-plugin.md`

### Reference (working, theoretical)
- [ ] `docs/reference/commands.md`
- [ ] `docs/reference/settings.md`
- [ ] `docs/reference/keyboard-shortcuts.md`
- [ ] `docs/reference/docker-resources.md`
- [ ] `docs/reference/project-structure.md`

### Explanation (learning, theoretical)
- [ ] Move `docs/architecture.md` → `docs/explanation/architecture.md`
- [ ] `docs/explanation/security-model.md`
- [ ] `docs/explanation/container-lifecycle.md`
- [ ] `docs/explanation/design-decisions.md`

### README
- [ ] Add GIF/screenshot of core workflow at top
- [ ] Slim down — move detailed sections into docs/ tree
- [ ] Add link grid to docs/ structure

## Phase 4: MCP Server Enhancements

Extend the MCP server with deeper Obsidian integration. Patterns informed by existing ecosystem projects (aaronsb/obsidian-mcp-plugin, cyanheads/obsidian-mcp-server, coddingtonbear/obsidian-local-rest-api, kepano/obsidian-skills).

### Surgical Editing (inspired by Local REST API + cyanheads)
Current tools only support full-file read/modify/append. Add targeted operations:
- [ ] `vault_search_replace` — find and replace within a file (regex support, case sensitivity flag)
- [ ] `vault_patch` — insert content relative to a heading, block reference, or line number
- [ ] `vault_prepend` — prepend content after frontmatter
- [ ] `vault_frontmatter_delete` — remove a frontmatter property

### Graph & Knowledge Tools (inspired by aaronsb)
Current link tools are flat lookups. Add depth:
- [ ] `vault_graph_neighborhood` — all notes within N hops of a file
- [ ] `vault_graph_path` — shortest link path between two notes
- [ ] `vault_graph_clusters` — find densely connected note groups
- [ ] `vault_search_fuzzy` — fuzzy search using Obsidian's prepareFuzzySearch
- [ ] `vault_properties` — list all properties across vault with counts
- [ ] `vault_recent` — recently modified files (sorted by mtime)

### Plugin API Integrations (inspired by aaronsb + enhanced server)
Access capabilities of other installed Obsidian plugins via `app.plugins.getPlugin()`:
- [ ] `vault_dataview_query` — execute DQL queries (requires Dataview)
- [ ] `vault_templater_create` — create note from template (requires Templater)
- [ ] `vault_tasks_query` — list/filter tasks with date and priority parsing (requires Tasks)
- [ ] `vault_tasks_toggle` — toggle task status by file + line reference
- [ ] `vault_periodic_note` — access daily/weekly/monthly notes (requires Periodic Notes)
- [ ] `vault_canvas_read` — read canvas structure as JSON
- [ ] `vault_canvas_modify` — add/remove nodes and edges
- [ ] New **Extensions** permission tier for plugin-dependent tools
- [ ] Graceful handling when target plugin is not installed

### Workflow & Context (inspired by aaronsb)
Higher-level tools that combine multiple operations:
- [ ] `vault_context` — return current note + backlinks + outgoing links + frontmatter in one call
- [ ] `vault_suggest_links` — find notes that could be linked based on content overlap
- [ ] `vault_batch_frontmatter` — set/delete a property across multiple files matching a query

### Security Hardening (inspired by aaronsb's security model)
- [ ] Path-based allowlists/blocklists (protect specific folders)
- [ ] Rate limiting per tool
- [ ] Operation audit log (log MCP tool calls for user review)
- [ ] Symlink resolution in path validation

### Format Awareness
Obsidian markdown conventions (wikilinks, callouts, embeds, properties) are handled separately via kepano/obsidian-skills packaged as standalone skills — not part of this plugin's core.

### Infrastructure
- [ ] MCP server status in status bar tooltip
- [ ] Auto-restart MCP server on tier setting changes
- [ ] Health check endpoint for container to verify MCP is alive
- [ ] In-memory cache for vault-wide operations with metadata-change invalidation
- [ ] Configurable response size limits per tool

### Human-in-the-Loop Review (new permission tier)
A **Write (reviewed)** tier where every vault write pauses for human approval in Obsidian before executing. Claude proposes a change, a diff modal appears in Obsidian, user approves or rejects, Claude gets the result.
- [ ] `DiffReviewModal` — Obsidian Modal showing file path, old vs new content (unified diff), Approve/Reject buttons. Returns a Promise resolved by button click (same async pattern as existing `promptSessionName()`)
- [ ] New **Write (reviewed)** permission tier — sits between Write Scoped and Write Vault. All writes through this tier route through the review modal regardless of path
- [ ] Wire into `addWriteTools()` factory — reviewed-tier tools call the modal before executing the vault operation
- [ ] Review modal for frontmatter changes — show property name + old/new value
- [ ] Review modal for file creation — show proposed path + content (no "old" side)
- [ ] Review modal for rename/move/delete — show operation description + affected links
- [ ] Batch review option — queue multiple proposed changes, review all at once
- [ ] Audit trail — log approved/rejected operations to a file for later review

## Phase 5: UX & Integration Depth

Deeper Obsidian integration and workflow improvements.

### Obsidian Integration
- [ ] File context menu → "Analyze in Sandbox" (right-click a note)
- [ ] Agent output sync (watch agent-workspace/ for new files, notify user)
- [ ] URI handler (`obsidian://agent-sandbox/open-terminal`)
- [ ] Quick Switcher integration for terminal tabs

### Container Improvements
- [ ] Container ID verification (prevent connecting to wrong container)
- [ ] Port conflict pre-flight check
- [ ] Firewall state polling (detect out-of-band changes)
- [ ] Session cleanup / garbage collection for stale tmux sessions

### Terminal Polish
- [ ] Clipboard auto-copy opt-out setting
- [ ] Connection retry with exponential backoff
- [ ] Startup progress indicator (elapsed time or step description)

## Phase 6: Community Plugin Submission

Prepare for the official Obsidian community plugin directory.

- [ ] Remove `--prerelease` flag from release workflow
- [ ] Ensure manifest.json meets community requirements
- [ ] Final documentation pass
- [ ] Submit PR to `obsidianmd/obsidian-releases`
- [ ] Add root-level manifest.json if required by community review
- [ ] Respond to review feedback

## Completed

- [x] Windows Local Docker mode (buildLocalWindowsCommand)
- [x] MCP server with granular vault permissions (22 tools, 5 tiers)
- [x] MCP security hardening (path traversal, timing-safe auth, body limit, try-catch)
- [x] MCP settings tab (4th tab with server config + permission toggles)
- [x] MCP manual testing checklist (sections 21-30)
- [x] Code review and simplification (/simplify pass)
- [x] Surface real error messages in Docker error handlers

## Ecosystem References

Projects studied for patterns, tool design, and best practices:

| Project | Stars | What we borrowed |
|---------|-------|-----------------|
| [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | 24.8k | Format-aware tooling (packaged separately as standalone skills) |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | 3.4k | Simplicity-first tool design |
| [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) | 2.1k | Surgical editing patterns, PATCH operations |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | 456 | Search-replace, frontmatter management, caching |
| [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin) | 283 | Graph traversal, Dataview integration, security model, workflow hints |
