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

# Fix named-volume ownership if it doesn't match claude's current uid.
# Runs as a safety net for users who rebuild the image with a changed
# CLAUDE_UID (or after the base-image uid-drift fix) — named volumes
# persist their contents across rebuilds, so files can end up owned by
# an old uid that the new claude user can't write to. Check-then-chown
# is idempotent and skips if already correct, so per-start cost is
# essentially zero.
claude_uid=$(id -u claude)
claude_gid=$(id -g claude)
for dir in /home/claude/.claude /home/claude/.shell-history; do
    if [[ -d "$dir" ]]; then
        current_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
        if [[ -n "$current_uid" && "$current_uid" != "$claude_uid" ]]; then
            echo "entrypoint: chowning $dir (was uid $current_uid, claude is $claude_uid)"
            chown -R "${claude_uid}:${claude_gid}" "$dir"
        fi
    fi
done

# Fix vault RW overlay ownership. Docker may create these bind-mount
# targets as root:root when the source directory doesn't exist on the
# host or when the Docker daemon runs as a different user.
for dir in \
    "/workspace/vault/${PKM_WRITE_DIR:-agent-workspace}" \
    "/workspace/vault/.oas"; do
    if [[ -d "$dir" ]]; then
        current_uid=$(stat -c '%u' "$dir" 2>/dev/null || echo "")
        if [[ -n "$current_uid" && "$current_uid" != "$claude_uid" ]]; then
            echo "entrypoint: chowning $dir (was uid $current_uid, claude is $claude_uid)"
            chown -R "${claude_uid}:${claude_gid}" "$dir"
        fi
    fi
done

# Ensure memory file exists (MCP memory server expects it).
memory_file="/workspace/vault/.oas/${MEMORY_FILE_NAME:-memory.json}"
if [[ ! -f "$memory_file" ]]; then
    install -o "${claude_uid}" -g "${claude_gid}" -m 644 /dev/null "$memory_file"
fi

# Drop to the claude user and run ttyd. TTYD_PORT falls through from
# docker-compose.yml (defaults to 7681).
exec gosu claude ttyd -W -p "${TTYD_PORT:-7681}" /usr/local/bin/session.sh
