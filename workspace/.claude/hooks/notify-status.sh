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
#
# Implementation note: pipes JSON-RPC through the stdio→HTTP proxy at
# .claude/scripts/obsidian-mcp-proxy.js, which performs the MCP
# `initialize` handshake, manages the session id, and forwards the
# `tools/call`. Talking directly to the HTTP endpoint bypasses the
# handshake and the SDK rejects the request, so the previous direct-curl
# implementation silently no-op'd.

# `set -u` only — `set -e` would defeat the "silent failures by design"
# contract by aborting on jq/tmux/node errors before the trailing `|| true`.
set -u

status="${1:-idle}"
detail="${2:-}"

case "$status" in
  idle|working|awaiting_input) ;;
  *)
    echo "notify-status: invalid status '$status' (want idle|working|awaiting_input)" >&2
    exit 0
    ;;
esac

token="${OAS_MCP_TOKEN:-}"
if [ -z "$token" ]; then
  # No token means MCP is disabled or not initialized. Exit silently.
  exit 0
fi

session="$(tmux display-message -p '#S' 2>/dev/null || true)"

# jq is installed in the sandbox image (container/Dockerfile); this hook
# only ever runs in-container, so we can rely on it.
init_msg='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"notify-status","version":"1.0"}}}'
init_notif='{"jsonrpc":"2.0","method":"notifications/initialized"}'
if ! call_msg=$(jq -n --arg s "$status" --arg n "$session" --arg d "$detail" '
  {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: {
      name: "agent_status_set",
      arguments: ({ status: $s }
        + (if $n == "" then {} else { sessionName: $n } end)
        + (if $d == "" then {} else { detail: $d } end))
    }
  }'); then
  # jq failure here would have left $call_msg empty and silently sent a
  # blank line to the proxy — the hook would log "success" while reporting
  # nothing. Bail loudly so monitoring catches the regression instead.
  echo "notify-status: jq failed to build call_msg" >&2
  exit 0
fi
if [ -z "$call_msg" ]; then
  echo "notify-status: empty call_msg from jq" >&2
  exit 0
fi

proxy="$(dirname "$0")/../scripts/obsidian-mcp-proxy.js"
if [ ! -f "$proxy" ]; then
  exit 0
fi

# Feed initialize, initialized notification, and tools/call through the
# proxy. The proxy exits when stdin closes. Total budget ~3s.
{
  printf '%s\n' "$init_msg"
  printf '%s\n' "$init_notif"
  printf '%s\n' "$call_msg"
} | timeout 3 node "$proxy" >/dev/null 2>&1 || true
