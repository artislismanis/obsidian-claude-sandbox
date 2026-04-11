# ── Version ARGs (global scope for multi-stage FROM) ────────
ARG UV_VERSION=0.7

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM ubuntu:24.04

# ── Version ARGs ─────────────────────────────────────────────
ARG CLAUDE_CODE_VERSION=2.1.101
ARG PYTHON_VERSION=3.12
ARG NODE_MAJOR=22
ARG TTYD_VERSION=1.7.7
ARG NVM_VERSION=0.40.3
ARG ATUIN_VERSION=18.8.0
ARG BASH_PREEXEC_VERSION=0.5.0

# ══════════════════════════════════════════════════════════════
# Phase 1: ROOT — system packages, binaries, permissions
# ══════════════════════════════════════════════════════════════

ARG DEBIAN_FRONTEND=noninteractive

# System packages — includes Claude Code deps (ripgrep, git, curl),
# firewall tools (iptables, ipset, iproute2, dnsutils, aggregate),
# sudo + gosu for the narrow apt-get sudoers entry and priv-drop in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git jq ca-certificates gnupg locales \
    ripgrep fd-find tree nano less \
    iptables ipset iproute2 dnsutils aggregate sudo gosu \
    && ln -sf /usr/bin/fdfind /usr/bin/fd \
    && sed -i '/en_US.UTF-8/s/^# //' /etc/locale.gen && locale-gen \
    && rm -rf /var/lib/apt/lists/*

# UTF-8 locale — required for terminal Unicode width calculations
ENV LANG=en_US.UTF-8
ENV LC_ALL=en_US.UTF-8

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# ttyd (web terminal) — atuin binary install lives in Phase 3 so
# bumping ATUIN_VERSION doesn't invalidate the expensive Node/Python/
# Claude Code layers.
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then NATIVE_ARCH="aarch64"; else NATIVE_ARCH="x86_64"; fi \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${NATIVE_ARCH}" \
       -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# uv (Python version & package manager)
COPY --from=uv /uv /uvx /usr/local/bin/

# Create non-root user
RUN useradd -m -s /bin/bash claude \
    && mkdir -p /workspace /home/claude/.claude /home/claude/.shell-history \
    && chown -R claude:claude /workspace /home/claude/.claude /home/claude/.shell-history \
    && ln -sf /home/claude/.claude/.claude.json /home/claude/.claude.json

# Narrow sudoers entry — claude may run apt/apt-get only, password-gated.
# The password itself is set at container start time by entrypoint.sh from
# the SUDO_PASSWORD env var (see container/.env.example and README).
RUN echo 'claude ALL=(ALL) PASSWD: /usr/bin/apt-get, /usr/bin/apt' \
      > /etc/sudoers.d/claude-apt \
    && chmod 440 /etc/sudoers.d/claude-apt \
    && visudo -c -f /etc/sudoers.d/claude-apt

# Script COPYs and atuin binary are deferred to Phase 3 so that editing
# a script (verify.sh, session.sh, etc.) or bumping ATUIN_VERSION does
# not invalidate the expensive nvm/Node/Python/Claude Code layers.

# ══════════════════════════════════════════════════════════════
# Phase 2: claude user — nvm, Node, Python, Claude Code
# ══════════════════════════════════════════════════════════════
USER claude
ENV NVM_DIR=/home/claude/.nvm
ENV EDITOR=nano
ENV VISUAL=nano

# nvm + Node — symlink versioned dir to a stable path for non-interactive shells
RUN curl -o- "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" | bash \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install "${NODE_MAJOR}" \
    && nvm alias default "${NODE_MAJOR}" \
    && ln -s "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/default" \
    && nvm cache clear
ENV PATH=/home/claude/.nvm/default/bin:$PATH

# Python via uv (userspace-managed)
RUN uv python install "${PYTHON_VERSION}" && uv cache clean

# Claude Code CLI and MCP servers. Clean the npm cache so ~30–50MB of
# download artifacts don't end up baked into the image layer.
RUN npm install -g \
       "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
       "@modelcontextprotocol/server-memory" \
    && npm cache clean --force

# atuin shell history — the binary itself is installed in Phase 3. This
# step adds pinned bash-preexec.sh (required for atuin's bash hooks to
# register) and writes a local-only config.toml (no sync, no update
# check). Keeping these in Phase 2 means they share the claude user's
# layer cache with the Node/Python installs above.
RUN curl -fsSL "https://raw.githubusercontent.com/rcaloras/bash-preexec/${BASH_PREEXEC_VERSION}/bash-preexec.sh" \
       -o /home/claude/.bash-preexec.sh \
    && mkdir -p /home/claude/.config/atuin /home/claude/.shell-history/atuin \
    && printf '%s\n' \
       '## Local-only — no sync server' \
       'sync_address = ""' \
       'auto_sync = false' \
       'update_check = false' \
       'search_mode = "fuzzy"' \
       'style = "compact"' \
       'inline_height = 20' \
       'filter_mode = "global"' \
       'filter_mode_shell_up_arrow = "global"' \
       '' \
       '## Inline recording (no daemon in container)' \
       'daemon_enabled = false' \
       > /home/claude/.config/atuin/config.toml

# .bashrc wiring. Ordering is load-bearing: bash-preexec must be sourced
# before atuin init, so that atuin's hooks register into the
# preexec_functions / precmd_functions arrays bash-preexec defines.
RUN printf '%s\n' \
       '' \
       '# atuin shell history (DB stored on the volume-backed history dir)' \
       'export ATUIN_CONFIG_DIR=/home/claude/.config/atuin' \
       'export ATUIN_DB_PATH=/home/claude/.shell-history/atuin/history.db' \
       '[ -f /home/claude/.bash-preexec.sh ] && source /home/claude/.bash-preexec.sh' \
       'command -v atuin >/dev/null && eval "$(atuin init bash)"' \
       >> /home/claude/.bashrc

# ══════════════════════════════════════════════════════════════
# Phase 3: back to root — volatile binaries and scripts
#   Everything here invalidates cheaply: atuin bumps, script edits,
#   and the final CMD metadata. Placed last so that changes to any
#   of these do NOT rebuild the expensive Phase 1 apt/Phase 2 Node
#   and Python layers. Entrypoint runs as root to set the claude
#   password from SUDO_PASSWORD, then drops to claude via gosu.
# ══════════════════════════════════════════════════════════════
USER root

# atuin binary — pinned tarball. Placed here (not in Phase 1) so
# bumping ATUIN_VERSION only invalidates this small layer.
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then NATIVE_ARCH="aarch64"; else NATIVE_ARCH="x86_64"; fi \
    && curl -fsSL "https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/atuin-${NATIVE_ARCH}-unknown-linux-gnu.tar.gz" \
       -o /tmp/atuin.tar.gz \
    && tar -xzf /tmp/atuin.tar.gz -C /tmp \
    && install -m 755 /tmp/atuin-*/atuin /usr/local/bin/atuin \
    && rm -rf /tmp/atuin*

# Firewall script (run as root via docker compose exec --user root)
COPY --chmod=755 scripts/init-firewall.sh /usr/local/bin/init-firewall.sh

# Environment verification script (on PATH inside the image, independent of mounts)
COPY --chmod=755 scripts/verify.sh /usr/local/bin/verify.sh

# Terminal entrypoint and session script
COPY --chown=claude:claude --chmod=755 scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=claude:claude --chmod=755 scripts/session.sh /usr/local/bin/session.sh

WORKDIR /workspace
EXPOSE 7681
CMD ["/usr/local/bin/entrypoint.sh"]
