import { createServer } from "http";
import type { Server, IncomingMessage, ServerResponse } from "http";
import type { App } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "crypto";
import type { PermissionTier, McpToolDef, PathFilter, ReviewFn } from "./mcp-tools";
import { buildTools } from "./mcp-tools";
import { logger } from "./logger";

const C = "MCP";

export interface McpServerConfig {
	port: number;
	token: string;
	enabledTiers: Set<PermissionTier>;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	reviewFn?: ReviewFn;
}

const SESSION_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_READ = 60;
const RATE_LIMIT_WRITE = 20;
const AUDIT_MAX_ENTRIES = 200;

// ── Rate limiter ─────────────────────────────────────

interface RateBucket {
	timestamps: number[];
}

class RateLimiter {
	private buckets = new Map<string, RateBucket>();
	private limits = new Map<string, number>();
	private defaultRead: number;
	private defaultWrite: number;

	constructor(defaultRead: number, defaultWrite: number) {
		this.defaultRead = defaultRead;
		this.defaultWrite = defaultWrite;
	}

	setLimit(toolName: string, maxPerMinute: number): void {
		this.limits.set(toolName, maxPerMinute);
	}

	check(toolName: string, tier: PermissionTier): boolean {
		const limit = this.limits.get(toolName) ?? this.defaultForTier(tier);
		const now = Date.now();
		let bucket = this.buckets.get(toolName);
		if (!bucket) {
			bucket = { timestamps: [] };
			this.buckets.set(toolName, bucket);
		}
		bucket.timestamps = bucket.timestamps.filter((t) => now - t < RATE_WINDOW_MS);
		if (bucket.timestamps.length >= limit) return false;
		bucket.timestamps.push(now);
		return true;
	}

	private defaultForTier(tier: PermissionTier): number {
		return tier === "read" || tier === "navigate" ? this.defaultRead : this.defaultWrite;
	}
}

// ── Audit log ────────────────────────────────────────

export interface AuditEntry {
	timestamp: number;
	tool: string;
	success: boolean;
	durationMs: number;
}

class AuditLog {
	private entries: AuditEntry[] = [];
	private maxEntries: number;

	constructor(maxEntries: number) {
		this.maxEntries = maxEntries;
	}

	record(entry: AuditEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
		}
	}

	getEntries(): readonly AuditEntry[] {
		return this.entries;
	}
}

// ── MCP server ───────────────────────────────────────

export class ObsidianMcpServer {
	private httpServer: Server | null = null;
	private transports = new Map<string, StreamableHTTPServerTransport>();
	private sessionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
	private app: App;
	private config: McpServerConfig;
	private tools: McpToolDef[] = [];
	private startTime = 0;
	private rateLimiter = new RateLimiter(RATE_LIMIT_READ, RATE_LIMIT_WRITE);
	private auditLog = new AuditLog(AUDIT_MAX_ENTRIES);

	constructor(app: App, config: McpServerConfig) {
		this.app = app;
		this.config = config;
	}

	async start(): Promise<void> {
		if (this.httpServer) return;

		this.tools = buildTools(
			this.app,
			this.config.getWriteDir,
			this.config.pathFilter,
			this.config.reviewFn,
		).filter((t) => this.config.enabledTiers.has(t.tier));

		this.startTime = Date.now();

		this.httpServer = createServer((req, res) => {
			this.handleRequest(req, res).catch((err) => {
				logger.error(C, "Unhandled error in request handler", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			});
		});

		this.httpServer.on("clientError", (err) => {
			logger.warn(C, "Client error", err.message);
		});

		await new Promise<void>((resolve, reject) => {
			this.httpServer!.listen(this.config.port, "0.0.0.0", () => resolve());
			this.httpServer!.on("error", reject);
		});

		logger.info(C, `Started on port ${this.config.port} with ${this.tools.length} tools`);
	}

	async stop(): Promise<void> {
		logger.info(C, "Stopping server...");

		for (const timeout of this.sessionTimeouts.values()) clearTimeout(timeout);
		this.sessionTimeouts.clear();

		for (const [sid, transport] of this.transports.entries()) {
			try {
				await transport.close?.();
			} catch (err) {
				logger.warn(C, `Error closing transport ${sid}`, err);
			}
		}
		this.transports.clear();

		if (this.httpServer) {
			await new Promise<void>((resolve) => {
				this.httpServer!.close(() => resolve());
			});
			this.httpServer = null;
		}

		logger.info(C, "Server stopped");
	}

	private resetSessionTimeout(sid: string): void {
		const existing = this.sessionTimeouts.get(sid);
		if (existing) clearTimeout(existing);
		this.sessionTimeouts.set(
			sid,
			setTimeout(() => {
				logger.debug(C, `Session ${sid.slice(0, 8)}… timed out`);
				const transport = this.transports.get(sid);
				if (transport) void transport.close?.();
				this.transports.delete(sid);
				this.sessionTimeouts.delete(sid);
			}, SESSION_TIMEOUT_MS),
		);
	}

	private cleanupSession(sid: string): void {
		logger.debug(C, `Session ${sid.slice(0, 8)}… closed`);
		this.transports.delete(sid);
		const timeout = this.sessionTimeouts.get(sid);
		if (timeout) clearTimeout(timeout);
		this.sessionTimeouts.delete(sid);
	}

	isRunning(): boolean {
		return this.httpServer !== null;
	}

	getToolCount(): number {
		return this.tools.length;
	}

	getAuditEntries(): readonly AuditEntry[] {
		return this.auditLog.getEntries();
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		res.setHeader("Access-Control-Allow-Origin", "*");
		res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
		res.setHeader(
			"Access-Control-Allow-Headers",
			"Content-Type, Authorization, Mcp-Session-Id",
		);
		res.setHeader("Access-Control-Expose-Headers", "Mcp-Session-Id");

		if (req.method === "OPTIONS") {
			res.writeHead(204);
			res.end();
			return;
		}

		if (!this.checkAuth(req)) {
			logger.debug(C, `Auth failed: ${req.method} ${req.url}`);
			res.writeHead(401, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Unauthorized" }));
			return;
		}

		const url = new URL(req.url ?? "/", `http://localhost:${this.config.port}`);

		if (url.pathname === "/mcp/health") {
			this.handleHealth(res);
			return;
		}

		if (url.pathname === "/mcp/audit") {
			this.handleAudit(res);
			return;
		}

		if (url.pathname !== "/mcp") {
			res.writeHead(404);
			res.end("Not Found");
			return;
		}

		logger.debug(C, `${req.method} /mcp`);

		try {
			if (req.method === "POST") {
				await this.handlePost(req, res);
			} else if (req.method === "GET") {
				await this.handleGet(req, res);
			} else if (req.method === "DELETE") {
				await this.handleDelete(req, res);
			} else {
				res.writeHead(405);
				res.end("Method Not Allowed");
			}
		} catch (err) {
			logger.error(C, `Error handling ${req.method} /mcp`, err);
			if (!res.headersSent) {
				res.writeHead(500, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ error: "Internal server error" }));
			}
		}
	}

	private handleHealth(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				tools: this.tools.length,
				sessions: this.transports.size,
				uptimeMs: Date.now() - this.startTime,
			}),
		);
	}

	private handleAudit(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(JSON.stringify({ entries: this.auditLog.getEntries() }));
	}

	private checkAuth(req: IncomingMessage): boolean {
		const auth = req.headers.authorization;
		if (!auth) return false;
		const expected = `Bearer ${this.config.token}`;
		if (auth.length !== expected.length) return false;
		return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
	}

	private async readBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			const chunks: Buffer[] = [];
			let size = 0;
			req.on("data", (chunk: Buffer) => {
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					req.destroy();
					reject(new Error("Request body too large"));
				} else {
					chunks.push(chunk);
				}
			});
			req.on("end", () => {
				try {
					resolve(JSON.parse(Buffer.concat(chunks).toString()));
				} catch {
					reject(new Error("Invalid JSON"));
				}
			});
			req.on("error", reject);
		});
	}

	private createMcpServer(): McpServer {
		const server = new McpServer({
			name: "obsidian-vault",
			version: "0.1.0",
		});

		for (const tool of this.tools) {
			server.registerTool(tool.name, tool.config, async (args) => {
				if (!this.rateLimiter.check(tool.name, tool.tier)) {
					logger.warn(C, `Rate limit exceeded: ${tool.name}`);
					return {
						content: [
							{
								type: "text" as const,
								text: `Rate limit exceeded for ${tool.name}. Try again shortly.`,
							},
						],
						isError: true,
					};
				}

				const start = Date.now();
				let success = true;
				try {
					const result = await tool.handler(args as Record<string, unknown>);
					const text = result.content?.[0]?.text;
					if (text && Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
						logger.debug(C, `Truncating response from ${tool.name}`);
						result.content[0].text =
							text.slice(0, MAX_RESPONSE_BYTES) + "\n\n[truncated]";
					}
					if (result.isError) success = false;
					return result;
				} catch (err: unknown) {
					success = false;
					const msg = err instanceof Error ? err.message : String(err);
					logger.error(C, `Tool ${tool.name} threw`, err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
					};
				} finally {
					const duration = Date.now() - start;
					this.auditLog.record({
						timestamp: Date.now(),
						tool: tool.name,
						success,
						durationMs: duration,
					});
					logger.debug(C, `${tool.name} ${success ? "ok" : "err"} ${duration}ms`);
				}
			});
		}

		return server;
	}

	private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readBody(req);
		const sessionId = req.headers["mcp-session-id"] as string | undefined;

		if (sessionId && this.transports.has(sessionId)) {
			this.resetSessionTimeout(sessionId);
			const transport = this.transports.get(sessionId)!;
			try {
				await transport.handleRequest(req, res, body);
			} catch (err) {
				logger.error(C, `Transport error (session ${sessionId.slice(0, 8)}…)`, err);
				this.cleanupSession(sessionId);
				throw err;
			}
			return;
		}

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sid: string) => {
				logger.info(C, `New session ${sid.slice(0, 8)}…`);
				this.transports.set(sid, transport);
				this.resetSessionTimeout(sid);
			},
		});

		transport.onclose = () => {
			const sid = transport.sessionId;
			if (sid) this.cleanupSession(sid);
		};

		try {
			const server = this.createMcpServer();
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (err) {
			logger.error(C, "Failed to initialize MCP session", err);
			const sid = transport.sessionId;
			if (sid) this.cleanupSession(sid);
			throw err;
		}
	}

	private async handleGet(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const sessionId = req.headers["mcp-session-id"] as string | undefined;
		if (!sessionId || !this.transports.has(sessionId)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
			return;
		}
		const transport = this.transports.get(sessionId)!;
		await transport.handleRequest(req, res);
	}

	private async handleDelete(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const sessionId = req.headers["mcp-session-id"] as string | undefined;
		if (!sessionId || !this.transports.has(sessionId)) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
			return;
		}
		const transport = this.transports.get(sessionId)!;
		await transport.handleRequest(req, res);
	}
}

export function generateToken(): string {
	return randomUUID().replace(/-/g, "");
}
