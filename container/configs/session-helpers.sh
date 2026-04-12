#!/usr/bin/env bash
# Persistent shell sessions via tmux. Sourced from ~/.bashrc.
#
# Wrap a bash in a tmux session so whatever runs inside survives
# ttyd disconnects AND supports multiple simultaneous viewers
# (e.g. Obsidian terminal + browser pointed at ttyd). Sessions
# die on container restart/rebuild — matching the lifecycle
# contract documented in README.
#
# Usage:
#   session <name>        Enter (create or reattach to) a named
#                         persistent shell. Inside it, run anything.
#                         Detach with Ctrl-\ or by closing the
#                         terminal / Obsidian (WebSocket drop is
#                         an implicit detach, not a kill).
#                         Works whether or not you're already
#                         inside a tmux session.
#   sessions              List active persistent sessions.

session() {
    if [ -z "$1" ]; then
        echo "usage: session <session-name>" >&2
        echo "active sessions:" >&2
        tmux list-sessions 2>/dev/null || echo "  (no sessions)" >&2
        return 1
    fi
    # Ensure the target session exists (no-op if already there).
    tmux has-session -t "$1" 2>/dev/null || tmux new-session -d -s "$1"
    if [ -n "$TMUX" ]; then
        # Already inside tmux — tmux refuses to nest, so use
        # switch-client to swap sessions cleanly from the current
        # attached client. No "sessions should be nested" error.
        tmux switch-client -t "$1"
    else
        # Not inside tmux — plain attach.
        tmux attach-session -t "$1"
    fi
}

sessions() {
    tmux list-sessions 2>/dev/null || echo "  (no sessions)"
}
