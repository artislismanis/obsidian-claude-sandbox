#!/bin/bash
if [[ -n "${TTYD_NO_TMUX:-}" ]]; then
  exec bash -l
else
  SESSION_ID="claude-$(date +%s%N)-$$"
  cleanup() { tmux kill-session -t "$SESSION_ID" 2>/dev/null || true; }
  trap cleanup EXIT
  tmux new-session -s "$SESSION_ID"
fi
