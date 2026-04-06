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

# git-delta, ttyd (web terminal)
RUN ARCH="$(dpkg --print-architecture)" \
    && if [ "$ARCH" = "arm64" ]; then NATIVE_ARCH="aarch64"; else NATIVE_ARCH="x86_64"; fi \
    && curl -fsSL "https://github.com/dandavison/delta/releases/download/${GIT_DELTA_VERSION}/git-delta_${GIT_DELTA_VERSION}_${ARCH}.deb" \
       -o /tmp/git-delta.deb \
    && dpkg -i /tmp/git-delta.deb && rm /tmp/git-delta.deb \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${NATIVE_ARCH}" \
       -o /usr/local/bin/ttyd \
    && chmod +x /usr/local/bin/ttyd

# uv (Python version & package manager)
COPY --from=uv /uv /uvx /usr/local/bin/

# Create non-root user
RUN useradd -m -s /bin/bash claude \
    && mkdir -p /workspace /home/claude/.claude /home/claude/.shell-history \
    && chown -R claude:claude /workspace /home/claude/.claude /home/claude/.shell-history

# Firewall script (run as root via docker compose exec --user root)
COPY --chmod=755 scripts/init-firewall.sh /usr/local/bin/init-firewall.sh

# tmux config
COPY --chown=claude:claude .tmux.conf /home/claude/.tmux.conf

# Terminal scripts — entrypoint starts ttyd, session.sh creates per-connection tmux sessions
COPY --chown=claude:claude --chmod=755 entrypoint.sh /usr/local/bin/entrypoint.sh
COPY --chown=claude:claude --chmod=755 session.sh /usr/local/bin/session.sh

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

# Claude Code CLI
RUN npm install -g "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}"

# Shell history — persistent via named volume, fzf for Ctrl+R search
RUN printf '%s\n' \
       '' \
       '# Persistent shell history (volume-backed)' \
       'export HISTFILE=/home/claude/.shell-history/.bash_history' \
       'export HISTSIZE=50000' \
       'export HISTFILESIZE=100000' \
       'export HISTCONTROL=ignoredups:ignorespace:erasedups' \
       'shopt -s histappend' \
       'PROMPT_COMMAND="history -a;${PROMPT_COMMAND:-}"' \
       '' \
       '# fzf key bindings (Ctrl+R for history search)' \
       '[ -f /usr/share/doc/fzf/examples/key-bindings.bash ] && source /usr/share/doc/fzf/examples/key-bindings.bash' \
       >> /home/claude/.bashrc

WORKDIR /workspace
EXPOSE 7681
CMD ["/usr/local/bin/entrypoint.sh"]
