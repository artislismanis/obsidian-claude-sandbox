# How to use multiple terminals

Every **Open Sandbox Terminal** creates an independent tab with its own WebSocket connection. You can run as many as you like.

## Typical layout

- **Tab 1** — a long-lived tmux session (`work`) with Claude Code doing your main task.
- **Tab 2** — an ad-hoc shell for running one-off commands (`ls`, `find`, `grep`).
- **Tab 3** — another tmux session (`research`) running a second Claude conversation.

Obsidian tabs can be tiled horizontally or vertically — right-click a tab → **Split vertically / horizontally**.

## Tracking activity

With the `agent` tier on (default), each Claude Code session reports its state via the `notify-status.sh` hook. Each tab's title updates:

- `Session: work` — idle
- `⚙ Session: work` — Claude is working
- `❓ Session: work` — Claude is waiting for your input

The status-bar sandbox pill grows a `⚠` badge with tooltip listing any sessions awaiting input — so you can tell from any Obsidian pane which tab needs attention.

## Switching quickly

**Sandbox: Switch to Sandbox session…** opens a filterable picker listing all open terminal tabs. Type to narrow, Enter to activate.

Bind it to a hotkey for one-keystroke context switching: **Settings → Hotkeys** → search "Switch to Sandbox".

## Independent vs shared state

- **WebSocket** connections are independent per tab.
- **tmux sessions** are shared — two tabs attached to the same session name see the same terminal state.
- **Claude Code state** (memory, auth, recent chats) is shared across all sessions in the container via the `oas-claude-config` volume.

## Detaching / reattaching without killing

Inside a tmux-attached tab, press `Ctrl+B D` to detach. The tab goes blank; you can close it. Next time you open that session name, you reattach to the same running process.
