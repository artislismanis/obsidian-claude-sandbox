# How to release

Maintainer-only guide for cutting a new plugin release. End-users should follow `install-via-brat.md` instead.

## Prerequisites (one-time per maintainer)

- Push access to the GitHub repo.
- Local git configured so pushes work without prompts.
- A **Personal Access Token with `workflow` scope** if you need to push changes to `.github/workflows/*` — the default auth may lack this scope. Classic PAT or fine-grained PAT with "Workflows: Read and write" both work.
- Node 22+ and `npm ci` clean in `plugin/`.

## What a release consists of

Each tagged release on GitHub gets three attached assets:

- `main.js` — bundled plugin code (minified)
- `manifest.json` — plugin metadata with the new version
- `styles.css` — xterm.js + plugin styles

BRAT downloads these three files by the latest tag and drops them into the user's `<vault>/.obsidian/plugins/obsidian-agent-sandbox/`.

## Version scheme

Semantic-style, but pre-1.0 is treated as beta. Tag format is bare `N.N.N` — no `v` prefix (enforced by `plugin/.npmrc`).

`plugin/versions.json` maps each plugin version to the minimum Obsidian app version it requires. `manifest.json` has `minAppVersion` as the current floor. Don't raise the floor lightly — users on older Obsidian versions silently stop getting updates.

## Release procedure

All commands run from repo root unless noted.

### 1. Pre-flight

```bash
cd plugin
npm ci
npm run check
```

All 307+ unit tests green, lint clean, format clean, type-check clean. If anything fails, fix before proceeding.

Optional but strongly recommended:

```bash
npm run test:integration   # needs Docker + oas-sandbox:latest
npm run test:e2e:headless  # needs xvfb or local display
```

### 2. Update the changelog (optional)

We don't ship a separate `CHANGELOG.md` — GitHub Release auto-generates notes from commit messages (`generate_release_notes: true` in `release.yml`). If you want curated notes, draft them in the Release UI after the workflow creates the Release.

### 3. Bump the version

```bash
cd plugin
npm version 0.2.0    # replace with your target version
```

This runs several things in order:

1. Updates `package.json` version to `0.2.0`.
2. Invokes `node version-bump.mjs` via the `"version"` script.
    - Rewrites `manifest.json` `version` → `0.2.0`.
    - Appends `"0.2.0": "<minAppVersion>"` to `versions.json`.
    - Stages both files.
3. Creates a commit containing `package.json`, `manifest.json`, `versions.json`.
4. Creates tag `0.2.0` (no `v` prefix — `.npmrc` sets `tag-version-prefix=""`).

If `npm version` fails partway, see "Recovering from a botched release" below.

### 4. Push commit + tag

```bash
git push
git push --tags
```

The tag push triggers `.github/workflows/release.yml`:

- Checks out at the tag.
- Verifies `GITHUB_REF_NAME` matches `manifest.json.version` (refuses if out of sync).
- `npm ci && npm run build`.
- Creates a **pre-release** GitHub Release named `0.2.0` with `dist/main.js`, `dist/manifest.json`, `dist/styles.css` attached.
- Auto-generates release notes from commits since the previous tag.

Watch the workflow: `gh run watch` or visit the Actions tab in the repo.

### 5. Verify the Release

Once the workflow is green:

1. **Assets present** — GitHub → Releases → `0.2.0` → confirm `main.js`, `manifest.json`, `styles.css` download.
2. **Pre-release flag** — the Release is marked "Pre-release" (controlled by `prerelease: true` in the workflow). Flip it off in the UI when you're ready to ship a stable.
3. **BRAT install** — in a clean Obsidian profile:
    - Command palette → **BRAT: Add a beta plugin for testing**.
    - Paste the repo URL (e.g. `https://github.com/artislismanis/obsidian-agent-sandbox`).
    - BRAT downloads the three assets. Enable the plugin. Confirm it starts and the settings tab renders.

### 6. Post-release

If the release is stable (not pre-release):

1. Uncheck "Pre-release" on the GitHub Release.
2. Remove `prerelease: true` from `.github/workflows/release.yml` once Phase 6 (community plugin submission) lands.

If critical bug found immediately:

1. Fix on `main`.
2. Bump to `0.2.1` and cut a patch release.
3. Users on BRAT auto-update on next Obsidian start.

## Recovering from a botched release

### `npm version` committed but tag rejected by remote

```bash
# Check state
git log --oneline -3
git tag --list | head

# If the local commit is unpushed, just delete the tag locally and try again
git tag -d 0.2.0
git reset --hard HEAD~1   # discards the commit version-bump produced
```

Fix the underlying issue, then re-run step 3.

### Tag pushed but CI failed

- If the failure is in CI only (e.g. tests flaked), re-run the workflow from the Actions tab.
- If the failure is because of a bad commit, delete the remote tag, fix, re-tag:
    ```bash
    git push --delete origin 0.2.0
    git tag -d 0.2.0
    # fix stuff, commit
    cd plugin && npm version 0.2.0
    git push && git push --tags
    ```

### Wrong files attached

Delete the Release + tag from GitHub UI, then re-cut using the recovery steps above. BRAT users will pick up the replacement on next update check.

## First release checklist

For the very first `0.1.0 → 0.2.0` cut (Phase 2 finalisation):

- [ ] `.github/workflows/check.yml` and `.github/workflows/release.yml` are pushed to `main` (requires a PAT with `workflow` scope if the default auth lacks it).
- [ ] `plugin/versions.json`, `plugin/version-bump.mjs`, `plugin/.npmrc`, and the `"version"` script in `package.json` are on `main`.
- [ ] A clean `npm ci && npm run check` passes locally.
- [ ] CI's `check.yml` has run green on a PR at least once (confirms Node version + deps resolve on GitHub runners).
- [ ] Run the procedure for `0.2.0`. Verify the Release, then do a clean-profile BRAT install to confirm the assets land correctly.
