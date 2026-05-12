# How to add tools to the container

Two paths: at container build time (permanent, shared with anyone who builds this image) or at runtime via sudo (personal, lost on rebuild).

## Runtime — for trying things out

Inside a terminal tab:

```bash
sudo apt-get update
sudo apt-get install -y <package>
```

The container's sudoers entry permits `apt-get` and `apt` only, password-gated on the `sudoPassword` plugin setting (default empty — sudo is disabled until you set a password explicitly in **Settings → Agent Sandbox → Advanced → Sudo password**, or via `OAS_SUDO_PASSWORD` in `container/.env`). You can't `sudo su` or run arbitrary commands.

The install sticks until the next container rebuild. Good for trying out a tool; not good for permanent additions.

## Build time — the right way for additions you'll keep

Edit `container/Dockerfile`. The main `apt-get install` block is alphabetized; add your package there:

```dockerfile
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    curl \
    <your-new-package> \
    wget
```

Rebuild:

```bash
cd container
docker compose build
```

Restart the container (or toggle via the plugin).

Verify: `cd container && docker compose exec sandbox verify.sh` should show your tool in "Tool versions" if it's a recognised one, otherwise `which <name>` inside a terminal tab.

## If the tool needs network access

Remember the firewall. By default, only the curated allowlist is reachable (see `configure-firewall.md`). If your new tool phones home to a domain not on the baseline list, add the domain:

- **Plugin setting → Additional firewall domains**, or
- **`container/firewall-extras.txt`** for host-managed rules Claude can't see.

## If it's a Node / Python global

Use the container's built-in package managers — the image ships Node 24 and Python 3.12:

```bash
npm install -g <package>
# or — Python uses uv (no system pip on PATH for the `claude` user):
uv pip install <package>     # into the active uv-managed env
pipx install <package>       # for standalone CLI tools
```

Runtime installs do **not** persist across a container rebuild. Node globals live under `~/.nvm/default/lib/node_modules` and Python tools under `~/.local` — neither path is on a named volume, so a rebuild wipes them. (The `oas-claude-config` volume holds Claude Code auth, project settings, and chat history only — not language package globals.) For tools you want permanently, add them to the Dockerfile's `RUN npm install -g ...` / uv install block and rebuild.

## Safety note

Widening `apt-get` via rebuild or via `firewall-extras.txt` is a sensitive change. Each new tool is a potential target for supply-chain issues. Keep additions narrow; document the reason in the Dockerfile comment.
