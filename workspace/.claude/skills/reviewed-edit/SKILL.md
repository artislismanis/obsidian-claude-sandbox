---
name: reviewed-edit
description: Make safe edits to vault files outside the writable workspace directory using human-in-the-loop review. Use when the user asks to edit an existing note that lives outside $PKM_WRITE_DIR, or explicitly says "review before applying".
---

# reviewed-edit

Out-of-workspace writes require the `writeReviewed` tier — each change triggers a diff modal in Obsidian and won't apply until the user approves. This skill describes how to plan and sequence those writes so the user gets a useful review experience.

## When to use

- User asks you to modify a file that isn't under `$PKM_WRITE_DIR`.
- User says "ask me before writing" or similar.
- You're doing a rename/move/delete (always high-risk).

## Prerequisites

- `writeReviewed` tier enabled in Obsidian plugin settings. If not enabled, the `_reviewed` tools won't be registered — offer to proceed in the workspace dir instead, or ask the user to enable the tier.
- Look up `$PKM_WRITE_DIR` via the shell (`echo $PKM_WRITE_DIR`) before deciding whether a path is in-scope.

## Tool selection

Content-write ops register a `_reviewed` variant when the `writeReviewed` tier is on; that variant calls the review modal before applying:

| Operation | Tool |
|---|---|
| New file | `vault_create_reviewed` |
| Full rewrite | `vault_modify_reviewed` |
| Append at end | `vault_append_reviewed` |
| Prepend at top (post-frontmatter) | `vault_prepend_reviewed` |
| Edit frontmatter property | `vault_frontmatter_set_reviewed` / `vault_frontmatter_delete_reviewed` |
| Find/replace within one file | `vault_search_replace_reviewed` |
| Targeted insert at heading/line | `vault_patch_reviewed` |

Manage-tier ops (rename / move / delete / create-folder / batch-frontmatter) keep their plain names — there is no `_reviewed` suffix. They are reviewed implicitly when both the `manage` tier and `writeReviewed` are enabled; each call surfaces a review modal showing the affected backlinks (or, for `vault_batch_frontmatter`, a per-item batch modal):

| Operation | Tool |
|---|---|
| Rename a file | `vault_rename` |
| Move a file | `vault_move` |
| Delete a file | `vault_delete` |
| Create a folder | `vault_create_folder` |
| Batch-set frontmatter across many files | `vault_batch_frontmatter` |

**Never** use the non-reviewed content-write variant for out-of-workspace paths — the server blocks it via the `writeScoped` guard, but `writeVault` (if enabled) would silently bypass review.

## Pre-write checklist

Before any `_reviewed` call:

1. **Confirm target.** If the user gave a note name, use `vault_file_info` to resolve it to a path — don't guess.
2. **Check blast radius.** For any rename / delete / large modify, run `vault_backlinks` first. Tell the user how many notes link in. Don't silently break outbound references.
3. **Narrow the change.** Prefer `vault_search_replace` or `vault_patch` (small diff) over `vault_modify` (full rewrite) so the review modal shows minimal change surface.
4. **Chunk per-file.** Each tool call produces one modal. If you have five files to edit, that's five modals in sequence — warn the user upfront.

## During the chain

- Expect an error result with text "Change rejected by user." when the user cancels. Treat it as a hard stop — don't retry, don't try a different tool.
- If the user approves the first call but rejects the second, stop and summarize what was applied.
- After every approved write, confirm to the user (e.g. "Modified notes/foo.md (42 bytes → 58 bytes)") so they have an audit trail beyond the modal.

## Frontmatter review

`vault_frontmatter_set_reviewed` and `vault_frontmatter_delete_reviewed` show the review modal with JSON-stringified old/new frontmatter rather than the full file diff. That's intentional — the actual file mutation goes through Obsidian's `processFrontMatter` which re-serializes YAML, so previewing the exact YAML would lie. Mention this in your explanation if the user asks why the diff looks like JSON.

## Example

User: "Add `status: draft` to the frontmatter of notes/manuscript.md."

```
1. vault_file_info(path="notes/manuscript.md")  // confirm the file exists
2. (no backlinks check — FM change doesn't affect links)
3. vault_frontmatter_set_reviewed(
     path="notes/manuscript.md",
     property="status",
     value="draft"
   )
   → modal shows { ... } vs { ..., status: "draft" }
4. User approves → "Set status on notes/manuscript.md"
```

For a multi-file change:

```
User: "Add `reviewed: true` to every note in projects/Q4/."

Me: "I'll need to do this one file at a time since each one requires your approval. Projects/Q4/ has 14 .md files — that's 14 modals. Want to proceed, or would a batch-with-dryrun approach work? (vault_batch_frontmatter has a preview mode.)"
```
