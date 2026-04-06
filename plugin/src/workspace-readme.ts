export const WORKSPACE_README = `# Agent Sandbox Workspace

This folder is the read-write workspace for the Agent Sandbox container.
The rest of your vault is mounted **read-only** inside the container.

## Quick start

1. Open the terminal: **Command palette \u2192 Open Sandbox Terminal** (or click the box icon in the ribbon)
2. The terminal connects to a Docker container running Claude Code
3. Files the agent creates appear here in your vault automatically

## How it works

- **Your vault** is mounted at \`/workspace/vault/\` inside the container (read-only)
- **This folder** is mounted at \`/workspace/vault/<write-dir>/\` (read-write)
- The agent can read your notes but only write to this workspace folder
- Each terminal tab opens a separate tmux session in the same container

## Settings

Open **Settings \u2192 Agent Sandbox** for configuration:

| Tab | What's there |
|-----|-------------|
| **General** | Docker mode, compose path, vault write directory, auto-start/stop |
| **Terminal** | Port, bind address, credentials, theme, font |
| **Advanced** | Memory/CPU limits, allowed private hosts, auto-enable firewall |

## Security

- **Firewall**: Click the \uD83D\uDEE1 shield in the status bar (or use the context menu) to toggle the outbound firewall. When enabled, the container can only reach: Anthropic API, npm, GitHub, PyPI, and configured private hosts.
- **Resource limits**: Memory and CPU are capped (configurable in Advanced settings)
- **Credentials**: Set a ttyd username/password in Terminal settings for authentication

## Troubleshooting

- **Container won't start**: Check that Docker is running and the compose path is correct in settings
- **Terminal shows "Connection closed"**: The container may have stopped \u2014 check status via the status bar menu
- **Can't reach a local service**: Add its IP to "Allowed private hosts" in Advanced settings
`;
