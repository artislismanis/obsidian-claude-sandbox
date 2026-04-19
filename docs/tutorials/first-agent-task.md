# Tutorial: your first agent task

You've got the container running and Claude Code is up in a terminal. Now let's actually use it.

This tutorial walks through three real tasks on a small vault. Each shows a different capability and the MCP tools behind it.

## Setup

Create two notes in your vault:

**`notes/raft.md`**:
```
# Raft Consensus

Leader-based consensus algorithm. Uses a randomized election timeout to
elect a single leader per term. Log entries committed via majority
replication. See [[notes/paxos]] for the earlier algorithm this builds
on.

#distsys #algorithms
```

**`notes/paxos.md`**:
```
# Paxos

Classic consensus algorithm. Two phases: Prepare, Accept. Safe but
difficult to implement correctly. Multi-Paxos generalizes to a
replicated log.

#distsys #algorithms
```

## Task 1: research

Start Claude and ask:

> What do my notes say about consensus? Use the research-topic skill.

What happens:
1. Claude loads the `research-topic` skill (shipped in `workspace/.claude/skills/`).
2. It calls `vault_search(query="consensus")` — finds both notes.
3. It calls `vault_context(path="notes/raft.md")` and `vault_context(path="notes/paxos.md")` — one MCP call each returns content + frontmatter + tags + backlinks.
4. It synthesizes a short summary and cites both note paths.

Observe the `⚙ Session: work` / idle prefix on your terminal tab as Claude transitions states.

## Task 2: add a scoped note

> Based on those two notes, create a summary at `agent-workspace/consensus-summary.md` linking to both.

Claude uses `vault_create(path="agent-workspace/consensus-summary.md", content=...)`. The path is inside `$PKM_WRITE_DIR`, so it succeeds without any review modal — that's the `writeScoped` tier doing its job.

Check the file appeared. Also check that Obsidian shows a Notice "Agent created agent-workspace/consensus-summary.md" (the agent-output sync feature).

## Task 3: enable reviewed writes

So far Claude hasn't been able to touch the original `notes/raft.md` or `notes/paxos.md` — they're read-only at the filesystem level outside `$PKM_WRITE_DIR`. To allow edits there with your approval:

**Settings → Agent Sandbox → MCP → Escalations → Write (reviewed)** → on. Restart the MCP server (prompt appears).

Now in Claude:

> Add a "Related" section to notes/raft.md linking to notes/paxos.md.

Claude calls `vault_modify_reviewed(path="notes/raft.md", content=...)`. A modal pops up in Obsidian with the unified diff. **Approve** → the file is modified. **Reject** → nothing changes, Claude receives an error result.

The review modal is the human-in-the-loop gate. Every reviewed-tier write (modify, append, prepend, patch, search_replace, frontmatter_set, frontmatter_delete, create, rename, move, delete) flows through it.

## Task 4: analyze from context menu

Right-click `notes/raft.md` in Obsidian's file explorer → **Analyze in Sandbox** → **Summarize**.

A new terminal tab opens, Claude starts with the templated prompt injected:

> Please summarize @notes/raft.md in 3–5 concise bullet points…

Templates live in `workspace/.claude/prompts/`. Shipped: `summarize`, `extract-todos`, `critique`, `explain`. Add your own — each `.md` file becomes a menu entry.

## Troubleshooting

- **Claude doesn't see vault files**: check the status bar shows `▶ Running` and the container logs (`docker compose logs sandbox`) show ttyd listening. Try **Sandbox: Container Status**.
- **MCP tools don't work from Claude**: MCP must be on (MCP tab → MCP enabled), and the Claude Code config inside the container needs the MCP server configured. Check `workspace/.mcp.json`.
- **Review modal doesn't appear**: `writeReviewed` tier must be on. Restart the MCP server after toggling.

## What's next?

- `how-to/persistent-sessions.md` — keep Claude sessions alive across Obsidian restarts.
- `how-to/use-multiple-terminals.md` — run multiple independent agent conversations.
- `reference/commands.md` — the full set of plugin commands.
