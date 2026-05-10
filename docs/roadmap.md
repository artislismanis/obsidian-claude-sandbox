# Roadmap

What's left to do. Implemented work has been removed; the git log is the source of truth for what shipped.

## Pre-1.0 stabilisation

- [ ] First BRAT-compatible release — bump version, push the tag, verify the GitHub Release and a clean BRAT install (see `docs/how-to/release.md`).
- [ ] Capture a GIF or screenshot of the core workflow for the top of the README.
- [ ] Optional audible or tray notification when Claude transitions to "awaiting input" after a long-running task.

## Community plugin submission

Pre-condition: BRAT release stabilised and beta feedback addressed.

- [ ] Drop the `--prerelease` flag from `release.yml`.
- [ ] Confirm `manifest.json` meets the obsidianmd/obsidian-releases review checklist.
- [ ] Final pass over user-facing docs.
- [ ] Open the submission PR against `obsidianmd/obsidian-releases`.
- [ ] Address review feedback.

## Out of scope (intentional)

These come up periodically but are not planned — recording them so we don't re-litigate.

- **Format-aware Obsidian conventions inside the plugin.** Wikilinks / callouts / embeds / properties are handled by [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) packaged as standalone skills, not by this plugin's MCP layer.
- **Visible test counts in docs.** Counts drift faster than they get updated; the suites' own pass/fail summaries are authoritative.

## Ecosystem references

Projects studied for patterns and tool design:

| Project | What we borrowed |
|---------|------------------|
| [kepano/obsidian-skills](https://github.com/kepano/obsidian-skills) | Format-aware tooling (packaged separately as standalone skills) |
| [MarkusPfundstein/mcp-obsidian](https://github.com/MarkusPfundstein/mcp-obsidian) | Simplicity-first tool design |
| [coddingtonbear/obsidian-local-rest-api](https://github.com/coddingtonbear/obsidian-local-rest-api) | Surgical editing patterns, PATCH operations |
| [cyanheads/obsidian-mcp-server](https://github.com/cyanheads/obsidian-mcp-server) | Search-replace, frontmatter management, caching |
| [aaronsb/obsidian-mcp-plugin](https://github.com/aaronsb/obsidian-mcp-plugin) | Graph traversal, Dataview integration, security model, workflow hints |
