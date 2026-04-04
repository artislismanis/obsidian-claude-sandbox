# PKM Claude Terminal

An Obsidian plugin that manages a Docker-based Claude Code environment from within Obsidian. Start/stop containers, monitor status, and open an embedded terminal — all without leaving your vault.

Designed to work with a [pkm-workspace](https://github.com/artislismanis/pkm-workspace) devcontainer that mounts your Obsidian vault into a container running Claude Code via ttyd.

## How it works

```
Obsidian (Windows)
  └── Plugin
        ├── Shell commands → wsl -d <distro> → docker compose up/down
        ├── xterm.js → ttyd WebSocket (port 7681) inside container
        └── Status bar showing container state

Docker Container (WSL2)
  ├── ttyd (web terminal on port 7681)
  ├── tmux (multiplexed sessions)
  ├── Claude Code CLI
  └── /workspace/vault (bind-mounted Obsidian vault)
```

## Features

- **Container management** — Start, stop, restart, and check status via the command palette
- **Status bar** — Shows container state (stopped/starting/running/error)
- **Embedded terminal** — xterm.js terminal connected to ttyd via WebSocket, themed to match Obsidian
- **Settings UI** — Configure Docker Compose path, WSL distro, ttyd port/credentials, auto-start/stop
- **Auto-lifecycle** — Optionally start the container when the plugin loads and stop it on unload

## Prerequisites

- **Windows** with WSL2 installed
- **Docker Engine** installed inside WSL2 (not Docker Desktop on Windows)
- **WSL2 mirrored networking** — add to `%USERPROFILE%\.wslconfig`:
  ```ini
  [wsl2]
  networkingMode=mirrored
  ```
  Then restart WSL: `wsl --shutdown`
- A **pkm-workspace** repo (or equivalent) with a `docker-compose.yml` that runs ttyd on port 7681
- The container must include: `ttyd`, `tmux`, Claude Code CLI
- `ANTHROPIC_API_KEY` set as an environment variable in WSL

## Building

```bash
# Clone the repo
git clone https://github.com/artislismanis/obsidian-claude-sandbox.git
cd obsidian-claude-sandbox

# Install dependencies
npm install

# Build the plugin
npm run build
```

This produces `main.js` in the repo root.

### Development

```bash
# Watch mode (rebuilds on file changes)
npm run dev

# Run all checks (lint + format + typecheck + tests)
npm run check

# Individual commands
npm run lint        # ESLint
npm run format      # Prettier (auto-fix)
npm run test        # Vitest
npm run test:watch  # Vitest in watch mode
```

Pre-commit hooks (via husky) automatically lint and format staged files.

## Installing

1. Build the plugin (see above)
2. Create the plugin directory in your vault:
   ```
   mkdir -p /path/to/vault/.obsidian/plugins/pkm-claude-terminal
   ```
3. Copy the built files:
   ```
   cp main.js manifest.json styles.css /path/to/vault/.obsidian/plugins/pkm-claude-terminal/
   ```
4. Restart Obsidian
5. Go to **Settings > Community Plugins** and enable **PKM Claude Terminal**

## Getting started

1. **Configure the plugin** — Open Settings > PKM Claude Terminal:
   - Set **Docker Compose file path** to the WSL path of your `docker-compose.yml` (e.g., `/home/user/pkm-workspace`)
   - Set **WSL distro name** (default: `Ubuntu`)
   - Adjust ttyd port/credentials if your container uses non-default values

2. **Start the container** — Open the command palette (`Ctrl+P`) and run **PKM: Start Container**. The status bar should show "PKM: ▶ Running".

3. **Open the terminal** — Click the terminal icon in the left ribbon, or run **Open Claude Terminal** from the command palette. The terminal pane opens in the right sidebar.

4. **Use Claude Code** — You're now in a tmux session inside the container with Claude Code available. Your vault is mounted at `/workspace/vault`.

## Terminal keyboard shortcuts

| Action | Shortcut |
|--------|----------|
| **Copy** | `Shift` + select text with mouse — auto-copied to clipboard |
| **Copy word** | `Shift` + right-click a word |
| **Paste** | `Ctrl+Shift+V` |
| **Interrupt (SIGINT)** | `Ctrl+C` |

Hold `Shift` while selecting to bypass tmux's mouse capture. Standard `Ctrl+C` sends an interrupt to the shell as expected. tmux keybindings (e.g., `Ctrl+B` then `C` for new window) work normally.

## Commands

| Command | Description |
|---------|-------------|
| **Open Claude Terminal** | Open or reveal the terminal pane |
| **PKM: Start Container** | Run `docker compose up -d` |
| **PKM: Stop Container** | Run `docker compose down` |
| **PKM: Container Status** | Show `docker compose ps` output |
| **PKM: Restart Container** | Run `docker compose restart` |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| Docker Compose file path | *(empty)* | Absolute WSL path to the directory containing `docker-compose.yml` |
| WSL distro name | `Ubuntu` | The WSL distribution to use for Docker commands |
| ttyd port | `7681` | Port where ttyd listens inside the container |
| ttyd username | `user` | Username for ttyd basic auth (if enabled) |
| ttyd password | *(empty)* | Password for ttyd basic auth. Stored in plaintext in the vault. |
| Auto-start on load | `off` | Start the container when the plugin loads |
| Auto-stop on unload | `off` | Stop the container when the plugin is disabled |

## Project structure

```
src/
├── main.ts             # Plugin entry point, lifecycle, commands
├── settings.ts         # Settings interface, defaults, settings tab
├── docker.ts           # Container management via WSL → Docker Compose
├── status-bar.ts       # Status bar indicator
├── terminal-view.ts    # xterm.js terminal view with ttyd WebSocket
├── ttyd-client.ts      # ttyd polling, auth, URL construction
└── __tests__/          # Vitest unit tests
```

## License

MIT
