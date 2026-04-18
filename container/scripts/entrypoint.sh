#!/bin/bash
set -euo pipefail

# Entrypoint runs as root so we can (optionally) update the claude user's
# password for interactive sudo, then drop to the claude user for ttyd.
#
# SUDO_PASSWORD is a human-intent gate for narrow sudo (apt-get only).
# If unset or empty, the claude user password stays unset and `sudo`
# fails at the password prompt — i.e. sudo is effectively disabled.
# See container/.env.example and README.md "Development" section.

if [[ -n "${SUDO_PASSWORD:-}" ]]; then
    echo "claude:${SUDO_PASSWORD}" | chpasswd
fi

# Unset before dropping privileges so SUDO_PASSWORD does not leak into
# the child shell's environment (would otherwise be visible via `env`).
unset SUDO_PASSWORD

# On WSL2 (Rancher Desktop, Docker Desktop WSL2 backend, raw Docker Engine in
# WSL2), host.docker.internal is set to the Docker bridge gateway (172.17.0.1)
# by the compose extra_hosts mapping. That IP is the Linux bridge interface
# INSIDE WSL2, not the Windows host. The Obsidian plugin's MCP server runs on
# Windows and is unreachable at 172.17.0.1.
#
# Fix: detect WSL2 via /proc/version, read the actual Windows host IP from the
# WSL2 resolv.conf (mounted at /run/wsl-resolv.conf), and override the hosts
# entry. The WSL2 resolv.conf nameserver is always the vEthernet (WSL) adapter
# IP on Windows — the gateway that WSL2 uses to reach Windows.
#
# On native Linux the fix is skipped (host.docker.internal = 172.17.0.1 is
# correct there). On macOS Docker Desktop the volume mount won't exist, so
# the condition is also skipped.
if grep -qi microsoft /proc/version 2>/dev/null && [[ -f /run/wsl-resolv.conf ]]; then
    wsl_host=$(awk '/^nameserver/ {print $2; exit}' /run/wsl-resolv.conf)
    if [[ -n "$wsl_host" && "$wsl_host" != "127.0.0.1" && "$wsl_host" != "127.0.0.53" ]]; then
        echo "entrypoint: WSL2 detected — routing host.docker.internal to Windows host at $wsl_host"
        sed -i '/host\.docker\.internal/d' /etc/hosts
        echo "$wsl_host  host.docker.internal" >> /etc/hosts
    fi
fi

# Fix directory ownership if it doesn't match claude's current uid.
# Named volumes persist across rebuilds and bind-mount targets may be
# created as root:root — check-then-chown is idempotent and skips if
# already correct, so per-start cost is essentially zero.
claude_uid=$(id -u claude)
claude_gid=$(id -g claude)

ensure_ownership() {
    local dir="$1"
    if [[ -d "$dir" ]]; then
        local current_uid
        current_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
        if [[ -n "$current_uid" && "$current_uid" != "$claude_uid" ]]; then
            echo "entrypoint: fixing ownership on $dir (uid $current_uid → $claude_uid)"
            # Try chown first (works on native Linux and named volumes)
            chown -R "${claude_uid}:${claude_gid}" "$dir" 2>/dev/null || true
            # Verify it worked — on 9p/drvfs mounts (Windows), chown may
            # succeed silently without effect. Fall back to chmod so the
            # claude user can write regardless of ownership.
            local new_uid
            new_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
            if [[ "$new_uid" != "$claude_uid" ]]; then
                echo "entrypoint: chown ineffective on $dir (9p/drvfs mount?), using chmod"
                chmod -R a+rwX "$dir" 2>/dev/null || true
            fi
        fi
    fi
}

# Named volumes
ensure_ownership /home/claude/.claude
ensure_ownership /home/claude/.shell-history
# Vault RW overlays
ensure_ownership "/workspace/vault/${PKM_WRITE_DIR:-agent-workspace}"
ensure_ownership /workspace/vault/.oas

# Ensure memory file exists (MCP memory server expects it).
memory_file="/workspace/vault/.oas/${MEMORY_FILE_NAME:-memory.json}"
if [[ ! -f "$memory_file" ]]; then
    install -o "${claude_uid}" -g "${claude_gid}" -m 644 /dev/null "$memory_file"
fi

# Drop to the claude user and run ttyd. TTYD_PORT falls through from
# docker-compose.yml (defaults to 7681).
exec gosu claude ttyd -W -p "${TTYD_PORT:-7681}" /usr/local/bin/session.sh
