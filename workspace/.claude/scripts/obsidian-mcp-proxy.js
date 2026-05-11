#!/usr/bin/env node
"use strict";
// Stdio→HTTP proxy for the Obsidian MCP server.
//
// Presents as a stdio MCP server to Claude Code. When the Obsidian plugin's
// HTTP server is reachable it proxies all requests through; when it is not
// (Obsidian closed, plugin disabled, not yet started) it responds as an empty
// MCP server so other stdio servers such as memory are unaffected.
//
// Connectivity is re-probed before every request, with a 30-second positive
// cache. The proxy recovers automatically once Obsidian becomes reachable
// for *new* `tools/list` queries — but Claude Code caches an empty tools list
// from the first response, so an existing Claude session that started with
// Obsidian unreachable will not see the tools appear without a `/mcp restart
// obsidian` (or full restart). Start Obsidian before `claude` if you want
// vault tools available for the whole session.
//
// Concurrency: requests are dispatched as they arrive on stdin — one slow
// tool call no longer blocks subsequent calls. Writes back to stdout are
// serialised through a single queue so JSON-RPC frames never interleave.

const http = require("http");
const net = require("net");
const readline = require("readline");

const PORT = parseInt(process.env.OAS_MCP_PORT || "28080", 10);
const TOKEN = process.env.OAS_MCP_TOKEN || "";
const HOST = "host.docker.internal";
const HTTP_TIMEOUT_MS = parseInt(process.env.OAS_MCP_TIMEOUT_MS || "15000", 10);
const DEBUG = process.env.OAS_MCP_DEBUG === "1";

// Cache: re-probe at most once every PROBE_TTL_MS when available,
// immediately when unavailable (so recovery is fast).
const PROBE_TTL_MS = 30_000;
let lastProbeTime = 0;
let lastProbeResult = false;

let sessionId = null;

// Promise that resolves once the in-flight `initialize` request has produced
// a sessionId. We need this because Claude Code emits `initialize` followed
// immediately by `notifications/initialized` on consecutive stdin lines, and
// since handleMessage runs without awaiting (so unrelated slow tool calls
// don't block other requests), the notification's httpPost would otherwise
// fire while sessionId is still null — losing the Mcp-Session-Id header that
// the upstream server uses to route the notification to the right session.
// Held only until the first initialize resolves.
let pendingInitialize = null;

function probePort() {
	return new Promise((resolve) => {
		const s = net.createConnection({ host: HOST, port: PORT });
		s.setTimeout(2000);
		s.on("connect", () => {
			s.destroy();
			resolve(true);
		});
		s.on("error", () => resolve(false));
		s.on("timeout", () => {
			s.destroy();
			resolve(false);
		});
	});
}

async function isAvailable() {
	// No bearer token configured → server would reject every request with a
	// 401 anyway. Surface as "unavailable" so callers fall through to the
	// empty-server stub path instead of seeing confusing auth errors. This
	// is the normal state when MCP is disabled in the plugin settings.
	if (!TOKEN) return false;
	const now = Date.now();
	// Skip re-probe if last result was positive and within TTL
	if (lastProbeResult && now - lastProbeTime < PROBE_TTL_MS) {
		return true;
	}
	lastProbeResult = await probePort();
	lastProbeTime = now;
	return lastProbeResult;
}

// Serialise stdout writes so JSON-RPC frames from concurrent in-flight
// requests don't interleave. process.stdout.write returning false (kernel
// pipe buffer full) is rare for small JSON frames but handled defensively.
const writeQueue = [];
let writing = false;
function writeFrame(obj) {
	writeQueue.push(JSON.stringify(obj) + "\n");
	drainWrite();
}
function drainWrite() {
	if (writing) return;
	const next = writeQueue.shift();
	if (next === undefined) return;
	writing = true;
	const ok = process.stdout.write(next, () => {
		writing = false;
		drainWrite();
	});
	if (!ok) {
		// Backpressure: wait for drain before flushing the next frame.
		process.stdout.once("drain", () => {
			writing = false;
			drainWrite();
		});
	}
}

function httpPost(message) {
	return new Promise((resolve, reject) => {
		const payload = JSON.stringify(message);
		const headers = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${TOKEN}`,
			Accept: "application/json, text/event-stream",
			"Content-Length": Buffer.byteLength(payload),
		};
		if (sessionId) headers["Mcp-Session-Id"] = sessionId;

		const req = http.request(
			{ hostname: HOST, port: PORT, path: "/mcp", method: "POST", headers, timeout: HTTP_TIMEOUT_MS },
			(res) => {
				const sid = res.headers["mcp-session-id"];
				if (sid) sessionId = sid;

				const ct = res.headers["content-type"] || "";
				let buf = "";
				const messages = [];

				// SSE events are terminated by a blank line ("\n\n"). An event
				// can have multiple `data:` lines that must be concatenated with
				// "\n" into a single payload before parsing.
				const flushEvent = (event) => {
					const dataLines = event
						.split("\n")
						.filter((l) => l.startsWith("data:"))
						.map((l) => (l.startsWith("data: ") ? l.slice(6) : l.slice(5)));
					if (dataLines.length === 0) return;
					const text = dataLines.join("\n").trim();
					if (text) try { messages.push(JSON.parse(text)); } catch {}
				};

				res.on("data", (chunk) => {
					buf += chunk.toString();
					if (!ct.includes("text/event-stream")) return;
					let sep;
					while ((sep = buf.indexOf("\n\n")) !== -1) {
						flushEvent(buf.slice(0, sep));
						buf = buf.slice(sep + 2);
					}
				});

				res.on("end", () => {
					if (ct.includes("text/event-stream")) {
						if (buf) flushEvent(buf);
						resolve(messages);
					} else {
						try { resolve([JSON.parse(buf)]); } catch { resolve([]); }
					}
				});

				res.on("error", (err) => {
					// Mark as unavailable so next request re-probes
					lastProbeResult = false;
					reject(err);
				});
			},
		);
		req.on("error", (err) => {
			lastProbeResult = false;
			reject(err);
		});
		req.on("timeout", () => {
			req.destroy();
			lastProbeResult = false;
			reject(
				new Error(
					`Obsidian MCP handler did not respond within ${HTTP_TIMEOUT_MS}ms — check Obsidian's developer console for plugin errors.`,
				),
			);
		});
		req.write(payload);
		req.end();
	});
}

function unavailableResult(id, method) {
	let result;
	if (method === "initialize") {
		result = {
			protocolVersion: "2025-03-26",
			capabilities: {},
			serverInfo: { name: "obsidian-unavailable", version: "0.0.0" },
		};
	} else if (method === "tools/list") {
		result = { tools: [] };
	} else if (method === "resources/list") {
		result = { resources: [] };
	} else if (method === "prompts/list") {
		result = { prompts: [] };
	} else {
		result = {};
	}
	return { jsonrpc: "2.0", id, result };
}

async function handleMessage(msg) {
	const available = await isAvailable();

	// Notifications have no id and need no response. The MCP spec requires
	// `notifications/initialized` after `initialize`, so we still forward
	// them upstream (fire-and-forget) when the server is reachable —
	// dropping them would prevent the upstream session from leaving init.
	if (msg.id === undefined) {
		if (available) {
			// If an `initialize` is in flight, hold the notification until it
			// resolves so sessionId is set before we POST. See pendingInitialize
			// declaration above for the full rationale.
			const pending = pendingInitialize;
			if (pending) {
				pending.then(() => httpPost(msg).catch(() => undefined));
			} else {
				httpPost(msg).catch(() => undefined);
			}
		}
		return;
	}

	if (!available) {
		writeFrame(unavailableResult(msg.id, msg.method));
		return;
	}

	const t0 = Date.now();
	// Track in-flight initialize so concurrent notifications can wait for the
	// sessionId. We resolve on first response regardless of outcome — even a
	// failed initialize is "done" from the queuing perspective; pending
	// notifications will see whatever sessionId got assigned (or null) and
	// proceed (their httpPost catch swallows errors).
	let initializeResolve;
	if (msg.method === "initialize") {
		pendingInitialize = new Promise((resolve) => {
			initializeResolve = resolve;
		});
	}
	try {
		const responses = await httpPost(msg);
		if (DEBUG) {
			const label =
				msg.method === "tools/call" ? `tools/call ${msg.params?.name ?? "?"}` : msg.method;
			process.stderr.write(
				`obsidian-mcp-proxy: id=${msg.id} ${label} ${Date.now() - t0}ms\n`,
			);
		}
		for (const r of responses) writeFrame(r);
	} catch (err) {
		process.stderr.write(
			`obsidian-mcp-proxy: id=${msg.id} ${msg.method} failed after ${Date.now() - t0}ms: ${err.message}\n`,
		);
		writeFrame({
			jsonrpc: "2.0",
			id: msg.id,
			error: { code: -32603, message: err.message || "Obsidian MCP server unavailable" },
		});
	} finally {
		if (initializeResolve) {
			// Release any notifications waiting on the initialize. Clear the
			// module-level pending pointer too so subsequent notifications skip
			// the wait. Done in finally so an error path still unblocks waiters.
			pendingInitialize = null;
			initializeResolve();
		}
	}
}

function main() {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	// Track in-flight handler promises so we can drain on shutdown — a 100ms
	// fixed wait was dropping mid-flight tool calls when Claude Code closed
	// stdin during a session exit. Drain budget is HTTP_TIMEOUT_MS + 1s so we
	// give every outstanding request a chance to finish before exit.
	const inFlight = new Set();
	const SHUTDOWN_DRAIN_MS = HTTP_TIMEOUT_MS + 1000;

	// Dispatch messages without awaiting — a slow tool call no longer blocks
	// other in-flight requests. handleMessage drives writes through the
	// serialised writeFrame queue so JSON-RPC frames never interleave.
	rl.on("line", (line) => {
		const trimmed = line.trim();
		if (!trimmed) return;
		let msg;
		try { msg = JSON.parse(trimmed); } catch { return; }
		const p = handleMessage(msg).catch((err) => {
			process.stderr.write(`obsidian-mcp-proxy: handler error: ${err.message}\n`);
			// handleMessage's inner try/catch normally produces an error
			// frame. This fallback covers the rare path where it throws
			// before reaching that catch (e.g. a malformed `msg` that
			// passed JSON.parse but tripped a property access) — without
			// it, Claude would hang waiting for a response that never
			// comes until the request times out.
			if (msg && typeof msg === "object" && msg.id !== undefined) {
				try {
					writeFrame({
						jsonrpc: "2.0",
						id: msg.id,
						error: { code: -32603, message: err.message || "Internal proxy error" },
					});
				} catch {
					/* writeFrame should not throw; ignore if it does */
				}
			}
		});
		inFlight.add(p);
		p.finally(() => inFlight.delete(p));
	});

	rl.on("close", () => {
		// stdin EOF — drain in-flight handlers with a bounded budget so we
		// don't abandon pending HTTP requests mid-flight (response would never
		// reach Claude; upstream may still mutate vault state).
		const deadline = Promise.race([
			Promise.allSettled(Array.from(inFlight)),
			new Promise((resolve) => setTimeout(resolve, SHUTDOWN_DRAIN_MS)),
		]);
		deadline.then(() => process.exit(0));
	});
}

try {
	main();
} catch (err) {
	process.stderr.write(`obsidian-mcp-proxy fatal: ${err.message}\n`);
	process.exit(1);
}
