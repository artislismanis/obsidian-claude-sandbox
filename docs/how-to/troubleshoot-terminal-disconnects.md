# How to troubleshoot terminal disconnects

The in-Obsidian terminal sometimes drops its WebSocket to the container even though the container is still running. Reconnecting usually works within seconds. This page describes how to confirm what happened and where to look for clues.

## What the plugin already does

- **Auto-reconnect on abnormal close.** When the WebSocket closes with anything other than a clean code (1000 / 1001 / 1005), the terminal tab keeps its xterm instance and scrollback and retries the connection on a 0.5s → 1s → 2s → 4s → 8s → 8s → 8s → 8s backoff (eight attempts total). A small `Connection dropped — reconnecting (attempt n/8, in Ns)…` banner appears in the top-right of the terminal during retries. On success the terminal prints `[agent-sandbox] terminal reconnected`.
- **Lifecycle telemetry.** Every WS open/close/reconnect is recorded in a process-wide ring buffer (last 200 events) and written to the developer console. Close lines look like:
  ```
  [Agent Sandbox] [Terminal] WebSocket dropped — code=1006 (abnormal-no-close-frame)
    reason="" wasClean=false opened=true sessionMs=482103 idleMsBeforeClose=37214
    rxBytes=128442 rxMsgs=915 txBytes=312 gen=2 instance=1
  ```
  - `idleMsBeforeClose` — milliseconds since the last server message. A high value (tens of seconds+) suggests the server-side socket went silent before the close; a near-zero value suggests an active connection was cut.
  - `instance=N` — matches the Obsidian terminal tab. Multiple tabs interleave in the log; filter by instance to follow one tab.
  - `gen=N` — increments each time the view re-opens; helps separate tab-detach events from network drops.
- **Container-side session logging.** `ttyd` runs at info level (`-d 6`) and `session.sh` writes start/end markers to stderr, so each WS connection appears in `docker logs oas-sandbox` as a paired `[oas-session] start id=… / end id=… exit=…` block.

## Step-by-step

When a drop happens, gather both ends of the timeline before doing anything else.

1. **Plugin side — copy the connection log.**
   - Open the command palette (`Ctrl`/`Cmd` + `P`) → **Sandbox: Copy terminal connection log**.
   - Paste somewhere readable. Each line is one event: `<iso-timestamp>  inst=N gen=N <kind>  code=… duration=… idleBeforeClose=… rx=… tx=… attempt=…`. The reconnect attempts and the eventual `open` (or final `close`) are all there.
   - The same data is also in the Obsidian developer console (`Ctrl+Shift+I` → Console), tagged `[Agent Sandbox] [Terminal]`. Set **Settings → Agent Sandbox → Advanced → Log level** to `debug` to also see clean closes.

2. **Container side — read the docker logs.**
   ```bash
   docker logs --tail 200 oas-sandbox 2>&1 | tail -80
   ```
   Look for entries like:
   ```
   [oas-session] start id=4421 at=2026-05-04T20:01:14.812Z client=anon
   ttyd  [INFO] WS   eth0 client connected from 127.0.0.1:54822
   …
   ttyd  [INFO] WS   eth0 client disconnected
   [oas-session] end   id=4421 at=2026-05-04T20:09:36.157Z exit=0
   ```
   Pair each plugin-side `instance=N` close with one container-side start/end block by matching timestamps. If the container logged `disconnected` *before* the plugin logged the close, the drop originated server-side or in the network; if the container only logged `disconnected` *after*, the browser/Obsidian closed first.

3. **Check the container is healthy.**
   ```bash
   docker ps --filter name=oas-sandbox --format "{{.Status}}"
   docker compose -f container/docker-compose.yml exec sandbox verify.sh | tail -20
   ```
   The status should include `(healthy)`. If the container is restarting, the disconnect is the symptom, not the cause — check `docker logs` for OOM kills or fatal errors.

## Common patterns

| Plugin close code | Container log shows | Likely cause |
|---|---|---|
| `1006` abnormal-no-close-frame, `idleMsBeforeClose` high | `WS client disconnected` around the same time, no errors before | Idle network path — WSL2 vNAT, host firewall, or VPN closed the socket. The auto-reconnect should recover instantly. |
| `1006`, `idleMsBeforeClose` low | No matching `disconnected` line, or container restart marker | ttyd or container died. Check `docker ps` and `docker logs`. |
| `1011` internal-error | ttyd error before the disconnect line | ttyd-side problem; report with the log excerpt. |
| `1000`/`1001`/`1005` (clean) | Paired `[oas-session] end` with `exit=0` | Container was stopped or the tab was closed deliberately. No reconnect — the error screen prompts a manual retry. |
| Reconnect gives up after 8 attempts | Container `Status` is not `running` | Container is down. Use **Sandbox: Start Container**. |

## If reconnects don't help

- **Check port conflicts.** `ss -ltn '( sport = :7681 )'` (Linux) or the Obsidian status-bar tooltip — another process listening on `ttydPort` will make new ttyd connections fail.
- **Check the host firewall** (your OS firewall, not the container's outbound firewall). Especially on Windows + WSL2 with mirrored networking — Windows Defender Firewall can block loopback traffic to the container's published port. The [container outbound firewall doc](configure-firewall.md) covers a different layer (container → internet); host-firewall issues block the plugin's WebSocket from reaching ttyd in the first place.
- **Restart the container.** **Sandbox: Restart Container** in the command palette. This forces a clean `down` + `up -d`.
- **File a report.** Attach the copied connection log and the matching `docker logs --tail 200 oas-sandbox` excerpt to the issue.

## MCP proxy debug knobs

The sandbox-side Obsidian MCP proxy (`workspace/.claude/scripts/obsidian-mcp-proxy.js`) honours two environment variables when troubleshooting MCP-tool hangs or unexplained tool errors. Set them in a terminal *before* launching `claude`:

| Env var | Default | Effect |
|---|---|---|
| `OAS_MCP_TIMEOUT_MS` | `15000` | Per-request HTTP timeout (ms) for calls from the proxy to the plugin's MCP server. Bump it if you see "MCP proxy: HTTP request timed out" on heavy tools (e.g. very large `vault_search`). |
| `OAS_MCP_DEBUG` | unset | Set to `1` to log every proxy request/response to stderr. Combine with `claude --debug` for an end-to-end trace. |

Example:

```bash
OAS_MCP_DEBUG=1 OAS_MCP_TIMEOUT_MS=30000 claude
```

## Related

- [Reference: commands](../reference/commands.md)
- [Reference: settings](../reference/settings.md) — log level, ttyd port, bind address
- [Container lifecycle](../explanation/container-lifecycle.md)
