#!/usr/bin/env bash
#
# Report the agent's activity state to the Obsidian plugin via its MCP
# endpoint. Called from Claude Code hooks in this workspace's
# .claude/settings.json. Silent failures by design — a missing token or
# offline MCP server must never block Claude Code.
#
# Usage: notify-status.sh <status> [detail]
#   status: idle | working | awaiting_input
#   detail: optional short context string
#
# Requires OAS_MCP_TOKEN and OAS_MCP_PORT in the container env (set by
# the plugin at docker compose up). Session name is picked up from tmux
# when available.

set -eu

status="${1:-idle}"
detail="${2:-}"

case "$status" in
  idle|working|awaiting_input) ;;
  *)
    echo "notify-status: invalid status '$status' (want idle|working|awaiting_input)" >&2
    exit 0
    ;;
esac

session="$(tmux display-message -p '#S' 2>/dev/null || true)"
token="${OAS_MCP_TOKEN:-}"
port="${OAS_MCP_PORT:-28080}"

if [ -z "$token" ]; then
  # No token means MCP is disabled or not initialized. Exit silently.
  exit 0
fi

# jq is installed in the sandbox image (container/Dockerfile); this hook
# only ever runs in-container, so we can rely on it.
payload=$(jq -n --arg s "$status" --arg n "$session" --arg d "$detail" '
  {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: {
      name: "agent_status_set",
      arguments: ({ status: $s }
        + (if $n == "" then {} else { sessionName: $n } end)
        + (if $d == "" then {} else { detail: $d } end))
    }
  }')

curl -s -m 2 -o /dev/null \
  -H "Authorization: Bearer $token" \
  -H "Content-Type: application/json" \
  "http://host.docker.internal:${port}/mcp" \
  -d "$payload" || true
