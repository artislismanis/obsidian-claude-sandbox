# CLAUDE.md — Workspace (your domain)

This is Claude's configurable workspace inside the Agent Sandbox container. Everything under `workspace/` on the host is mounted at `/workspace/` inside the container, read-write. You can freely create, edit, and delete files here.

## What lives here

| Path | Purpose |
|------|---------|
| `.claude/settings.json` | Claude Code project settings (permission mode, env, experiments) |
| `.claude/settings.local.json` | Per-machine overrides (gitignored) |
| `.claude/skills/` | Project skills (if present) |
| `.claude/agents/` | Sub-agents (if present) |
| `.claude/commands/` | Slash commands (if present) |
| `.mcp.json` | MCP server configuration (memory, etc.) |
| `CLAUDE.md` | This file — workspace rules |
| `vault/` | Obsidian vault overlay (read-only, see below) |
| `vault/$PKM_WRITE_DIR/` | Writable vault subfolder (see `$PKM_WRITE_DIR` env var, default `agent-workspace`) |
| `vault/.oas/` | Vault infrastructure — memory file, writable (independent of write dir) |

## Extensibility tiers — inline reference

Three places configuration and capabilities can live. Put new things in the right tier:

1. **Tier 1 — repo-managed (this folder, `workspace/`)**
   Capabilities shared by everyone using the sandbox. Lives in git, flows back via PR. Examples: project skills you want teammates to inherit, MCP server declarations, permission defaults, Obsidian-vault-specific methodology.

2. **Tier 2 — user-persistent (`/home/claude/.claude/`, named volume `oas-claude-config`)**
   Personal session state that survives container rebuilds but is not in git. Examples: Claude Code auth, per-user preferences, drafts, session history. Safe to write here for personal continuity.

3. **Tier 3 — local overrides (`.claude/settings.local.json`, gitignored)**
   Per-machine tweaks that override Tier 1 without polluting the shared config. Examples: a developer-specific API key override, a local-only MCP server URL.

**Promotion path**: something useful starts in Tier 2 or Tier 3; once you want to share it, promote to Tier 1 via a git commit in `workspace/`.

## Vault write rules

The vault at `/workspace/vault/` is **read-only** at the filesystem level. The only writable path inside the vault is `/workspace/vault/$PKM_WRITE_DIR/` (the `PKM_WRITE_DIR` env var is set by the plugin; run `echo $PKM_WRITE_DIR` or `verify.sh` to see the current value).

- Read vault files freely from anywhere under `vault/`
- Writes to `vault/` outside the write directory will fail with "Read-only file system" — this is by design
- Create/edit/delete files only inside `vault/$PKM_WRITE_DIR/`
- Never delete vault files without explicit user confirmation
- Prefer non-destructive operations: create new files or append rather than overwriting
- For bulk operations, describe scope and show a sample (3-5 files) before executing

## Agent write workflow

You can only create or edit files inside `vault/$PKM_WRITE_DIR/`. If you are unsure where this points, run `verify.sh` and look for the writable vault subfolder mount.

All vault work — inbox processing, content creation, note editing — follows the same pattern:

1. **Read** the source file(s) anywhere in the vault
2. **Write** new or modified content into `vault/$PKM_WRITE_DIR/`
3. **Describe** where the file should ultimately live (target folder, filename) so the user can move it into place on the host

When editing an existing vault note, copy it to `vault/$PKM_WRITE_DIR/` first, make changes there, and tell the user which original file it replaces. Never assume a previous session's files still exist in the write directory — check first.

## Memory — MCP knowledge graph

**Override the built-in file-based auto memory system.** Do NOT write to `/home/claude/.claude/projects/-workspace/memory/`. Use the MCP memory server (`mcp__memory__*` tools) for all persistent memory.

Storage is automatically per-vault — the plugin injects `MEMORY_FILE_PATH` pointing to `/workspace/vault/.oas/memory.json`, so each mounted vault gets its own isolated knowledge graph. No manual configuration needed.

### When to save

Follow the same triggers as the built-in memory types — user info, feedback, project context, references — but store them as **entities and observations** in the MCP knowledge graph instead of markdown files.

### Entity conventions

| Entity type | Use for | Example entity name |
|-------------|---------|---------------------|
| `user` | The human — identity, role, preferences | `Artis` |
| `feedback` | Behavioral guidance from the user | `feedback-no-summaries` |
| `project` | Ongoing work, goals, decisions | `auth-rewrite` |
| `reference` | Pointers to external resources | `ref-linear-ingest` |
| `concept` | Domain knowledge, vault topics | `zettelkasten-method` |

- **Entity names**: short, lowercase-kebab-case (except proper nouns).
- **Observations**: individual facts attached to an entity. Prefer many small observations over one large blob — they can be independently deleted.
- **Relations**: link entities in active voice (e.g., `Artis -> owns -> auth-rewrite`).

### How to query

- Use `search_nodes` when looking for something specific.
- Use `read_graph` sparingly — only when you need a broad overview.
- Verify graph facts against current state before acting on them (same staleness rule as file-based memory).

### What NOT to save

Same exclusions as the built-in system: no code patterns derivable from reading files, no git history, no ephemeral task details, no duplicating CLAUDE.md content.

## Discovering the environment

To see what's installed and how the container is wired, run:

```bash
verify.sh
```

This prints tool versions, mount points (with rw/ro flags), environment variables, privilege state, and Node globals. It is the source of truth — do not rely on memorized lists that may drift from the actual image.

## Installing tools at runtime

| Tool type | How | Persists across container rebuild? |
|-----------|-----|----|
| Node global package | `npm install -g <pkg>` | Yes — global prefix is in the `oas-claude-config` named volume |
| Python package | `uv pip install <pkg>` or `pipx install <pkg>` | Depends on target; uv's default env is user-space |
| System package (apt) | **Ask the human.** See below. | No — Dockerfile changes required |

### Why you cannot install system packages yourself

The `claude` user has narrow sudo for `apt-get`/`apt` only, and it is password-gated. The password is set at container start from a host-side environment variable that is not visible to you — `entrypoint.sh` unsets it before dropping privileges. This is intentional: system-level installs should be deliberate human actions, not side effects of an agent turn.

If you need a system package:

1. Tell the human what you need and why in one sentence.
2. If it's a one-off experiment, the human can run `sudo apt-get install <pkg>` in an interactive ttyd session with the password from their plugin settings.
3. If it proves useful, the human promotes it to `container/Dockerfile` in a reviewable PR.

## Long-running tasks — persistent shells

ttyd SIGHUPs the PTY on WebSocket close, so anything running in a regular terminal dies when the user closes Obsidian or the tab. If you're about to run something that may outlive an Obsidian session (a long loop, watch mode, a multi-minute build, a research task), wrap it in a persistent shell:

```bash
# Type this as the first command in the tab, then run Claude /
# whatever inside. The bash you're sitting in is a child of a tmux
# session that survives WebSocket drops.
session work       # or any name: research, tests, loop, ...

# Then inside the persistent shell:
claude -p "long task here"
```

List what's alive with `sessions`. Reattach with `session <name>` again (idempotent). Detach explicitly with `Ctrl-\`, or implicitly by closing the tab or Obsidian.

Multiple clients can attach to the same named session simultaneously and see live-synced output — useful if the user wants to watch a running task from both Obsidian and a browser pointed at ttyd.

Sessions are ephemeral across container restarts. If the user asks to persist something across container rebuilds, let them know that's a "clean slate" operation by design.

## Git operations

You **cannot run git** from inside the container. The monorepo `.git` lives above the mount boundary and is not visible here. All commits to `workspace/` happen on the host.

- Edit files freely; they appear as unstaged changes on the host
- Describe each change clearly (what file, what changed, why) so the human can review the diff before committing
- To "undo" a change you made earlier in this session, re-edit the file — you cannot `git checkout`
- If the human needs to discard everything you did: `git restore workspace/` on the host
- For GitHub context (browse PRs, read issues, view history), use the pre-installed `gh` CLI — it works over HTTPS without needing local git

## What you cannot see

The `container/` folder (Dockerfile, docker-compose.yml, entrypoint.sh, scripts) is **not mounted inside the container**. You have no way to read or modify infra files from here. If a build-time question comes up, either run `verify.sh` to observe the live state or ask the human to share the relevant file.
