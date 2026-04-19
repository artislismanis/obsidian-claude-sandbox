# Design decisions

Notable choices in the plugin's design, with their reasoning. The rest of the architecture is in `architecture.md`.

## Why a three-way split (plugin / container / workspace)?

The alternative is one folder with everything. The split enforces a property via structure:

- **`container/`** is NOT mounted inside the running container. Claude running as an agent cannot read or modify the Dockerfile, compose config, or firewall script. Anyone editing `container/` is doing infra work, knowingly.
- **`workspace/`** IS mounted rw. Claude legitimately writes to `.claude/settings.json`, `skills/`, `prompts/`, and so on.
- **`plugin/`** runs on the host; the container never sees it.

This is enforced by what docker-compose mounts, not by convention. Breaking it requires editing `docker-compose.yml`, which is itself outside the container.

## Why MCP over a file-based protocol for activity signalling?

File-based signalling (agent writes state to a well-known path; plugin watches) was the first design. MCP won because:

- **Standardized.** Any MCP-capable agent can discover the tool via `tools/list` — no ad-hoc path convention.
- **Reuses infrastructure.** Auth, rate limiting, audit log already exist for vault tools. No new file watcher, no cross-platform `fs.watch` quirks.
- **Schema-validated.** Zod handles input validation on the same footing as every other tool.

The tradeoff: when MCP is disabled, the activity indicator is dead. Acceptable — if MCP is off, you don't have any of the vault integration either.

## Why two firewall-extension routes (setting + file)?

A single setting is discoverable but Claude can see it; a single host-side file is secure but invisible. Shipping both:

- **Setting** (`additionalFirewallDomains`) for domains you're happy to see in the UI — Atlassian, Slack, etc.
- **File** (`container/firewall-extras.txt`, mounted read-only outside `/workspace`) for corporate domains, internal services, or anything you'd rather the agent not know about.

Additive union; no precedence; `--list-sources` tags every entry with its origin so troubleshooting is straightforward.

## Why no separate permission toggle for read / writeScoped?

Earlier versions exposed all 7 MCP tiers as settings toggles. This misled users: "turning off `read` denies Claude access to vault content", which is false — Claude can always read the vault via filesystem. What the toggles actually controlled was whether the Obsidian-metadata-aware *tools* were registered, which is an ergonomics switch, not a permission gate.

The split: `read` and `writeScoped` (capability tiers — always on) vs the five escalation tiers (real permissions — user toggles). This keeps the mental model honest: **toggles exist for capabilities that go beyond filesystem access**.

## Why structural review-gate instead of per-handler calls?

Earlier: each write handler that cared called `requireReview`. Missed calls silently bypassed review — and we had one, caught during `/simplify`: `vault_append_reviewed` and five others were registered under the `writeReviewed` tier but never actually reviewed.

The fix: every write handler now routes through `runWrite`, which calls `requireReview` unconditionally. Forgetting review on a new handler is now a compile-time error (missing field) or a failing test — not a silent bypass.

## Why file-based audit log on top of the in-memory ring buffer?

The ring buffer (last 200 entries) is for the live `/mcp/audit` endpoint — cheap, always-current. Plugin restarts clear it.

The JSONL file at `vault/.oas/mcp-audit.jsonl` is the long-horizon record. Size-capped at 1 MB with single-generation rotation (`.1.jsonl`). Sink errors never block tool execution — audit is best-effort by design.

## Why chunked Promise.all over `vault.getMarkdownFiles()`?

`vault_search`, `vault_suggest_links`, and `vault_batch_frontmatter` all iterate the full markdown set. Loading everything concurrently spikes memory; iterating sequentially leaves RTT on the table. The `forEachMarkdownChunked` helper batches reads in groups of 20 — most of the parallelism win without the memory blowup.

## Why eager client-side ttyd probe before WebSocket?

`pollUntilReady` hits `/` on the ttyd port via `requestUrl` (which bypasses CORS) before opening the WebSocket. A WebSocket open failure is less debuggable than an HTTP 404 — knowing "ttyd isn't up yet" vs "ttyd is up but rejecting" is useful. Exponential backoff (500 ms × 1.5ⁿ, capped at 5s) keeps the initial probe fast without hammering on slow cold starts.

## Why moment-style formatter instead of pulling in moment?

Periodic Notes stores its format strings in moment.js syntax. To compute the right filename we need to format a date with that syntax. Options were:
1. Add a moment/dayjs dependency.
2. Use Obsidian's bundled moment (possible but tied to Obsidian's internal versioning).
3. Ship a minimal formatter covering the tokens Periodic Notes actually uses.

Option 3 wins on bundle size and deps. `formatDateByPattern` handles `YYYY`, `gggg`, `MM`, `DD`, `ww`, `Q`, and literal `[...]` blocks — covering the defaults and the vast majority of user-customised formats.
