# Agent Sandbox

An Obsidian plugin and Docker container for working with Obsidian vaults using AI coding agents. Start/stop containers, monitor status, and open multiple independent embedded terminals — all without leaving your vault.

## How it works

```
Obsidian (Windows / Linux / Mac)
  └── Plugin
        ├── Shell commands → docker compose up/down (via WSL or local)
        ├── xterm.js → ttyd WebSocket (port 7681) inside container
        └── Status bar showing container state

Docker Container
  ├── ttyd (web terminal on port 7681)
  ├── tmux (independent session per connection)
  ├── Claude Code CLI
  └── /workspace/vault (read-only mount, writable subfolder)
```

Each terminal tab in Obsidian gets its own independent tmux session — run multiple agent instances in parallel.

## Features

**Plugin:**
- **Container management** — Start, stop, restart, and check status via the command palette
- **Status bar** — Shows container state (stopped/starting/running/error)
- **Multiple terminals** — Each tab gets an independent session, docked at the bottom
- **Terminal theming** — Follow Obsidian theme, or force dark/light
- **Clipboard** — Auto-copy on select, `Ctrl+Shift+V` to paste
- **Auto-lifecycle** — Optionally start/stop the container with plugin load/unload
- **Vault path injection** — Auto-detects vault path and passes it to Docker
- **Docker mode** — WSL (Windows) or Local (Linux/Mac/native Docker)

**Container:**
- **Web terminal** — ttyd with tmux, accessible at `http://localhost:7681`
- **Read-only vault** — Vault mounted read-only; agents can only write to a designated folder (`claude-workspace/` by default)
- **Claude Code CLI** — Pre-installed and ready to use
- **Dev tools** — Node 22, Python 3.12, ripgrep, fd, git-delta, atuin, fzf, jq, gh
- **Network sandboxing** — Optional allowlist-based firewall

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

### 1. Clone and configure

```bash
git clone https://github.com/artislismanis/obsidian-agent-sandbox.git
cd obsidian-agent-sandbox/docker
cp .env.example .env
# Edit .env — set PKM_VAULT_PATH to your vault path
# Optionally set PKM_WRITE_DIR (default: claude-workspace)
```

### 2. Build and start the container

```bash
cd docker
docker compose build
docker compose up -d
```

Verify: `docker compose ps` should show `agent-sandbox` as healthy.

### 3. Build and install the plugin

```bash
cd plugin
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
3. Set **Docker Compose path** to the path of the `docker/` directory
4. Open the command palette (`Ctrl+P`) and run **Sandbox: Start Container**
5. Click the terminal icon in the ribbon or run **Open Sandbox Terminal**

## Terminal keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| **Copy** | Select text with mouse — auto-copied to clipboard |
| **Copy word** | Right-click a word |
| **Paste** | `Ctrl+Shift+V` |
| **Interrupt (SIGINT)** | `Ctrl+C` |

tmux keybindings work normally (e.g., `Ctrl+B` then `C` for new window).

> **Tip:** The container ships with `set -g mouse off` in tmux so text selection works with a simple click-drag — no need to hold Shift.

## Commands

| Command | Description |
|---------|-------------|
| **Open Sandbox Terminal** | Open a new terminal tab at the bottom |
| **Sandbox: Start Container** | Run `docker compose up -d` |
| **Sandbox: Stop Container** | Run `docker compose down` |
| **Sandbox: Container Status** | Show `docker compose ps` output |
| **Sandbox: Restart Container** | Run `docker compose restart` |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Docker mode | `WSL` | WSL (Windows) or Local (Linux/Mac/native Docker) |
| Docker Compose path | *(empty)* | Path to the directory containing docker-compose.yml |
| WSL distribution | `Ubuntu` | WSL distribution for Docker commands (WSL mode only) |
| Vault write directory | `claude-workspace` | Folder inside vault where the container can write files |
| Port | `7681` | Port where ttyd listens |
| Username | `user` | Username for ttyd auth |
| Password | *(empty)* | Password for ttyd auth |
| Terminal theme | Follow Obsidian | Follow Obsidian theme, Dark, or Light |
| Auto-start on load | `off` | Start container when plugin loads |
| Auto-stop on unload | `off` | Stop container when plugin is disabled |

## Project structure

```
plugin/                      Obsidian plugin source
├── src/
│   ├── main.ts              Plugin entry point, lifecycle, commands
│   ├── settings.ts          Settings interface and UI tab
│   ├── docker.ts            Container management via WSL or local Docker
│   ├── status-bar.ts        Status bar indicator
│   ├── terminal-view.ts     xterm.js terminal with ttyd WebSocket
│   ├── ttyd-client.ts       ttyd polling, auth, URL construction
│   └── __tests__/           Vitest unit tests
├── dist/                    Build output (main.js, manifest.json, styles.css)
└── package.json

docker/                      Docker container configuration
├── Dockerfile               Container image (Ubuntu 24.04)
├── docker-compose.yml       Service configuration
├── entrypoint.sh            Starts ttyd with optional auth
├── session.sh               Creates unique tmux session per connection
├── .tmux.conf               tmux defaults (mouse off, 256color)
├── .env.example             Environment template (optional with plugin)
└── scripts/
    ├── verify.sh            Environment validation
    └── init-firewall.sh     Network sandboxing setup

docs/
└── TESTING.md               Manual testing checklist
```

## Development

```bash
cd plugin
npm install
npm run dev          # Watch mode
npm run check        # Lint + format + typecheck + tests
npm run test         # Tests only
```

See `plugin/CLAUDE.md` for architecture details and conventions.

## License

MIT
