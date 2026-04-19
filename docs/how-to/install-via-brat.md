# How to install via BRAT

Once Phase 2 release automation ships a tagged GitHub Release, you can install via Obsidian's [BRAT plugin](https://github.com/TfTHacker/obsidian42-brat) without cloning the repo.

## One-time BRAT setup

1. Obsidian → **Settings → Community plugins** → **Browse** → install **BRAT**.
2. Enable BRAT.

## Install this plugin via BRAT

1. Command palette → **BRAT: Add a beta plugin for testing**.
2. Paste: `https://github.com/artislismanis/obsidian-agent-sandbox` (or whatever the repo URL is).
3. BRAT downloads the latest GitHub Release assets (`main.js`, `manifest.json`, `styles.css`) into `<vault>/.obsidian/plugins/obsidian-agent-sandbox/`.
4. **Settings → Community plugins** → enable **Agent Sandbox**.

## Updates

BRAT checks for new releases on Obsidian start. To force an immediate check: **BRAT: Check for updates to beta plugins**.

To pin to a specific version: **BRAT: Switch a beta plugin to a different version**.

## Still need the container

Installing the plugin does not install the container. You still need:
- Docker running on the host.
- This repo cloned, so `cd container && docker compose build` can produce `oas-sandbox:latest`.
- The Compose file path set in the plugin settings.

See `tutorials/getting-started.md` for the full first-run flow.
