# CLAUDE.md — Container (infra)

This folder contains the Docker image definition and supporting scripts for the Agent Sandbox. **Anyone editing files here is working on infrastructure, not on Claude's workspace** — be careful and always test the rebuild.

## What lives here

| File | Purpose |
|------|---------|
| `Dockerfile` | Container image definition (Ubuntu 24.04, Node 24, Python 3.12, Claude Code, ttyd, firewall tools) |
| `docker-compose.yml` | Service, mounts, resource limits, OAS naming |
| `.env.example` | Environment template (copy to `.env` for standalone CLI use) |
| `.dockerignore` | Excludes from the build context |
| `firewall-extras.txt` | Host-managed firewall allowlist extras (mounted read-only at `/etc/oas/firewall-extras.txt`; invisible to the agent) |
| `configs/` | Files copied into the image: `tmux.conf`, `session-helpers.sh` |
| `scripts/entrypoint.sh` | Container entrypoint — sets sudo password, drops to `claude`, runs ttyd |
| `scripts/session.sh` | Per-ttyd-connection session launcher |
| `scripts/init-firewall.sh` | Allowlist-based outbound firewall (run as root) |
| `scripts/verify.sh` | Environment verification / runtime manifest (also baked into image at `/usr/local/bin/verify.sh`) |

## Build

```bash
cd container
docker compose build
```

This produces `oas-sandbox:latest`. Start via the Obsidian plugin (preferred) or `docker compose up -d` after copying `.env.example` to `.env`.

## Not visible inside the running container

**This entire folder is deliberately not mounted inside the container.** Claude running as an agent inside the sandbox cannot read or modify Dockerfile, compose config, or scripts. That's by design — it keeps the build contract explicit and reviewable, and prevents accidental mutation of infrastructure from inside an agent session.

The one exception: `scripts/verify.sh` is `COPY`d into the image at `/usr/local/bin/verify.sh` so Claude can introspect runtime state at any time without needing source access.

## Adding a system tool

1. Add the package to the main `apt-get install` block in `Dockerfile` (keep the list alphabetized).
2. If the tool needs network access at runtime, add the relevant domains to the allowlist in `scripts/init-firewall.sh`.
3. Rebuild: `cd container && docker compose build`
4. Restart the container (via plugin or `docker compose down && up -d`).
5. Verify: `docker compose exec sandbox verify.sh` — the tool should appear under "Tool versions" or "Node globals".
6. Commit on a feature branch and open a PR. Never push infra changes directly to `main`.

## Firewall allowlist

`scripts/init-firewall.sh` restricts outbound traffic to a hardcoded allowlist. Editing the allowlist is a sensitive change — widening it relaxes the sandbox. Keep additions narrow and document why (comment above the entry).

For domains/CIDRs that should not live in source control (private endpoints, personal integrations), append them to `firewall-extras.txt` instead. That file is mounted read-only into the container, invisible to the agent, and applied automatically by `init-firewall.sh`. The plugin's "Additional firewall domains" setting is the user-friendly equivalent for shareable additions.

Currently allowed categories:
- Anthropic (API, statsig, sentry)
- npm (npmjs.org, yarnpkg.com)
- GitHub (github.com, api, raw, releases, cli)
- PyPI (pypi.org, files.pythonhosted.org)
- CDNs (jsdelivr, cdnjs, unpkg)
- Ubuntu apt mirrors (archive, security, ports, keyserver)

## Sudo model

The `claude` user has a narrow sudoers entry for `apt-get` and `apt` only, password-gated. The password is set at container start time from the `SUDO_PASSWORD` environment variable (passed in via docker-compose, typically from `container/.env` or the plugin's "Sudo password" setting). `entrypoint.sh` unsets `SUDO_PASSWORD` before dropping privileges, so the password is not visible inside session shells. See `README.md` "Development" section for the trust model and intended usage.

## Safety constraints for this folder

- Never weaken the firewall allowlist without clear justification
- Never grant the claude user broader sudo than `apt-get`/`apt`
- Never set `NOPASSWD` on the sudoers entry — the password gate is the human-intent signal
- Never mount `container/` inside the running container; that would break the isolation this layout is designed to enforce
- Rebuild and run `verify.sh` after any Dockerfile change before committing
