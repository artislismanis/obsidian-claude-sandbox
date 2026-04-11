#!/bin/bash
# Environment verification + runtime contract for the Agent Sandbox container.
#
# This is BOTH a developer sanity check and the source of truth for what's
# available inside the container. Claude running inside the sandbox should
# run this to discover the environment rather than relying on a static
# manifest that could drift from reality.
#
# Exit code: 0 if every tool listed in the Tool versions block resolved,
# 1 if any tool came back "not found". Other sections (mounts, env vars,
# etc.) are informational and don't affect the exit code, so verify.sh
# stays usable as a general diagnostic in degraded contexts.

set -u

# Counter fed by tool_version / tool_present; checked at exit.
MISSING_TOOLS=0

# Print a "Label:   <first-line-of --version>" row. If the binary isn't
# on PATH, prints "not found" and increments MISSING_TOOLS.
tool_version() {
  local label="$1"
  local binary="$2"
  if ! command -v "$binary" >/dev/null 2>&1; then
    printf "%-9s%s\n" "${label}:" "not found"
    MISSING_TOOLS=$((MISSING_TOOLS + 1))
    return
  fi
  local output
  output=$("$binary" --version 2>&1 | head -1)
  printf "%-9s%s\n" "${label}:" "${output:-(empty)}"
}

# Print a "Label:   installed" row if the binary exists, else "not found".
# Use this for tools that don't support --version (e.g. MCP servers).
tool_present() {
  local label="$1"
  local binary="$2"
  if command -v "$binary" >/dev/null 2>&1; then
    printf "%-9s%s\n" "${label}:" "installed"
  else
    printf "%-9s%s\n" "${label}:" "not found"
    MISSING_TOOLS=$((MISSING_TOOLS + 1))
  fi
}

echo "=== Agent Sandbox — Environment Verification ==="

echo ""
echo "── Tool versions ──────────────────────────────────"
tool_version "Node"    "node"
tool_version "npm"     "npm"
tool_version "git"     "git"
tool_version "ttyd"    "ttyd"
tool_present "memory"  "mcp-server-memory"
tool_version "jq"      "jq"
tool_version "Claude"  "claude"
tool_version "gh"      "gh"
tool_version "atuin"   "atuin"
tool_version "rg"      "rg"
tool_version "fd"      "fd"
tool_version "uv"      "uv"
tool_version "Python"  "python3"
tool_present "gosu"    "gosu"
tool_present "sudo"    "sudo"

echo ""
echo "── Mount points ───────────────────────────────────"
print_mount() {
  local path="$1"
  local label="$2"
  if [ -e "$path" ]; then
    # findmnt -> "ro,relatime,..." or "rw,..."; grab the first flag
    local opts
    opts=$(findmnt -n -o OPTIONS --target "$path" 2>/dev/null | awk -F, '{print $1}')
    local rw_state="${opts:-unknown}"
    printf "  %-48s %s\n" "$path" "[$rw_state] $label"
  else
    printf "  %-48s %s\n" "$path" "[MISSING] $label"
  fi
}
print_mount "/workspace"                                        "Claude workspace (host: workspace/)"
print_mount "/workspace/vault"                                  "Obsidian vault (read-only)"
print_mount "/workspace/vault/${PKM_WRITE_DIR:-agent-workspace}" "Vault writable subfolder"
print_mount "/home/claude/.claude"                              "Claude Code config (named volume)"
print_mount "/home/claude/.shell-history"                       "Shell history (named volume)"

echo ""
echo "── Container env ──────────────────────────────────"
# Only env vars that docker-compose.yml actually injects into the
# container (see container/docker-compose.yml `environment:` block).
# Host-side configuration knobs like PKM_VAULT_PATH, CONTAINER_MEMORY,
# TTYD_BIND, etc. are consumed by `docker compose` on the host at
# launch time to build mount sources, resource limits, and port
# bindings — they're not exposed inside the container. To verify those
# took effect, look at the Mount points section below and (for
# resource limits) read /sys/fs/cgroup/{memory.max,cpu.max}.
for var in TERM TTYD_PORT ALLOWED_PRIVATE_HOSTS MEMORY_FILE_PATH; do
  printf "  %-24s = %s\n" "$var" "${!var:-<unset>}"
done

echo ""
echo "── Privileges ─────────────────────────────────────"
echo "  running as:   $(id -un) (uid $(id -u))"
# Clear any cached sudo timestamp so the probe is deterministic —
# otherwise a successful `sudo` earlier in the session would make
# sudo -n succeed and mask the real PASSWD policy. `sudo -k` itself
# requires no authentication; it only clears the user's own timestamp.
sudo -k 2>/dev/null || true
# Non-interactive probe. Capture stderr so we can distinguish
# "password required" from "not in sudoers" by message content —
# both exit non-zero but print different error strings. Never blocks
# on input because -n forces sudo to fail instead of prompting.
sudo_probe_err=$(sudo -n -l /usr/bin/apt-get 2>&1 >/dev/null)
sudo_probe_rc=$?
if [ "$sudo_probe_rc" -eq 0 ]; then
  echo "  sudo apt-get: allowed WITHOUT password (NOPASSWD)"
elif printf '%s' "$sudo_probe_err" | grep -qi 'password is required'; then
  echo "  sudo apt-get: allowed WITH password (human-gated, see README)"
elif printf '%s' "$sudo_probe_err" | grep -qi 'not allowed'; then
  echo "  sudo apt-get: not allowed"
else
  echo "  sudo apt-get: unknown state (${sudo_probe_err:-no error message})"
fi

echo ""
echo "── Node globals ───────────────────────────────────"
npm list -g --depth=0 2>/dev/null | tail -n +2 | sed 's/^/  /' || echo "  (npm not available)"

echo ""
echo "── Runtime checks ─────────────────────────────────"
if [ -d "/workspace/vault" ] && [ "$(ls -A /workspace/vault 2>/dev/null)" ]; then
  VAULT_ITEMS=$(ls -1 /workspace/vault | wc -l)
  echo "  Vault: mounted at /workspace/vault (${VAULT_ITEMS} items)"
else
  echo "  WARNING: No vault content at /workspace/vault"
  echo "    Set PKM_VAULT_PATH in container/.env and restart the container"
fi

if curl -sf http://localhost:7681/ > /dev/null 2>&1; then
  echo "  ttyd:  listening on port ${TTYD_PORT:-7681}"
else
  echo "  ttyd:  not yet listening (normal during build or exec)"
fi

echo ""
echo "=== Done ==="

if [ "$MISSING_TOOLS" -gt 0 ]; then
  echo "" >&2
  echo "⚠  ${MISSING_TOOLS} tool(s) reported 'not found' under Tool versions — see above." >&2
  exit 1
fi
exit 0
