# Security model

The sandbox balances "let Claude actually do useful things" against "don't let Claude damage the user's vault or escape to the host". Four layers work together.

## Layer 1 — Filesystem isolation

- The vault is mounted **read-only** at `/workspace/vault/` inside the container.
- Exactly one subdirectory — `$PKM_WRITE_DIR` (default `agent-workspace/`) — is mounted **read-write**. `.oas/` is also rw (memory + audit).
- Writes to any other vault path fail with `EROFS` at the kernel level, regardless of what Claude or any agent running inside the container tries to do.
- Everything under `workspace/` on the host is rw inside the container; it's explicitly Claude's domain.

This is the ground-truth invariant. The tiers and review flows layer additional controls on top, but kernel-level `ro` is the reason the vault is fundamentally safe.

## Layer 2 — Outbound firewall

`init-firewall.sh` restricts outbound traffic to a curated allowlist. Default-deny; only traffic to Anthropic/GitHub/npm/PyPI/CDNs/apt mirrors is permitted. The firewall lives inside the container (iptables + ipset) and must be re-applied on container start.

Extension is user-driven via two additive sources:

- **Plugin setting** `additionalFirewallDomains` → env var `OAS_ALLOWED_DOMAINS` → tagged `[plugin]`. Discoverable via settings UI; visible to Claude via `env`.
- **Host-managed file** `container/firewall-extras.txt` mounted read-only at `/etc/oas/firewall-extras.txt` → tagged `[file]`. Not inside `/workspace`, not writable by Claude.

See `how-to/configure-firewall.md` for adding entries and `--list-sources` for auditing.

## Layer 3 — MCP permission tiers

The MCP server's tools are split into two kinds of tier:

**Always-on (capabilities)** — enabled whenever MCP is on:
- `read` — search, read, metadata, tags, links, backlinks, frontmatter.
- `writeScoped` — create/modify within `$PKM_WRITE_DIR`.
- `agent` — `agent_status_set` activity signal (not file access; UI only).

**Gated (escalations)** — off by default; each opt-in grants access beyond filesystem:
- `writeReviewed` — vault-wide writes that pop a human-in-the-loop diff modal before applying.
- `writeVault` — vault-wide writes with no review. Highest risk.
- `navigate` — open files and affect the Obsidian UI.
- `manage` — rename/move/delete (with auto link-updates).
- `extensions` — access third-party plugin APIs (Dataview, Templater, Tasks, Periodic Notes, Canvas).

`read` / `writeScoped` are "always on" because they don't grant anything Claude doesn't already have via the filesystem — they just offer an ergonomic Obsidian-metadata-aware interface.

## Layer 4 — Human-in-the-loop review

When `writeReviewed` is enabled, all 11 write ops (`create`, `modify`, `append`, `prepend`, `patch`, `search_replace`, `frontmatter_set`, `frontmatter_delete`, `rename`, `move`, `delete`) route through `runWrite` → `DiffReviewModal`. The modal shows:

- For content edits: a unified diff of old vs new.
- For frontmatter edits: JSON-stringified old vs new FM.
- For rename/move/delete: the operation description + a list of notes whose wikilinks reference the target (from `resolvedLinks`).

The gate is **structural**: every write handler in `mcp-tools.ts` constructs a `runWrite` call, so there's no path that mutates without passing through the review step. Adding a new write op requires explicitly opting-out of review — not the default.

Batch operations (`vault_batch_frontmatter`) use a separate `BatchReviewModal` with per-item checkboxes so the user can approve a subset.

## Layer 5 — Rate limiting + audit

- **Rate limit** per tool: token-bucket, 60/min for read tier and navigate, 20/min for writes.
- **Audit log** — in-memory ring buffer of 200 entries, plus append-only JSONL at `vault/.oas/mcp-audit.jsonl` with 1 MB single-generation rotation. `GET /mcp/audit` returns the ring buffer.

Neither layer prevents malicious use — they make it visible after the fact.

## Threat model notes

**Trusted**:
- You (the user) running Obsidian on your machine.
- Claude as an agent, under the observation of a human in the loop.

**Not trusted**:
- Arbitrary code the agent might execute or download.
- Outbound connections to hosts other than the baseline allowlist.
- Symlinks or paths that escape the vault (Layer 1 is complemented by `isRealPathWithinBase` inside resolveFile so symlinked escapes from the agent get caught before filesystem ops).

**Out of scope**:
- Side-channel attacks (timing, power).
- Hostile Obsidian plugins running in the user's vault — those are outside the sandbox's control.
- Compromise of the host system by Docker / WSL2 bugs. Keep your container runtime patched.
