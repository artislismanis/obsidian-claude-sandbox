#!/usr/bin/env node
"use strict";
// Stdio→HTTP proxy for the Obsidian MCP server.
//
// Presents as a stdio MCP server to Claude Code. When the Obsidian plugin's
// HTTP server is reachable it proxies all requests through; when it is not
// (Obsidian closed, plugin disabled) it responds as an empty MCP server so
// other stdio servers such as memory are unaffected.

const http = require("http");
const net = require("net");
const readline = require("readline");

const PORT = parseInt(process.env.OAS_MCP_PORT || "28080", 10);
const TOKEN = process.env.OAS_MCP_TOKEN || "";
const HOST = "host.docker.internal";

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
			{ hostname: HOST, port: PORT, path: "/mcp", method: "POST", headers, timeout: 30000 },
			(res) => {
				const sid = res.headers["mcp-session-id"];
				if (sid) sessionId = sid;

				const ct = res.headers["content-type"] || "";
				let buf = "";
				const messages = [];

				res.on("data", (chunk) => {
					buf += chunk.toString();
					if (!ct.includes("text/event-stream")) return;
					const lines = buf.split("\n");
					buf = lines.pop();
					for (const line of lines) {
						if (!line.startsWith("data: ")) continue;
						const text = line.slice(6).trim();
						if (text) try { messages.push(JSON.parse(text)); } catch {}
					}
				});

				res.on("end", () => {
					if (ct.includes("text/event-stream")) {
						const text = buf.startsWith("data: ") ? buf.slice(6).trim() : "";
						if (text) try { messages.push(JSON.parse(text)); } catch {}
						resolve(messages);
					} else {
						try { resolve([JSON.parse(buf)]); } catch { resolve([]); }
					}
				});

				res.on("error", reject);
			},
		);
		req.on("error", reject);
		req.on("timeout", () => {
			req.destroy();
			reject(new Error("timeout"));
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
	const available = await probePort();

	const rl = readline.createInterface({ input: process.stdin, terminal: false });

	for await (const line of rl) {
		const trimmed = line.trim();
		if (!trimmed) continue;

		let msg;
		try { msg = JSON.parse(trimmed); } catch { continue; }

		// Notifications have no id — no response required
		if (msg.id === undefined) continue;

		if (!available) {
			process.stdout.write(JSON.stringify(unavailableResult(msg.id, msg.method)) + "\n");
			continue;
		}

		try {
			const responses = await httpPost(msg);
			for (const r of responses) {
				process.stdout.write(JSON.stringify(r) + "\n");
			}
		} catch (err) {
			process.stderr.write(`obsidian-mcp-proxy: ${err.message}\n`);
			process.stdout.write(
				JSON.stringify({
					jsonrpc: "2.0",
					id: msg.id,
					error: { code: -32603, message: "Obsidian MCP server unavailable" },
				}) + "\n",
			);
		}
	}
}

main().catch((err) => {
	process.stderr.write(`obsidian-mcp-proxy fatal: ${err.message}\n`);
	process.exit(1);
});
