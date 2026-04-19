# Tutorial: getting started

First-time setup through running Claude Code inside the sandbox. You'll install the plugin, point it at your Obsidian vault, start the container, and open a terminal running Claude Code.

## Prerequisites

- **Obsidian** ≥ 1.5.
- **Docker** installed and running. On Windows we assume WSL2 + Docker Desktop (or Rancher Desktop in Docker-compat mode). On macOS / Linux, Docker Desktop or native.
- **This repository cloned somewhere** outside your vault (e.g. `~/code/obsidian-agent-sandbox`). The container build happens from there.
- A test vault. If you're nervous about this, create a fresh empty vault for your first run.

## 1. Build the container

```bash
cd ~/code/obsidian-agent-sandbox/container
docker compose build
```

This produces `oas-sandbox:latest` (~800 MB). Takes a few minutes the first time.

## 2. Install the plugin

Until Phase 2 ships a BRAT-compatible release, install manually:

```bash
cd ~/code/obsidian-agent-sandbox/plugin
npm install
npm run build
```

Copy the contents of `plugin/dist/` into `<your-vault>/.obsidian/plugins/obsidian-agent-sandbox/`. Create the folder if it doesn't exist.

Restart Obsidian → **Settings → Community plugins → Agent Sandbox → enable**.

## 3. Point it at your compose file

**Settings → Agent Sandbox → General**:

- **Docker mode**: `WSL` (Windows) or `Local` (macOS/Linux).
- **Compose file path**: the absolute path to `~/code/obsidian-agent-sandbox/container/`.
- **WSL distro name**: only matters in WSL mode — default `Ubuntu`.

The settings tab validates the path on input — a green tick means Obsidian can see `docker-compose.yml`.

## 4. Start the container

Click the box-icon in the ribbon → **Start container**, or run the command **Sandbox: Start Container**.

The status bar cycles through:
- `Sandbox: ⏳ Starting`
- `Sandbox: ▶ Running` once ttyd responds.

If a port is already in use, a Notice explains which one. Free it (close whatever else is listening on 7681 or 28080) and retry.

## 5. Open a terminal

Ribbon → **Open Sandbox Terminal**, or command **Open Sandbox Terminal**, or `obsidian://agent-sandbox/open-terminal`.

A new Obsidian tab opens hosting xterm.js connected to the container's ttyd. You should see a bash prompt.

## 6. Run Claude Code

At the prompt:

```bash
claude
```

Claude Code's TUI comes up. On first run it'll prompt for authentication (browser flow). Your auth persists in the `oas-claude-config` volume across container rebuilds.

Try something safe:

> List the first 5 files in my vault.

Claude should use its filesystem tools (via the sandboxed container) to respond.

## 7. Try the MCP integration

The plugin ships an MCP server at `localhost:28080` that Claude Code can call. Ask Claude:

> Search my vault for notes about "project planning".

You should see it use `vault_search` (via the MCP server) and return structured results with metadata, not just raw greps.

## What's next?

- **Settings → Agent Sandbox → MCP** — opt into escalations as you get comfortable: `writeReviewed` for human-in-the-loop writes outside the workspace directory, `extensions` for Dataview/Templater/Tasks integration.
- Read `tutorials/first-agent-task.md` for a walk-through on a real task.
- Read `explanation/security-model.md` to understand what the sandbox does and doesn't protect against.
