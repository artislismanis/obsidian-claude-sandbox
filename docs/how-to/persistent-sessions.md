# How to keep Claude sessions alive across Obsidian restarts

The container itself survives Obsidian restarts (unless **Auto-stop on exit** is on). But terminal tabs in Obsidian don't automatically reattach — they're WebSocket connections tied to the Obsidian process.

The workaround: **use named tmux sessions** so closing a tab doesn't kill your work.

## Named session workflow

1. **Sandbox: Open Sandbox Session…** → enter a name (e.g. `work`, `research`, `debug`).
2. A terminal opens inside tmux session `work`. Inside it, run Claude Code or whatever you like.
3. Close the Obsidian tab. The tmux session keeps running.
4. Later — Obsidian re-opened, container still running — run **Sandbox: Open Sandbox Session…** with the same name. You re-attach, Claude's context intact.

## Picking up multiple sessions

The status-bar sandbox pill's right-click menu shows all live tmux sessions. Click to attach. Or use **Sandbox: Switch to Sandbox session…** for a filterable picker.

## Cleanup

Unattached sessions pile up. **Sandbox: Clean up empty sessions** lists candidates with per-row checkboxes — kill exactly the ones you don't want.

## Configuration

- Sessions live in the container at `/home/claude/.tmux/` and share the `oas-shell-history` volume so command history persists across container rebuilds.
- If the container restarts, tmux sessions are gone. That's the only way to lose them.
- No auto-GC is shipped — you decide when to clean up.

## Why not just restore tabs automatically?

Obsidian persists view state across restarts, including terminal-tab session names. The plugin could try to reattach automatically. We don't — reattach happens when you click, so you don't unexpectedly wake up idle Claude Code instances after every restart. The "named session workflow" above is explicit by design.
