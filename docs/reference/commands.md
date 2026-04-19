# Reference: commands

Every command registered by the plugin. Access via Obsidian's command palette (`Ctrl`/`Cmd` + `P`).

| Command | ID | What it does |
|---|---|---|
| Open Sandbox Terminal | `open-claude-terminal` | Opens a new terminal tab, or activates an existing one. Prompts to start the container if it's stopped. |
| Open Sandbox Session… | `open-session` | Prompts for a tmux session name, then opens a terminal attached to that session (creates it if new). |
| Open Sandbox in Browser | `open-browser` | Opens the ttyd URL in the system default browser. |
| Sandbox: Start Container | `sandbox-start-container` | `docker compose up -d`. Runs port-conflict pre-flight first. |
| Sandbox: Stop Container | `sandbox-stop-container` | `docker compose down`. |
| Sandbox: Restart Container | `sandbox-restart-container` | Explicit clean `down` + `up -d`. |
| Sandbox: Container Status | `sandbox-container-status` | Probe + show status notice. |
| Sandbox: Toggle Firewall | `sandbox-toggle-firewall` | Enable / disable the container's outbound firewall. |
| Sandbox: Toggle MCP Server | `sandbox-toggle-mcp` | Start / stop the in-plugin MCP HTTP server. |
| Sandbox: Clean up empty sessions | `sandbox-cleanup-sessions` | Lists unattached tmux sessions, confirmation modal, kills selected. |
| Sandbox: Switch to Sandbox session… | `sandbox-switch-session` | Modal picker over currently open terminal tabs. |

## URI handlers

| URI | What it does |
|---|---|
| `obsidian://agent-sandbox/open-terminal` | Activate or open a terminal tab. |
| `obsidian://agent-sandbox/analyze?path=<path>&template=<name>` | Open a terminal, start Claude Code, inject a templated prompt. `template` name matches a file in `workspace/.claude/prompts/`. |

## Context-menu action

Right-click any vault file → **Analyze in Sandbox** → submenu listing prompt templates from `workspace/.claude/prompts/`. Picks load the template, substitute `{{file}}` with the clicked note's path, open a terminal, and type `claude '<prompt>'`. When the templates directory is empty, a single **Custom prompt…** modal fallback appears.
