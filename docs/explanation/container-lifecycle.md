# Container lifecycle

How the plugin manages the `oas-sandbox` container across Obsidian start/stop, Docker state changes, and out-of-band modifications.

## States

`StatusBarManager.ContainerState` encodes the lifecycle:

| State | Meaning |
|---|---|
| `stopped` | No container or container not running. |
| `starting` | `docker compose up -d` in flight. |
| `running` | Container is up; ttyd responds. |
| `error` | Docker/WSL error — surfaced in status bar tooltip. |
| `checking` | Transient probe-in-progress state. |

## Startup sequence

On Obsidian load (`onLayoutReady`):

1. Status → `checking`, detail cycles "checking Docker availability… → probing WSL (5s fast-fail)… → probing container status… → docker compose up -d (auto-start)…".
2. `docker.ensureWslReady()` wakes WSL (5s fast-fail so a missing WSL doesn't block vault load for the default 30s exec timeout).
3. `docker.probeStatus()` probes compose state.
4. If running → `syncStatusBar(true)`; else detach terminal leaves.
5. If `autoStartContainer` is on and nothing's running → `startContainer()`.
6. Start the 30s health poll.

## Start / restart

`startContainer()`:
1. If busy, notify + bail.
2. `checkStartupPortConflicts()` test-binds ttyd + MCP ports on the bind address. EADDRINUSE aborts with an actionable Notice.
3. `ensureWriteDir()` creates the write dir if missing (just creates and swallows "already exists").
4. `docker compose up -d` — relies on compose's own idempotency (no manual `down` first).
5. On success: capture container ID, apply firewall, start health + firewall polls.

`restartContainer()` is the explicit clean-recreate escape hatch — `docker compose down && up -d`.

## Stop

`stopContainer()` runs `docker compose down`, clears firewall state, stops polls, clears the tracked container ID.

`stopDetached()` is the fire-and-forget version used from Obsidian's `quit` hook. Spawns a detached process so it doesn't block app exit.

## Health poll

Every 30 seconds while `running`:
1. Skip if busy (`docker.isBusy()` — serialises operations).
2. `probeStatus` → compare to known running state → `syncStatusBar`.
3. On transition out of `running`, stop the firewall poll.
4. Drift check: `docker.getContainerId()` compared to `lastKnownContainerId`. Mismatch triggers a Notice and detaches terminal leaves (they reopen against the new container).

## Firewall refresh

Firewall state can change out-of-band — user runs `init-firewall.sh` in the container shell, or another tool toggles it. The plugin uses **event-driven refresh**, not polling:

- On container transitions into `running`.
- On explicit firewall toggles from the status bar pill.
- On `mouseenter` of the firewall pill (throttled to 10s).
- On window `focus` (throttled to 10s).
- Every 5 minutes as a safety-net poll, gated on state ≠ `hidden`.

## Out-of-band container recreation

If you run `docker compose down && up -d` yourself, or another tool recreates the container, the plugin detects the ID drift on the next health poll and re-hydrates — existing terminal tabs are closed (they reopen cleanly against the new container when the user clicks).

## Shutdown

On Obsidian exit, the `quit` workspace event fires:
- If `autoStopContainer` is on, spawn `docker compose down` (detached) with a 5s timeout.
- Otherwise leave the container running so the next Obsidian open is instant.

On plugin disable (`onunload`):
- Stop the MCP server.
- Flush settings.
- Stop polls.
- Do **not** stop the container unless `autoStopContainer` says to — `onunload` also fires on settings-restart, and you don't want a settings change to kill your work.

## Multiple terminals

Each "Open Sandbox Terminal" creates an independent tab with its own WebSocket connection and unique `instanceId`. Sessions with a `sessionName` attach to a tmux session; without, they get a bare bash shell. Stale unattached sessions can be cleaned up via `Sandbox: Clean up empty sessions` (manual — no auto-GC).
