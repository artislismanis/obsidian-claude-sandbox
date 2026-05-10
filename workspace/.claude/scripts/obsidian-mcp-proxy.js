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
// cache. This means the proxy recovers automatically when Obsidian starts
// after the container, or when MCP is toggled on in the plugin settings —
// no container restart needed.

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
	const now = Date.now();
	// Skip re-probe if last result was positive and within TTL
	if (lastProbeResult && now - lastProbeTime < PROBE_TTL_MS) {
		return true;
	}
	lastProbeResult = await probePort();
	lastProbeTime = now;
	return lastProbeResult;
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

async function main() {
	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let msg;
		try { msg = JSON.parse(trimmed); } catch { continue; }

		const available = await isAvailable();

		// Notifications have no id and need no response. The MCP spec requires
		// `notifications/initialized` after `initialize`, so we still forward
		// them upstream (fire-and-forget) when the server is reachable —
		// dropping them would prevent the upstream session from leaving init.
		if (msg.id === undefined) {
			if (available) httpPost(msg).catch(() => undefined);
			continue;
		}

		if (!available) {
			process.stdout.write(JSON.stringify(unavailableResult(msg.id, msg.method)) + "\n");
			continue;
		}

		const t0 = Date.now();
		try {
			const responses = await httpPost(msg);
			if (DEBUG) {
				const label =
					msg.method === "tools/call" ? `tools/call ${msg.params?.name ?? "?"}` : msg.method;
				process.stderr.write(
					`obsidian-mcp-proxy: id=${msg.id} ${label} ${Date.now() - t0}ms\n`,
				);
			}
			for (const r of responses) {
				process.stdout.write(JSON.stringify(r) + "\n");
			}
		} catch (err) {
			process.stderr.write(
				`obsidian-mcp-proxy: id=${msg.id} ${msg.method} failed after ${Date.now() - t0}ms: ${err.message}\n`,
			);
			process.stdout.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32603, message: err.message || "Obsidian MCP server unavailable" },
				}) + "\n",
			);
		}
	}
}

main().catch((err) => {
	process.stderr.write(`obsidian-mcp-proxy fatal: ${err.message}\n`);
	process.exit(1);
});
