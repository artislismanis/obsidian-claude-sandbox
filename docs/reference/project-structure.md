# Reference: project structure

```
obsidian-agent-sandbox/
├── plugin/            Obsidian plugin source (TypeScript, xterm.js, esbuild)
│   ├── src/
│   │   ├── main.ts              Plugin entry; commands; MCP wiring; UI routing
│   │   ├── settings.ts          Settings interface + tabbed UI + tier derivation
│   │   ├── docker.ts            DockerManager: WSL/local compose commands + firewall
│   │   ├── status-bar.ts        StatusBarManager + FirewallStatusBar
│   │   ├── terminal-view.ts     TerminalView: xterm.js + WebSocket to ttyd
│   │   ├── ttyd-client.ts       Pure polling + URL building
│   │   ├── validation.ts        Shared input validators (used by settings + docker)
│   │   ├── mcp-server.ts        ObsidianMcpServer (HTTP, auth, audit, activity)
│   │   ├── mcp-tools.ts         Tool registry across all tiers (big file)
│   │   ├── mcp-extensions.ts    Plugin-integration tools (Canvas, Dataview, Tasks, Templater, Periodic Notes)
│   │   ├── mcp-cache.ts         VaultCache — metadata-invalidated graph cache
│   │   ├── diff-review-modal.ts DiffReviewModal + BatchReviewModal
│   │   └── prompt-template.ts   parsePromptTemplate + substituteFilePlaceholder
│   ├── test/                    Integration + e2e tests
│   └── package.json
│
├── container/         Docker image definition + scripts (NOT mounted in the running container)
│   ├── Dockerfile
│   ├── docker-compose.yml
│   ├── firewall-extras.txt      Host-managed firewall allowlist extras
│   └── scripts/
│       ├── entrypoint.sh
│       ├── session.sh
│       ├── init-firewall.sh
│       └── verify.sh            Also baked into image at /usr/local/bin/verify.sh
│
├── workspace/         Claude's domain — mounted rw at /workspace/ inside the container
│   ├── CLAUDE.md                Rules the agent follows inside the sandbox
│   ├── .claude/
│   │   ├── settings.json        Claude Code project settings (permission mode, hooks)
│   │   ├── skills/              Project skills (6 shipped)
│   │   ├── hooks/               Lifecycle hook scripts (notify-status.sh)
│   │   ├── prompts/             "Analyze in Sandbox" template library
│   │   └── scripts/             Statusline, helpers
│   └── vault/                   (not in git; mounted from user's vault path)
│
└── docs/              Host-facing documentation (Diátaxis structure)
    ├── tutorials/
    ├── how-to/
    ├── reference/               You are here
    ├── explanation/
    ├── roadmap.md
    └── testing.md
```

## Architectural split

Three folders own three different concerns:

- **`plugin/`** — the Obsidian plugin. Runs on the host, drives the container.
- **`container/`** — infra. The image definition and scripts the container runs. Deliberately not mounted inside the running container so Claude (as agent) cannot modify its own environment.
- **`workspace/`** — Claude's configurable domain. Mounted rw inside the container. Contains Claude Code config, skills, hooks, prompts — the stuff Claude legitimately writes to.

See `explanation/architecture.md` for the rationale and the three-tier extensibility model.
