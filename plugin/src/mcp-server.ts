import { createServer } from "http";
import type { Server, IncomingMessage, ServerResponse } from "http";
import type { App } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "crypto";
import type {
	PermissionTier,
	McpToolDef,
	PathFilter,
	ReviewFn,
	ReviewBatchFn,
	AgentStatus,
	OnActivity,
} from "./mcp-tools";
import { buildTools } from "./mcp-tools";
import { VaultCache } from "./mcp-cache";
import { ALWAYS_ON_TIERS, GATED_TIERS } from "./permission-tiers";

export interface ActivityEntry {
	status: AgentStatus;
	detail?: string;
	updatedAt: number;
}

const ACTIVITY_STALE_MS = 10 * 60_000;

export interface McpServerHooks {
	/** Fired on writes when the reviewed tier is enabled — presents a diff modal. */
	review?: ReviewFn;
	/** Fired on batch writes (vault_batch_frontmatter) when review is enabled. */
	reviewBatch?: ReviewBatchFn;
	/** Called on every `agent_status_set` tool invocation. */
	onActivity?: OnActivity;
}

export interface McpServerConfig {
	port: number;
	token: string;
	enabledTiers: Set<PermissionTier>;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	hooks?: McpServerHooks;
}

const SESSION_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512_000;
const RATE_WINDOW_MS = 60_000;
const RATE_LIMIT_READ = 60;
const RATE_LIMIT_WRITE = 20;
const AUDIT_MAX_ENTRIES = 200;
const TOOL_TIMEOUT_MS = 10_000;

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
	private sink: ((entry: AuditEntry) => void | Promise<void>) | null = null;

	constructor(maxEntries: number) {
		this.maxEntries = maxEntries;
	}

	setSink(sink: ((entry: AuditEntry) => void | Promise<void>) | null): void {
		this.sink = sink;
	}

	record(entry: AuditEntry): void {
		this.entries.push(entry);
		if (this.entries.length > this.maxEntries) {
			this.entries = this.entries.slice(-this.maxEntries);
		}
		if (this.sink) {
			try {
				const maybe = this.sink(entry);
				if (maybe instanceof Promise) {
					maybe.catch(() => {
						/* sink failures never block tool execution */
					});
				}
			} catch {
				/* sink failures never block tool execution */
			}
		}
	}

	getEntries(): readonly AuditEntry[] {
		return this.entries;
	}
}

const AUDIT_FILE = ".oas/mcp-audit.jsonl";
const AUDIT_FILE_MAX_BYTES = 1_024_000;
const AUDIT_FILE_ARCHIVE = ".oas/mcp-audit.1.jsonl";

function createFileAuditSink(app: App): (entry: AuditEntry) => Promise<void> {
	const adapter = app.vault.adapter;
	let ensuredDir = false;
	return async (entry) => {
		if (!ensuredDir) {
			try {
				if (!(await adapter.exists(".oas"))) await adapter.mkdir(".oas");
			} catch {
				/* ignore */
			}
			ensuredDir = true;
		}
		try {
			if (await adapter.exists(AUDIT_FILE)) {
				const stat = await adapter.stat(AUDIT_FILE);
				if (stat && stat.size > AUDIT_FILE_MAX_BYTES) {
					try {
						if (await adapter.exists(AUDIT_FILE_ARCHIVE)) {
							await adapter.remove(AUDIT_FILE_ARCHIVE);
						}
						await adapter.rename(AUDIT_FILE, AUDIT_FILE_ARCHIVE);
					} catch {
						/* rotation is best-effort */
					}
				}
			}
			await adapter.append(AUDIT_FILE, JSON.stringify(entry) + "\n");
		} catch {
			/* audit write failures must never block */
		}
	};
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
	private cache: VaultCache | null = null;
	private activity = new Map<string, ActivityEntry>();

	constructor(app: App, config: McpServerConfig) {
		this.app = app;
		this.config = config;
	}

	async start(): Promise<void> {
		if (this.httpServer) return;

		this.cache = new VaultCache(this.app.metadataCache);
		this.auditLog.setSink(createFileAuditSink(this.app));
		const hooks = this.config.hooks ?? {};
		this.tools = buildTools(
			this.app,
			this.config.getWriteDir,
			this.config.pathFilter,
			hooks.review,
			this.cache,
			hooks.reviewBatch,
			(update) => this.recordActivity(update),
			this.config.enabledTiers,
		).filter((t) => this.config.enabledTiers.has(t.tier));

		this.startTime = Date.now();

		this.httpServer = createServer((req, res) => {
			void this.handleRequest(req, res);
		});

		await new Promise<void>((resolve, reject) => {
			this.httpServer!.listen(this.config.port, "0.0.0.0", () => resolve());
			this.httpServer!.on("error", reject);
		});
	}

	async stop(): Promise<void> {
		for (const timeout of this.sessionTimeouts.values()) clearTimeout(timeout);
		this.sessionTimeouts.clear();

		for (const transport of this.transports.values()) {
			await transport.close?.();
		}
		this.transports.clear();

		if (this.httpServer) {
			await new Promise<void>((resolve) => {
				this.httpServer!.close(() => resolve());
			});
			this.httpServer = null;
		}

		this.cache?.destroy();
		this.cache = null;
		this.auditLog.setSink(null);
	}

	private resetSessionTimeout(sid: string): void {
		const existing = this.sessionTimeouts.get(sid);
		if (existing) clearTimeout(existing);
		this.sessionTimeouts.set(
			sid,
			setTimeout(() => {
				const transport = this.transports.get(sid);
				if (transport) void transport.close?.();
				this.transports.delete(sid);
				this.sessionTimeouts.delete(sid);
			}, SESSION_TIMEOUT_MS),
		);
	}

	private cleanupSession(sid: string): void {
		this.transports.delete(sid);
		const timeout = this.sessionTimeouts.get(sid);
		if (timeout) clearTimeout(timeout);
		this.sessionTimeouts.delete(sid);
	}

	isRunning(): boolean {
		return this.httpServer !== null;
	}

	private recordActivity(update: {
		sessionName: string;
		status: AgentStatus;
		detail?: string;
	}): void {
		this.activity.set(update.sessionName, {
			status: update.status,
			detail: update.detail,
			updatedAt: Date.now(),
		});
		this.config.hooks?.onActivity?.(update);
	}

	/** Returns the current activity map with stale `working` entries rolled to `idle`. */
	getActivity(): Map<string, ActivityEntry> {
		const now = Date.now();
		for (const [name, entry] of this.activity) {
			if (entry.status === "working" && now - entry.updatedAt > ACTIVITY_STALE_MS) {
				this.activity.set(name, { ...entry, status: "idle" });
			}
		}
		return new Map(this.activity);
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
	}

	private handleHealth(res: ServerResponse): void {
		res.writeHead(200, { "Content-Type": "application/json" });
		res.end(
			JSON.stringify({
				status: "ok",
				tools: this.tools.length,
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

	private registerCapabilitiesTool(server: McpServer): void {
		server.registerTool(
			"mcp_capabilities",
			{
				title: "Report MCP capabilities",
				description:
					"Return the currently enabled permission tiers, the active write directory, per-tier tool counts, and rate-limit budgets. Call this at the start of a session (or after a permission error) to discover what you can do without trial-and-error.",
				inputSchema: {},
			},
			async () => {
				const enabled = Array.from(this.config.enabledTiers);
				const always = ALWAYS_ON_TIERS.filter((t) => this.config.enabledTiers.has(t));
				const escalations = GATED_TIERS.filter((g) =>
					this.config.enabledTiers.has(g.tier),
				).map((g) => g.tier);
				const toolsByTier: Record<string, string[]> = {};
				for (const t of this.tools) {
					(toolsByTier[t.tier] ??= []).push(t.name);
				}
				const body = {
					enabledTiers: enabled,
					alwaysOn: always,
					escalations,
					writeDir: this.config.getWriteDir(),
					toolsByTier,
					rateLimits: {
						defaultReadsPerMin: RATE_LIMIT_READ,
						defaultWritesPerMin: RATE_LIMIT_WRITE,
					},
				};
				return {
					content: [{ type: "text" as const, text: JSON.stringify(body, null, 2) }],
				};
			},
		);
	}

	private createMcpServer(): McpServer {
		const server = new McpServer({
			name: "obsidian-vault",
			version: "0.1.0",
		});

		this.registerCapabilitiesTool(server);

		for (const tool of this.tools) {
			server.registerTool(tool.name, tool.config, async (args) => {
				if (!this.rateLimiter.check(tool.name, tool.tier)) {
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
					const handlerPromise = tool.handler(args as Record<string, unknown>);
					let timer: ReturnType<typeof setTimeout> | undefined;
					const timeout = new Promise<never>((_, reject) => {
						timer = setTimeout(
							() =>
								reject(
									new Error(
										`Tool '${tool.name}' did not respond within ${TOOL_TIMEOUT_MS / 1000}s`,
									),
								),
							TOOL_TIMEOUT_MS,
						);
					});
					const result = await Promise.race([handlerPromise, timeout]).finally(() => {
						if (timer) clearTimeout(timer);
					});
					const text = result.content?.[0]?.text;
					if (text && Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
						result.content[0].text =
							text.slice(0, MAX_RESPONSE_BYTES) + "\n\n[truncated]";
					}
					if (result.isError) success = false;
					return result;
				} catch (err: unknown) {
					success = false;
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
					};
				} finally {
					this.auditLog.record({
						timestamp: Date.now(),
						tool: tool.name,
						success,
						durationMs: Date.now() - start,
					});
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
			await transport.handleRequest(req, res, body);
			return;
		}

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sid: string) => {
				this.transports.set(sid, transport);
				this.resetSessionTimeout(sid);
			},
		});

		transport.onclose = () => {
			const sid = transport.sessionId;
			if (sid) this.cleanupSession(sid);
		};

		const server = this.createMcpServer();
		await server.connect(transport);
		await transport.handleRequest(req, res, body);
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
