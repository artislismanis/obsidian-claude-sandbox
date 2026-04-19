# How to configure the container firewall

The sandbox container runs an allowlist-based outbound firewall. Traffic to unlisted domains is denied. The allowlist has three additive sources — the **effective** list is the union of all three.

## The three sources

| Source | Where it lives | Who controls it | Claude can see/modify? |
|---|---|---|---|
| `baseline` | `container/scripts/init-firewall.sh` | Project maintainers (git) | No — script isn't mounted |
| `plugin` | Obsidian plugin setting "Additional firewall domains" | User via plugin UI | No — env var only, not in `/workspace` |
| `file` | `container/firewall-extras.txt` | User (host filesystem) | No — mounted read-only at `/etc/oas/firewall-extras.txt`, outside `/workspace` |

All three are additive. There is no override precedence; duplicates are harmless.

## Which source to use

- **baseline** — only for fundamentally-shared domains (Anthropic, GitHub, npm, PyPI, apt mirrors). Changes go via PR.
- **plugin** — discoverable in the UI, validated on input. Best for integrations you're happy to see in Obsidian settings (e.g. `api.atlassian.com`, `slack.com`).
- **file** — best for rules you want the agent to not know about, or for personal/corporate domains you don't want in settings. Host-side editing, survives plugin settings resets.

## Adding a domain via the plugin setting

1. Settings → Agent Sandbox → Security tab.
2. Paste into "Additional firewall domains": `api.atlassian.com, slack.com`.
3. Restart the container (plugin prompts you).

## Adding a domain via the host file

Edit `container/firewall-extras.txt` on the host. One entry per line — domain or IPv4 CIDR. `#` starts a comment.

```
# Corporate Jira (doesn't need to be visible to Claude)
jira.corp.example
# Internal services
10.42.0.0/16
```

Restart the container (the file is read at container start). To keep personal edits out of git without gitignoring:

```bash
git update-index --skip-worktree container/firewall-extras.txt
```

To re-track:

```bash
git update-index --no-skip-worktree container/firewall-extras.txt
```

## Inspecting the effective allowlist

Two ways:

1. **Plugin UI** — Security tab → "Effective allowlist" → Refresh. Shows each entry tagged with its source.
2. **Container shell**:
   ```bash
   docker compose exec sandbox /usr/local/bin/init-firewall.sh --list-sources
   ```
   or for a broader runtime check:
   ```bash
   docker compose exec sandbox verify.sh
   ```
   Both print entries grouped by `[baseline]` / `[plugin]` / `[file]`.

## Troubleshooting

- **New domain I added doesn't connect.** Check the source is picked up: run `--list-sources` and confirm your domain is there. If it's missing, it's an input validation error (plugin setting) or a comment-stripped line (file).
- **DNS resolution fails for a domain.** The firewall script resolves A records at startup. A misspelled domain shows up as `WARNING: failed to resolve <domain>` in the container logs.
- **CIDR entry not taking effect.** The firewall script accepts IPv4 CIDRs in `firewall-extras.txt` only. The plugin setting validates domains only. For CIDRs, use the file route, or the existing "Allowed private hosts" setting.
- **"Claude can see my firewall rules."** That's correct for the baseline and plugin settings. Move the rule to `firewall-extras.txt` if hiding it matters.
