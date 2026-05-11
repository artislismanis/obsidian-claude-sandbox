# Agent Sandbox

An Obsidian plugin and containerized sandbox for working with your vault through AI coding agents. Start/stop the sandbox, manage terminals, and let Claude Code (or any MCP-capable agent) read/write vault content with human-in-the-loop review — all without leaving Obsidian.

## What it does

- **Embedded terminals.** xterm.js tabs inside Obsidian, each connected to a long-lived container shell or tmux session.
- **Sandboxed agent.** The vault is mounted read-only except for one write directory. Outbound traffic is firewalled to a curated allowlist. The agent can't escape its cage.
- **MCP integration.** A local HTTP MCP server exposes 30+ tools for searching, reading, writing, and navigating the vault with Obsidian-metadata awareness (tags, backlinks, frontmatter, the graph).
- **Human-in-the-loop writes.** The **Vault-wide writes** dropdown (None / Reviewed / Full) controls writes outside the workspace dir; pick **Reviewed** and every such write pops an Obsidian modal with a diff, approve or reject per operation.
- **Plugin API bridge.** Tools for Dataview, Tasks, Templater, Periodic Notes, and Canvas — delegated to the target plugin's own API when it's installed.
- **Activity feedback.** Claude Code reports working/idle/awaiting-input state via MCP; the terminal tab prefix and status bar show which session needs your attention.

## Architecture in one picture

```
Obsidian (host)
  ├── Plugin
  │    ├── Terminal views (xterm.js)          → ttyd in container
  │    ├── MCP HTTP server :28080             ← container calls back
  │    ├── Review modals, status bar, skills
  │    └── docker compose up/down, firewall ctl
  └── Vault files
        └── ro mount in container, except $OAS_VAULT_WRITE_DIR (rw)

Container (oas-sandbox)
  ├── Claude Code CLI + skills + hooks
  ├── tmux, ttyd, Node 24, Python 3.12
  ├── Outbound firewall (allowlist)
  └── Workspace files (rw, committable)
```

## Getting started

The tutorials are the fastest way in:

- [**Getting started**](docs/tutorials/getting-started.md) — first-time setup through running Claude.
- [**First agent task**](docs/tutorials/first-agent-task.md) — walk through a real Claude + vault task, including the review flow.

## Documentation

Organized per [Diátaxis](https://diataxis.fr/): four quadrants by purpose.

### Tutorials (learning, practical)
- [Getting started](docs/tutorials/getting-started.md)
- [First agent task](docs/tutorials/first-agent-task.md)

### How-to guides (working, practical)
- [Install via BRAT](docs/how-to/install-via-brat.md)
- [Configure the firewall](docs/how-to/configure-firewall.md)
- [Keep sessions alive across restarts](docs/how-to/persistent-sessions.md)
- [Use multiple terminals](docs/how-to/use-multiple-terminals.md)
- [Add tools to the container](docs/how-to/add-tools-to-container.md)
- [Customize the workspace](docs/how-to/customize-workspace.md)
- [Update the plugin](docs/how-to/update-plugin.md)
- [Troubleshoot terminal disconnects](docs/how-to/troubleshoot-terminal-disconnects.md)
- [Release a new version](docs/how-to/release.md) — maintainers only

### Reference (working, theoretical)
- [Commands](docs/reference/commands.md)
- [Settings](docs/reference/settings.md)
- [Keyboard shortcuts](docs/reference/keyboard-shortcuts.md)
- [Docker resources](docs/reference/docker-resources.md)
- [Project structure](docs/reference/project-structure.md)

### Explanation (learning, theoretical)
- [Architecture](docs/explanation/architecture.md)
- [Security model](docs/explanation/security-model.md)
- [Container lifecycle](docs/explanation/container-lifecycle.md)
- [Design decisions](docs/explanation/design-decisions.md)

### Project meta

Outside the four Diátaxis quadrants — these are about the project itself rather than how to use, configure, or understand the sandbox.

- [Roadmap](docs/roadmap.md)
- [Testing](docs/testing.md) — three automated layers (unit / integration / e2e)

## Requirements

- Obsidian ≥ 1.5
- Docker (Docker Desktop / Rancher Desktop / native)
- Windows: WSL2 (if using rootless Docker inside WSL, enable `loginctl enable-linger` and `systemctl --user enable --now docker` — see [getting-started](docs/tutorials/getting-started.md#troubleshooting))

## Releases

Tagged releases are automated via GitHub Actions. Full maintainer procedure in [`docs/how-to/release.md`](docs/how-to/release.md). Short version:

```bash
cd plugin
npm version 0.2.0       # bumps package.json + manifest.json + versions.json, auto-tags 0.2.0
git push && git push --tags
```

The `release.yml` workflow fires on the tag, builds, and uploads `main.js` / `manifest.json` / `styles.css` to a pre-release GitHub Release. BRAT users pick up updates on Obsidian start.

## Development

Working on the plugin or the container itself:

```bash
cd plugin
npm install
npm run check        # lint + format + tsc + unit tests (run before committing)
npm run dev          # esbuild watch mode while iterating
npm run test:integration   # requires Docker + a built oas-sandbox:latest
npm run test:e2e:headless  # requires xvfb on Linux, otherwise test:e2e
```

The pre-commit hook runs `lint-staged` on staged files. CI runs `check` on every PR touching `plugin/`. See `docs/testing.md` for the three test layers and `plugin/CLAUDE.md` for module-level architecture notes.

### Trust model

The `claude` user inside the container has narrow sudo for `apt-get` / `apt` only, gated by a password set at container start from `OAS_SUDO_PASSWORD` (sourced from the plugin's "Sudo password" setting or `container/.env`). `entrypoint.sh` unsets the variable before dropping privileges, so the password is never visible inside session shells. The narrow sudo is a *human-intent gate* — it forces deliberate, password-typed installs in interactive sessions while preventing the agent from making unattended system changes. If a tool proves useful, promote it to `container/Dockerfile` in a reviewable PR rather than re-installing on every restart.

`container/` is **not mounted into the container** — Dockerfile, compose config, scripts, and `firewall-extras.txt` are invisible from inside, so an agent session cannot mutate the build contract. The single exception is `verify.sh`, which is COPY'd into the image so Claude can introspect runtime state.

Branch protection: never push infra changes (`container/`, `.github/workflows/`) directly to `main`. Open a PR.

## Status

Under active development, pre-1.0. Tagged releases are published via CI; community plugin submission follows beta stabilisation. See [roadmap](docs/roadmap.md).

## License

[MIT](LICENSE)
