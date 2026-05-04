#!/bin/bash
# Per-ttyd-connection session launcher. ttyd execs this for every WebSocket
# client. The start/end markers go to ttyd's stderr → docker logs, so a
# `docker logs oas-sandbox` correlates plugin-side WS events with the
# container-side bash lifetime (PID, exit code, signal).

session_id="$$"
started_at=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
echo "[oas-session] start id=${session_id} at=${started_at} client=${TTYD_USER:-anon}" >&2

cleanup() {
	local exit_code=$?
	local ended_at
	ended_at=$(date -u +"%Y-%m-%dT%H:%M:%S.%3NZ")
	echo "[oas-session] end id=${session_id} at=${ended_at} exit=${exit_code}" >&2
}
trap cleanup EXIT

# Don't exec — exec'ing here replaces the shell, so the EXIT trap never
# fires and we lose the end-of-session log line. The cost of one extra
# shell per session is negligible.
bash -l

