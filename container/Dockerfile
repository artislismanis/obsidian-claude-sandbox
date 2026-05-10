# ── Version ARGs (global scope for multi-stage FROM) ────────
ARG UV_VERSION=0.7

# TODO(image-pin): pin to an immutable digest, e.g.
#   FROM ghcr.io/astral-sh/uv:${UV_VERSION}@sha256:<digest> AS uv
#   FROM ubuntu:24.04@sha256:<digest>
# Tag-only pins above are mutable and a tag re-push could swap the base
# image silently between rebuilds. Capture the digest with
# `docker buildx imagetools inspect` after the next clean build.
FROM ghcr.io/astral-sh/uv:${UV_VERSION} AS uv
FROM ubuntu:24.04

# ── Version ARGs ─────────────────────────────────────────────
ARG CLAUDE_CODE_VERSION=2.1.101
ARG PYTHON_VERSION=3.12
ARG NODE_MAJOR=24
ARG TTYD_VERSION=1.7.7
ARG NVM_VERSION=0.40.3
# SHA256 of https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh
# Pinning the hash defends against tag-move / upstream compromise of the
# install script, which would otherwise execute as root during build.
# When bumping NVM_VERSION, recompute via:
#   curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v<new>/install.sh | sha256sum
ARG NVM_INSTALL_SHA256=2d8359a64a3cb07c02389ad88ceecd43f2fa469c06104f92f98df5b6f315275f
ARG ATUIN_VERSION=18.8.0
ARG BASH_PREEXEC_VERSION=0.5.0
ARG MEMORY_SERVER_VERSION=2026.1.26

# ── Binary download SHA256 pins ───────────────────────────────
# Defends against tag-move / upstream compromise of the release binaries
# we curl during the build. When bumping any of the *_VERSION ARGs above,
# you MUST recompute the matching SHA via:
#   curl -fsSL <url> | sha256sum
# and update the corresponding ARG below. See container/CLAUDE.md.
ARG TTYD_SHA256_AMD64=8a217c968aba172e0dbf3f34447218dc015bc4d5e59bf51db2f2cd12b7be4f55
ARG TTYD_SHA256_ARM64=b38acadd89d1d396a0f5649aa52c539edbad07f4bc7348b27b4f4b7219dd4165
ARG BASH_PREEXEC_SHA256=6ef95f16012bdfec0ab6ee853e8892d51eee295c8639944f9b983b3d40e0e9f7
ARG ATUIN_SHA256_AMD64=5da991d001632ec140d9bc7b094ddcd7a227c59acc5c498bd9ef4141417ae8ea
ARG ATUIN_SHA256_ARM64=19c862a874e6dc41e373888ee11dd90bb68f7ccbb5fd8353347bf00892445e88

# ── User ARGs ────────────────────────────────────────────────
# The claude user's uid/gid. Defaults to 1000 because that's the
# uid of the first human user on most Linux / WSL2 hosts, and the
# workspace dir is bind-mounted from the host — matching uids is
# the only way claude can write to it without chowning the host.
# Override in container/.env if `id -u` on your host returns
# something else; docker-compose.yml passes these through as build
# args. Must be set before the useradd RUN that consumes them.
ARG CLAUDE_UID=1000
ARG CLAUDE_GID=1000

# ══════════════════════════════════════════════════════════════
# Phase 1: ROOT — system packages, binaries, permissions
# ══════════════════════════════════════════════════════════════

ARG DEBIAN_FRONTEND=noninteractive

# System packages — includes Claude Code deps (ripgrep, git, curl),
# firewall tools (iptables, ipset, iproute2, dnsutils, aggregate),
# sudo + gosu for the narrow apt-get sudoers entry and priv-drop in entrypoint
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl git jq ca-certificates gnupg locales \
    ripgrep fd-find tree nano less tmux \
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
    && if [ "$ARCH" = "arm64" ]; then \
         NATIVE_ARCH="aarch64"; EXPECTED_SHA="${TTYD_SHA256_ARM64}"; \
       else \
         NATIVE_ARCH="x86_64"; EXPECTED_SHA="${TTYD_SHA256_AMD64}"; \
       fi \
    && curl -fsSL "https://github.com/tsl0922/ttyd/releases/download/${TTYD_VERSION}/ttyd.${NATIVE_ARCH}" \
       -o /usr/local/bin/ttyd \
    && if [ -n "$EXPECTED_SHA" ]; then \
         echo "${EXPECTED_SHA}  /usr/local/bin/ttyd" | sha256sum -c -; \
       else \
         echo "WARN: TTYD SHA256 not pinned for $NATIVE_ARCH — skipping verification" >&2; \
       fi \
    && chmod +x /usr/local/bin/ttyd

# uv (Python version & package manager)
COPY --from=uv /uv /uvx /usr/local/bin/

# Create non-root user. Ubuntu 24.04's base image ships with a
# pre-created `ubuntu` user at uid 1000, which would force any new
# useradd to the next free uid (typically 1001). That breaks writes
# to the /workspace bind mount when the host user is uid 1000 (the
# normal case) because bind mounts preserve uids exactly — files
# owned by host 1000 can only be written by container uid 1000.
# Fix: delete the base `ubuntu` user first, then create claude with
# an explicit, overridable uid/gid.
RUN userdel -r ubuntu 2>/dev/null || true \
    && groupadd -g "${CLAUDE_GID}" claude \
    && useradd --no-log-init -m -s /bin/bash -u "${CLAUDE_UID}" -g "${CLAUDE_GID}" claude \
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

# nvm + Node — symlink versioned dir to a stable path for non-interactive shells.
# The install script is downloaded, hash-verified, then executed. Piping curl
# straight into bash would mean any upstream compromise of the script gets
# arbitrary code-exec as the build user during `docker build`.
RUN curl -fsSL "https://raw.githubusercontent.com/nvm-sh/nvm/v${NVM_VERSION}/install.sh" \
       -o /tmp/nvm-install.sh \
    && echo "${NVM_INSTALL_SHA256}  /tmp/nvm-install.sh" | sha256sum -c - \
    && bash /tmp/nvm-install.sh \
    && rm /tmp/nvm-install.sh \
    && . "$NVM_DIR/nvm.sh" \
    && nvm install "${NODE_MAJOR}" \
    && nvm alias default "${NODE_MAJOR}" \
    && ln -s "$(dirname "$(dirname "$(nvm which default)")")" "$NVM_DIR/default" \
    && nvm cache clear
ENV PATH=/home/claude/.nvm/default/bin:/home/claude/.local/python-default/bin:$PATH

# Python via uv (userspace-managed). A stable dir symlink at
# ~/.local/python-default gives a version-agnostic entry for PATH.
# Symlinking the whole install root (not just the binary) is load-bearing:
# `python3 -m venv` writes the invocation bin dir into pyvenv.cfg as `home`,
# and `../lib/python3.12/` must resolve to real stdlib from there. A
# `/usr/local/bin/python3` symlink breaks venv because pyvenv.cfg ends up
# with `home = /usr/local/bin` and no stdlib lives there — Python then
# falls back to python-build-standalone's baked `/install` prefix and
# bails at `No module named 'encodings'`.
RUN uv python install "${PYTHON_VERSION}" && uv cache clean \
    && ln -sfn "$(dirname "$(dirname "$(uv python find)")")" /home/claude/.local/python-default \
    && ln -sf python3 /home/claude/.local/python-default/bin/python

# Claude Code CLI and MCP servers. Clean the npm cache so ~30–50MB of
# download artifacts don't end up baked into the image layer.
RUN npm install -g --no-audit --no-fund \
       "@anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}" \
       "@modelcontextprotocol/server-memory@${MEMORY_SERVER_VERSION}" \
    && npm cache clean --force

# atuin shell history — the binary itself is installed in Phase 3. This
# step adds pinned bash-preexec.sh (required for atuin's bash hooks to
# register) and writes a local-only config.toml (no sync, no update
# check). Keeping these in Phase 2 means they share the claude user's
# layer cache with the Node/Python installs above.
RUN curl -fsSL "https://raw.githubusercontent.com/rcaloras/bash-preexec/${BASH_PREEXEC_VERSION}/bash-preexec.sh" \
       -o /home/claude/.bash-preexec.sh \
    && if [ -n "${BASH_PREEXEC_SHA256}" ]; then \
         echo "${BASH_PREEXEC_SHA256}  /home/claude/.bash-preexec.sh" | sha256sum -c -; \
       else \
         echo "WARN: BASH_PREEXEC_SHA256 not pinned — skipping verification" >&2; \
       fi \
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
       '' \
       '# Persistent shell sessions via tmux (see ~/.session-helpers.sh)' \
       '[ -f /home/claude/.session-helpers.sh ] && source /home/claude/.session-helpers.sh' \
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
    && if [ "$ARCH" = "arm64" ]; then \
         NATIVE_ARCH="aarch64"; EXPECTED_SHA="${ATUIN_SHA256_ARM64}"; \
       else \
         NATIVE_ARCH="x86_64"; EXPECTED_SHA="${ATUIN_SHA256_AMD64}"; \
       fi \
    && curl -fsSL "https://github.com/atuinsh/atuin/releases/download/v${ATUIN_VERSION}/atuin-${NATIVE_ARCH}-unknown-linux-gnu.tar.gz" \
       -o /tmp/atuin.tar.gz \
    && if [ -n "$EXPECTED_SHA" ]; then \
         echo "${EXPECTED_SHA}  /tmp/atuin.tar.gz" | sha256sum -c -; \
       else \
         echo "WARN: ATUIN SHA256 not pinned for $NATIVE_ARCH — skipping verification" >&2; \
       fi \
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

# tmux config + session helpers (opt-in persistent shells)
COPY --chown=claude:claude --chmod=644 configs/tmux.conf /home/claude/.tmux.conf
COPY --chown=claude:claude --chmod=644 configs/session-helpers.sh /home/claude/.session-helpers.sh

WORKDIR /workspace
EXPOSE 7681

# Healthcheck baked into the image so `docker run` (without compose) reports
# accurate liveness. docker-compose.yml's healthcheck overrides this for the
# managed-by-plugin case, where TTYD_PORT may differ from the default.
# Requires curl, which Phase 1 already installs.
# CMD-SHELL form is required for ${TTYD_PORT:-7681} to expand at runtime.
# The exec-array form ("CMD", "curl", ...) does not run a shell, so the
# ${VAR} syntax would be passed literally to curl and fail.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD-SHELL curl -fsS "http://localhost:${TTYD_PORT:-7681}/" >/dev/null || exit 1

CMD ["/usr/local/bin/entrypoint.sh"]
