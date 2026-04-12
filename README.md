# Agent Sandbox

An Obsidian plugin and containerized sandbox for working with Obsidian vaults using AI coding agents. Start/stop the sandbox, monitor status, and open multiple independent embedded terminals — all without leaving your vault.

## How it works

```
Obsidian (Windows / Linux / Mac)
  └── Plugin
        ├── Shell commands → docker compose up/down (via WSL or local)
        ├── xterm.js → ttyd WebSocket (port 7681) inside container
        └── Status bar showing container state

Sandbox Container
  ├── ttyd (web terminal on port 7681)
  ├── bash login shell per connection
  ├── Claude Code CLI + MCP servers (memory)
  └── /workspace/vault (read-only mount, writable subfolder)
```

Each terminal tab in Obsidian gets its own independent bash session — run multiple agent instances in parallel.

## Features

**Plugin:**
- **Container management** — Start, stop, restart, and check status via the command palette
- **Status bar** — Shows container state (stopped/starting/running/error)
- **Multiple terminals** — Each tab gets an independent session in the main editor area
- **Terminal theming** — Follow Obsidian theme, or force dark/light
- **Clipboard** — Auto-copy on select, `Ctrl+Shift+V` to paste
- **Auto-lifecycle** — Optionally start/stop the container with plugin load/unload
- **Vault path injection** — Auto-detects vault path and passes it to Docker
- **Docker mode** — WSL (Windows) or Local (Linux/Mac/native Docker)

**Container:**
- **Web terminal** — ttyd accessible at `http://localhost:7681`
- **Read-only vault** — Vault mounted read-only; agents can only write to a designated folder (`agent-workspace/` by default)
- **Claude Code CLI** — Pre-installed and ready to use
- **Memory MCP** — `@modelcontextprotocol/server-memory` preinstalled, memory file stored in `vault/.oas/` (independent of the write directory)
- **Dev tools** — Node 22, Python 3.12, ripgrep, fd, atuin, jq, gh
- **Shell history (atuin)** — Commands are recorded by [atuin](https://atuin.sh) into a persistent SQLite DB on the `oas-shell-history` named volume. Press **Ctrl+R** to open atuin's search UI (scoped by cwd, exit code, session, time). To seed atuin with existing bash history on first run, open a terminal and run `atuin import bash` once.
- **Network sandboxing** — Optional allowlist-based firewall

## Security

- **Read-only vault** — mounted read-only; only the write directory is writable
- **Read-only source** — container tooling at /workspace is read-only
- **Localhost-only terminal** — ttyd binds to 127.0.0.1 by default
- **Firewall toggle** — enable/disable allowlist-based outbound firewall from the status bar (shield icon) or command palette. Auto-enable on start via Advanced settings. Restricts traffic to: Anthropic, npm, GitHub, PyPI, CDNs. Configure `ALLOWED_PRIVATE_HOSTS` for local services (NAS, etc.)
- **No remote access by default** — ttyd only accepts local connections
- **Resource limits** — memory and CPU capped by default (configurable)

> **WSL2 note:** Docker inside WSL2 is also limited by `.wslconfig` memory settings.
> Ensure WSL2 allocation >= container memory limit.

## Prerequisites

- **Docker Engine** installed (inside WSL2 on Windows, or natively on Linux/Mac)
- On Windows: **WSL2 mirrored networking** — add to `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Then restart WSL: `wsl --shutdown`
- **Claude Code subscription** authenticated

## Quick start

### 1. Clone the repo

```bash
git clone https://github.com/artislismanis/obsidian-agent-sandbox.git
cd obsidian-agent-sandbox/container
```

### 2. Build the container

```bash
docker compose build
```

This produces the `oas-sandbox:latest` image. All Docker resources created by this project use the `oas-` prefix (image `oas-sandbox`, container `oas-sandbox`, volumes `oas-claude-config` and `oas-shell-history`) so you can see everything at a glance with `docker ps | grep oas-`.

> **Important:** Start the container from the Obsidian plugin (step 4), not from the command line. The plugin passes required environment variables (`PKM_VAULT_PATH`, `PKM_WRITE_DIR`, etc.) automatically. Running `docker compose up -d` manually without a configured `.env` file will result in missing vault mounts and unexpected behaviour.

### 3. Build and install the plugin

```bash
cd ../plugin
npm install
npm run build
```

Copy the contents of `plugin/dist/` to your vault's `.obsidian/plugins/obsidian-agent-sandbox/` directory:
```bash
mkdir -p /path/to/vault/.obsidian/plugins/obsidian-agent-sandbox
cp dist/* /path/to/vault/.obsidian/plugins/obsidian-agent-sandbox/
```

### 4. Configure and use

1. Restart Obsidian and enable **Agent Sandbox** in Settings > Community Plugins
2. Set **Docker mode** (WSL or Local)
3. Set **Docker Compose path** to the path of the `container/` directory
4. Open the command palette (`Ctrl+P`) and run **Sandbox: Start Container**
5. Click the terminal icon in the ribbon or run **Open Sandbox Terminal**

## Terminal keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| **Copy** | Select text with mouse — auto-copied to clipboard |
| **Copy word** | Right-click a word |
| **Paste** | `Ctrl+Shift+V` |
| **Interrupt (SIGINT)** | `Ctrl+C` |
| **Scroll** | Mouse wheel (10000 lines of scrollback) |

## Commands

| Command | Description |
|---------|-------------|
| **Open Sandbox Terminal** | Open a new terminal tab in the main editor area |
| **Sandbox: Start Container** | Run `docker compose up -d` |
| **Sandbox: Stop Container** | Run `docker compose down` |
| **Sandbox: Container Status** | Show `docker compose ps` output |
| **Sandbox: Restart Container** | Run `docker compose restart` |
| **Sandbox: Toggle Firewall** | Enable or disable the outbound firewall |

## Settings

Settings are organized into three tabs:

**General:**
| Setting | Default | Description |
|---------|---------|-------------|
| Docker mode | `WSL` | WSL (Windows) or Local (Linux/Mac/native Docker) |
| Docker Compose path | *(empty)* | Path to the directory containing docker-compose.yml |
| WSL distribution | `Ubuntu` | WSL distribution for Docker commands (WSL mode only) |
| Vault write directory | `agent-workspace` | Folder inside vault where the container can write files |
| Memory file name | `memory.json` | Filename for the memory MCP, stored in `vault/.oas/` |
| Auto-start on load | `off` | Start container when plugin loads |
| Auto-stop on unload | `off` | Stop container when plugin is disabled |

**Terminal:**
| Setting | Default | Description |
|---------|---------|-------------|
| Port | `7681` | Host port mapped to ttyd |
| Bind address | `127.0.0.1` | IP address ttyd binds to (set 0.0.0.0 for network access) |
| Terminal theme | Follow Obsidian | Follow Obsidian theme, Dark, or Light |
| Terminal font | *(auto)* | Custom font family (falls back through common monospace fonts) |

**Advanced:**
| Setting | Default | Description |
|---------|---------|-------------|
| Memory limit | `8G` | Maximum container memory |
| CPU limit | `4` | Maximum container CPU cores |
| Auto-enable firewall | `off` | Enable outbound firewall on container start |
| Allowed private hosts | *(empty)* | Comma-separated IPs/CIDRs for firewall allowlist |

## Project structure

```
obsidian-agent-sandbox/
├── plugin/                          Obsidian plugin (TypeScript, xterm.js, esbuild)
│   ├── src/
│   │   ├── main.ts                  Plugin entry point, lifecycle, commands
│   │   ├── settings.ts              Settings interface and UI tab
│   │   ├── docker.ts                Container management via WSL or local Docker
│   │   ├── status-bar.ts            Status bar indicator
│   │   ├── terminal-view.ts         xterm.js terminal with ttyd WebSocket
│   │   ├── ttyd-client.ts           ttyd polling and URL construction
│   │   └── __tests__/               Vitest unit tests
│   ├── styles.css                   Plugin and xterm.js styles
│   ├── manifest.json                Obsidian plugin manifest
│   └── package.json
│
├── container/                       Infra — Ubuntu 24.04, ttyd, Claude Code, MCP
│   ├── Dockerfile                   Container image
│   ├── docker-compose.yml           Service, ports, volumes, OAS naming
│   ├── .env.example                 Environment template (optional with plugin)
│   └── scripts/
│       ├── entrypoint.sh            Sets sudo password, drops to claude, runs ttyd
│       ├── session.sh               Starts a login bash per ttyd connection
│       ├── verify.sh                Environment verification / runtime manifest
│       └── init-firewall.sh         Allowlist-based outbound firewall
│
├── workspace/                       Claude's domain — mounted rw at /workspace/ inside container
│   ├── .claude/settings.json        Claude Code project settings (Tier 1)
│   ├── .mcp.json                    MCP server configuration (memory, etc.)
│   └── CLAUDE.md                    Rules for Claude operating inside the sandbox
│
└── docs/
    ├── architecture.md              Rationale for container/workspace split + tier model
    └── testing.md                   Manual testing checklist
```

The split between `container/` (infra, not mounted inside) and `workspace/` (Claude's domain, mounted rw) is deliberate. See `docs/architecture.md` for the full rationale.

## Development

### Plugin development

```bash
cd plugin
npm install
npm run dev          # Watch mode
npm run check        # Lint + format + typecheck + tests
npm run test         # Tests only
```

See `plugin/CLAUDE.md` for architecture details and conventions.

### Container lifecycle

The plugin's container start/stop model is built on `docker compose up -d`'s native idempotency rather than destroy-and-recreate:

- **Start** (command or auto-start on load) runs `docker compose up -d`. If a container is already running with matching config, it's reused instantly — no recreate, no downtime. If the config has changed (e.g. you edited a setting that flows through an env var), compose detects the drift and recreates. No need to explicitly stop first.
- **Stop** (command or auto-stop on exit) runs `docker compose down`. Named volumes (`oas-claude-config`, `oas-shell-history`) persist across this.
- **Restart** (command) explicitly runs `down` then `up -d`. Use this when you want to discard in-container runtime state (tmpfs files, background processes, interactive `sudo apt-get install`s) — not needed for config changes, which the normal Start handles.
- **Plugin disable** always runs `down` (detached, fire-and-forget). Disabling the plugin is a deliberate "I'm done" signal regardless of the auto-stop setting.
- **Auto-stop on exit (off by default)** — with the setting off, the container keeps running between Obsidian sessions. Reopening Obsidian is instant (just an idempotent `up -d`), previously-persisted terminal tabs re-attach to the still-running ttyd, and any background processes (long Claude loops, watch tasks) continue. Turn it on if you'd rather free the container's memory/CPU when you close Obsidian and accept a fresh container on next open.
- **Shell session persistence across Obsidian disconnects** — regular terminal tabs are ephemeral: close the tab or Obsidian and ttyd kills the bash PTY along with anything running inside it. For long-running work (Claude loops, watch tasks, multi-hour builds), wrap the shell in a named tmux session so it survives the disconnect:
  ```bash
  session work            # create or reattach to a named persistent shell
  claude -p "long task"   # anything inside survives disconnect
  ```
  Detach explicitly with `Ctrl-\`, or implicitly by closing the tab or Obsidian. Reattach later with `session work` from any new terminal tab. List active sessions with `sessions`. Multiple clients (e.g. two Obsidian tabs, or Obsidian + a browser on ttyd) can attach to the same session simultaneously with live-synced output. Sessions are ephemeral across container restarts (Restart = clean slate). tmux runs with a minimal no-UI config (mouse off, status off, no prefix key) so the feel is indistinguishable from plain bash.

### Docker resource naming

All Docker resources use the `oas-` prefix (Obsidian Agent Sandbox). Quick checks:

```bash
docker ps --format '{{.Names}}' | grep oas-
docker volume ls --format '{{.Name}}' | grep oas-
docker images --format '{{.Repository}}:{{.Tag}}' | grep oas-sandbox
```

The image is `oas-sandbox:latest`, the container is `oas-sandbox`, and named volumes are `oas-claude-config` (Claude Code auth and config) and `oas-shell-history` (persistent shell history).

### Ephemeral container filesystem

The container filesystem is **ephemeral**: every time the container is recreated (rebuild, `docker compose down && up`, or any plugin-driven restart that recreates the container), everything reverts to the exact state baked into the image. Only these paths persist across recreations:

| Path inside container | Backed by | What it's for |
|---|---|---|
| `/workspace` | bind mount → host `workspace/` | Claude's domain — `.claude/`, `.mcp.json`, skills, agents, commands |
| `/workspace/vault` | bind mount → host vault (ro) | Read-only view of your Obsidian vault |
| `/workspace/vault/<write dir>` | bind mount (rw) | The only vault path the agent can write to |
| `/home/claude/.claude` | named volume `oas-claude-config` | Claude Code authentication, `.claude.json`, project config |
| `/home/claude/.shell-history` | named volume `oas-shell-history` | atuin SQLite DB (`atuin/history.db`) |

Everything else — `apt`-installed packages, files in `/home/claude/` outside `.claude/` and `.shell-history/`, `/tmp`, `/usr/local`, shell config outside what the Dockerfile wrote — is discarded on every container recreation.

**Practical implication:** `sudo apt-get install` inside a live session is strictly for testing. If a tool proves valuable, it **must** be added to `container/Dockerfile` to survive. Same rule for any config file, binary, or system change you want to keep.

### Sudo password and the apt-get escape hatch

The `claude` user inside the container has narrow sudo for `apt-get` and `apt` only, gated by a password. This lets you test-install tools in a live session before deciding whether to add them to the image permanently — but remember, installs do not survive container recreation (see above).

**Default password**: `sandbox` (set in `container/.env.example`).

**Overriding**:
- Edit `SUDO_PASSWORD` in `container/.env` (copy from `.env.example` first), **or**
- Use the plugin's "Sudo password" field in Settings > Agent Sandbox > Advanced (takes precedence over `.env`)

**Example** — test installing `htop` during a ttyd session:

```bash
sudo apt-get update
sudo apt-get install -y htop
htop
```

When prompted, enter the password.

**Trust model**: this is a human-intent gate, not a security boundary. The password is visible in plugin settings and `container/.env` on the host, but **not** inside the container — `entrypoint.sh` unsets `SUDO_PASSWORD` before dropping privileges. Claude is instructed (via `workspace/CLAUDE.md`) not to use sudo; if it needs a system package, it asks. The narrow sudoers scope (`apt-get`/`apt` only) limits blast radius even if sudo is misused. If you need stricter isolation, set `SUDO_PASSWORD` to an empty string in `container/.env` to disable interactive sudo entirely.

### Adding OS-level tools to the Dockerfile

If a tool proves valuable during a `sudo apt-get` test (see ephemeral filesystem note above), promote it to the Dockerfile so every build includes it:

1. Edit `container/Dockerfile` — add the package to the existing `apt-get install` block (keep the list alphabetized).
2. If the tool needs network access at runtime, add the relevant domains to the allowlist in `container/scripts/init-firewall.sh`.
3. Rebuild the image: `cd container && docker compose build`
4. Restart the container: `docker compose down && docker compose up -d` (or via the plugin)
5. Verify with `verify.sh`: `docker compose exec sandbox verify.sh | grep <tool>`
6. Commit the Dockerfile change on a feature branch and open a PR.

**Node global packages**: don't go in the Dockerfile unless they're needed at build time. Prefer `npm install -g <pkg>` at runtime — the global prefix is inside the persisted `oas-claude-config` volume, so installs survive container restarts without a rebuild.

**Python packages**: same principle — use `uv pip install` or `pipx install` for runtime installs.

### PR workflow for workspace changes

`workspace/` is Claude's domain — the config, skills, agents, and commands it uses inside the sandbox. You can let Claude edit these files freely during a session; all commits happen on the host.

Claude running inside the container **cannot run git** — no `.git` is visible at or above `/workspace/`. This is intentional: commits to `workspace/` are always deliberate human actions, and there's no risk of Claude accidentally committing to `main` from inside the sandbox.

**Recommended workflow (branch-first)**:

```bash
# Before starting the Claude session, on the host
git checkout -b feature/<what-you-plan-to-change>

# Start the container via the Obsidian plugin, run your Claude session
# Claude edits files under workspace/

# After the session, on the host
git status                         # see what changed
git diff workspace/                # review the edits
git add workspace/
git commit -m "<clear description>"
git push -u origin feature/<what-you-plan-to-change>
gh pr create                       # or open via GitHub UI
```

**If you forgot to branch first**:

```bash
# You're on main, Claude has already made edits (git status shows them)
git checkout -b feature/<what-you-did>   # git carries unstaged changes to the new branch
git add workspace/
git commit -m "..."
git push -u origin feature/<what-you-did>
gh pr create
```

Your `main` is still clean — nothing was committed to it.

**To throw away Claude's changes**:

```bash
git restore workspace/
```

**Branch protection**: we recommend enabling GitHub branch protection on `main` (Settings > Branches > Add rule > Require pull request before merging). This enforces the PR workflow at the remote level, so even an accidental `git push origin main` gets rejected.

## Upgrading

### Memory file moved out of write directory

The memory MCP file previously lived at `vault/<write-dir>/memory.json`. It now lives at `vault/.oas/memory.json`, independent of the write directory setting. If you have an existing memory file, move it:

```bash
# On the host, from your vault root:
mkdir -p .oas
mv agent-workspace/memory.json .oas/memory.json
```

## License

MIT
