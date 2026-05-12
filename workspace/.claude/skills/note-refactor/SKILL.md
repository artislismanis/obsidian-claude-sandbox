---
name: note-refactor
description: Safely rename, move, or delete notes with full awareness of incoming links. Use when the user asks to rename/move/delete a note, reorganize folders, or any structural vault change where breaking backlinks would be a problem.
---

# note-refactor

Structural vault changes — rename, move, delete — are the highest-risk operations. A careless delete silently orphans every link that pointed at it. This skill makes the blast radius visible before acting and uses the review modal when available.

## When to use

- "Rename notes/foo.md to notes/bar.md."
- "Move these to projects/archive/."
- "Delete this note."
- "Reorganize my inbox."

## Prerequisites

- The `manage` tier must be enabled for rename/move/delete tools to be available.
- If `writeReviewed` is also enabled, each operation pops a review modal showing the affected backlinks. You don't need to call `vault_backlinks` separately in that case — but doing so up front gives the user a chance to abort without seeing the modal per file.
- Before chaining manage-tier tools, call `mcp__obsidian__mcp_capabilities` to confirm `manage` (and, if you plan to lean on the modal, `writeReviewed`) are actually on for this session. Tier toggles change per-vault and per-user — never assume from tool *name* presence alone.

## Tool chain

### Phase 1 — Understand the blast radius

For each target file:

1. **`vault_backlinks`** on the target. Report the count to the user.
2. If count is > 5, list the backlink paths — the user may want to eyeball them before agreeing.
3. If the file is an index/hub note with many backlinks, recommend archiving (rename to `archive/`) instead of deleting.

### Phase 2 — Propose and confirm

Write the plan before touching anything:

```
Refactor plan:
  notes/foo.md → notes/archive/foo.md  (move; 7 backlinks will auto-update)
  notes/draft.md → DELETE               (2 backlinks; unresolved afterward)
  notes/old-idea.md → DELETE            (0 backlinks; safe)
```

Obsidian's `fileManager.renameFile` rewrites wikilinks automatically on rename/move — the backlinks don't break, they update. Deletes are different: backlinks to a deleted file become unresolved.

For any delete with backlinks, either:
- Rewrite the linking notes first (`vault_search_replace` to remove or repoint the links), or
- Warn the user and proceed only on explicit approval.

### Phase 3 — Apply

- **Rename:** `vault_rename` with `name: "new-name"`. Extension preserved if omitted.
- **Move:** `vault_move` with `to: "destination/folder"`. Filename is preserved.
- **Delete:** `vault_delete`. Sends to the user's configured trash via `app.vault.trash` — that's the system trash when the platform supports it, otherwise Obsidian's per-vault `.trash/` folder. Either way it is recoverable, but don't promise a specific destination.

If `writeReviewed` is enabled, each call surfaces a review modal with the affected-links list. Expect the user to approve or reject per operation.

### Phase 4 — Verify

1. **`vault_unresolved`** — confirm no new broken links appeared. If the list grew, the delete phase broke something.
2. For renames/moves, spot-check one backlinking note with `vault_read` to confirm the wikilink was updated.

## Rules

- **Never delete a file with backlinks without per-file user approval**, even in batch mode.
- **Never use `_anywhere` (writeVault) variants for structural changes.** Use the `manage` tier's `vault_rename` / `vault_move` / `vault_delete`, which respect path filters and trigger review.
- **Archive before delete** when unsure. `vault_move` to `archive/` is always reversible; `vault_delete` is not.
- For a bulk reorganize, do one logical group at a time — don't queue 50 renames before the first has been verified.

## Example

```
User: "Delete notes/old-meeting.md."

1. vault_backlinks(path="notes/old-meeting.md")
   → ["notes/project-plan.md", "notes/action-items.md"]
   Report: 2 backlinks. Proceed?

2. User: "Yes, but update the backlinks to point at notes/meetings-archive.md instead."

3. For each backlinking file, vault_search_replace:
     vault_search_replace(
       path="notes/project-plan.md",
       search="[[old-meeting]]",
       replace="[[meetings-archive]]"
     )
   (If writeReviewed enabled, each replace pops a modal.)

4. vault_delete(path="notes/old-meeting.md")
   (Review modal: "Delete notes/old-meeting.md. No other notes link here.")

5. vault_unresolved → confirm no new broken links.
```
