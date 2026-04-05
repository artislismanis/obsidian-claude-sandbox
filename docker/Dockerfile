# ── Version ARGs (global scope for multi-stage FROM) ────────
ARG UV_VERSION=0.7

FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM ubuntu:24.04

# ── Version ARGs ─────────────────────────────────────────────
ARG CLAUDE_CODE_VERSION=latest
ARG GIT_DELTA_VERSION=0.18.2
ARG PYTHON_VERSION=3.12
ARG NODE_MAJOR=22
ARG TTYD_VERSION=1.7.7
ARG NVM_VERSION=0.40.3
ARG ATUIN_VERSION=18.13.5

# ══════════════════════════════════════════════════════════════
# Phase 1: ROOT — system packages, binaries, permissions
# ══════════════════════════════════════════════════════════════

ARG DEBIAN_FRONTEND=noninteractive

# System packages — includes Claude Code deps (ripgrep, git, curl)
# and firewall tools (iptables, ipset, iproute2, dnsutils, aggregate)
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git tmux jq fzf ca-certificates gnupg \
    ripgrep fd-find tree nano less \
    iptables ipset iproute2 dnsutils aggregate sudo \
    && ln -sf /usr/bin/fdfind /usr/bin/fd \
    && rm -rf /var/lib/apt/lists/*

# GitHub CLI
RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
      | dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /usr/share/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
      | tee /etc/apt/sources.list.d/github-cli.list > /dev/null \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

# git-delta, ttyd (web terminal), atuin (shell history)
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then NATIVE_ARCH="aarch64"; else NATIVE_ARCH="x86_64"; fi \
    && curl -fsSL "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" \
       -o /tmp/git-delta.deb \
    && dpkg -i /tmp/git-delta.deb && rm /tmp/git-delta.deb \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${NATIVE_ARCH}" \
       -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd \
    && curl -fsSL "https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/atuin-${NATIVE_ARCH}-unknown-linux-gnu.tar.gz" \
       -o /tmp/atuin.tar.gz \
    && tar -xzf /tmp/atuin.tar.gz -C /tmp \
    && install -m 755 /tmp/atuin-*/atuin /usr/local/bin/atuin \
    && rm -rf /tmp/atuin*

# uv (Python version & package manager)
COPY --from=uv /uv /uvx /usr/local/bin/

# Create non-root user
RUN useradd -m -s /bin/bash claude \
    && mkdir -p /workspace /home/claude/.claude /home/claude/.local/share/atuin \
    && chown -R claude:claude /workspace /home/claude/.claude /home/claude/.local

# Firewall script + sudoers
COPY --chmod=755 scripts/init-firewall.sh /usr/local/bin/init-firewall.sh
RUN echo "claude ALL=(root) NOPASSWD: /usr/local/bin/init-firewall.sh" \
       > /etc/sudoers.d/claude-firewall \
    && chmod 0440 /etc/sudoers.d/claude-firewall

# tmux config
COPY --chown=claude:claude .tmux.conf /home/claude/.tmux.conf

# Terminal scripts — entrypoint starts ttyd, session.sh creates per-connection tmux sessions
COPY --chown=claude:claude --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=claude:claude --chmod=755 session.sh /usr/local/bin/session.sh

# ══════════════════════════════════════════════════════════════
# Phase 2: claude user — nvm, Node, Python, Claude Code, atuin
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

# Claude Code CLI
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# atuin — configure for local-only mode (no sync) and bash integration
RUN atuin init bash > /tmp/atuin-init.bash \
    && echo '' >> /home/claude/.bashrc \
    && echo '# Atuin shell history' >> /home/claude/.bashrc \
    && cat /tmp/atuin-init.bash >> /home/claude/.bashrc \
    && rm /tmp/atuin-init.bash \
    && mkdir -p /home/claude/.config/atuin \
    && printf '%s\n' \
       '## Local-only — no sync server' \
       'sync_address = ""' \
       'auto_sync = false' \
       'search_mode = "fuzzy"' \
       'style = "compact"' \
       'filter_mode = "global"' \
       'filter_mode_shell_up_arrow = "global"' \
       > /home/claude/.config/atuin/config.toml

WORKDIR /workspace
EXPOSE 7681
CMD ["/usr/local/bin/entrypoint.sh"]
