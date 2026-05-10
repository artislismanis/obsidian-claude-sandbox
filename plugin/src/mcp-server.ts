import { createServer } from "http";
import type { Server, IncomingMessage, ServerResponse } from "http";
import type { App } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "crypto";
import type {
	PermissionTier,
	McpToolDef,
	McpToolResult,
	PathFilter,
	ReviewFn,
	ReviewBatchFn,
	AgentStatus,
	OnActivity,
} from "./mcp-tools";
import { buildTools } from "./mcp-tools";
import { VaultCache } from "./mcp-cache";
import { logger, errMsg } from "./logger";
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
	/** IP to bind the HTTP server to. Defaults to "127.0.0.1" — host-only.
	 *  Set to the docker bridge gateway (or 0.0.0.0) to let the sandbox
	 *  container reach the host via host.docker.internal. */
	bindAddress?: string;
	token: string;
	enabledTiers: Set<PermissionTier>;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	hooks?: McpServerHooks;
	toolTimeoutMs: number;
	reviewTimeoutMs: number;
}

const SESSION_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 512_000;
const MAX_RESPONSE_TOTAL_BYTES = 1024 * 1024;
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
	private defaultRead: number;
	private defaultWrite: number;

	constructor(defaultRead: number, defaultWrite: number) {
		this.defaultRead = defaultRead;
		this.defaultWrite = defaultWrite;
	}

	check(toolName: string, tier: PermissionTier): boolean {
		const limit = tier === "read" || tier === "navigate" ? this.defaultRead : this.defaultWrite;
		const now = Date.now();
		let bucket = this.buckets.get(toolName);
		if (!bucket) {
			bucket = { timestamps: [] };
			this.buckets.set(toolName, bucket);
		}
		while (bucket.timestamps.length > 0 && now - bucket.timestamps[0] >= RATE_WINDOW_MS) {
			bucket.timestamps.shift();
		}
		if (bucket.timestamps.length >= limit) return false;
		bucket.timestamps.push(now);
		return true;
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
	// Serialise sink invocations so file-rotation (stat → remove → rename →
	// append) can't interleave with concurrent record() calls. Without this,
	// two simultaneous tool invocations near the rotation threshold would race
	// inside createFileAuditSink — both reading the pre-rotation byte count,
	// both deciding to rotate, the second rename clobbering the first archive.
	private sinkChain: Promise<void> = Promise.resolve();

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
		const sink = this.sink;
		if (!sink) return;
		// Chain via the per-sink promise so writes serialise. Errors are logged
		// but never propagate — sink failures must never block tool execution.
		this.sinkChain = this.sinkChain.then(
			() => {
				try {
					const maybe = sink(entry);
					return maybe instanceof Promise
						? maybe.catch((e) => logger.debug("MCP", "Audit sink failed", e))
						: undefined;
				} catch (e) {
					logger.debug("MCP", "Audit sink failed", e);
				}
			},
			() => {
				/* prior link rejected — already logged */
			},
		);
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
	// Track running byte count so we only stat (and rotate) when we suspect we
	// crossed the threshold — otherwise the file sink would do 3 vault-adapter
	// calls per MCP tool invocation.
	let estimatedBytes = -1;
	return async (entry) => {
		if (!ensuredDir) {
			try {
				await adapter.mkdir(".oas");
				ensuredDir = true;
			} catch (err) {
				// Directory already exists is fine — confirm via stat.
				const stat = await adapter.stat(".oas").catch(() => null);
				if (stat?.type === "folder") {
					ensuredDir = true;
				} else {
					// Real failure (permissions, etc.) — leave ensuredDir false so
					// the next call retries instead of silently dropping appends.
					throw err;
				}
			}
		}
		try {
			const line = JSON.stringify(entry) + "\n";
			if (estimatedBytes < 0) {
				const stat = await adapter.stat(AUDIT_FILE).catch(() => null);
				estimatedBytes = stat?.size ?? 0;
			}
			if (estimatedBytes > AUDIT_FILE_MAX_BYTES) {
				try {
					await adapter.remove(AUDIT_FILE_ARCHIVE).catch(() => undefined);
					await adapter.rename(AUDIT_FILE, AUDIT_FILE_ARCHIVE);
					estimatedBytes = 0;
				} catch {
					/* rotation is best-effort */
				}
			}
			await adapter.append(AUDIT_FILE, line);
			estimatedBytes += Buffer.byteLength(line);
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

		// Build everything locally first; only commit to instance state after
		// listen() succeeds, otherwise a port-bind failure leaves cache/sink/
		// tools wired up against a server that never started.
		const cache = new VaultCache(this.app.metadataCache);
		const hooks = this.config.hooks ?? {};
		const tools = buildTools({
			app: this.app,
			getWriteDir: this.config.getWriteDir,
			pathFilter: this.config.pathFilter,
			review: hooks.review,
			reviewBatch: hooks.reviewBatch,
			cache,
			onActivity: (update) => this.recordActivity(update),
			enabledTiers: this.config.enabledTiers,
		}).filter((t) => this.config.enabledTiers.has(t.tier));

		const httpServer = createServer((req, res) => {
			this.handleRequest(req, res).catch((err) => {
				logger.error("MCP", "Unhandled error in request handler", err);
				if (!res.headersSent) {
					res.writeHead(500, { "Content-Type": "application/json" });
					res.end(JSON.stringify({ error: "Internal server error" }));
				}
			});
		});

		httpServer.on("clientError", (err) => {
			logger.warn("MCP", "Client error", err.message);
		});

		// Default 127.0.0.1 — host-only. Production uses the user-configured
		// value via plugin settings; users who need container-side access must
		// explicitly bind to the docker bridge gateway (or 0.0.0.0).
		const bind = this.config.bindAddress || "127.0.0.1";
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (err: Error) => {
					httpServer.removeListener("error", onError);
					reject(err);
				};
				httpServer.once("error", onError);
				httpServer.listen(this.config.port, bind, () => {
					httpServer.removeListener("error", onError);
					resolve();
				});
			});
		} catch (err) {
			cache.destroy();
			try {
				httpServer.close();
			} catch {
				/* ignore */
			}
			throw err;
		}

		// Listen succeeded — commit state.
		this.cache = cache;
		this.tools = tools;
		this.httpServer = httpServer;
		this.startTime = Date.now();
		this.auditLog.setSink(createFileAuditSink(this.app));

		logger.info(
			"MCP",
			`Started on ${bind}:${this.config.port} with ${this.tools.length} tools`,
		);
	}

	async stop(): Promise<void> {
		logger.info("MCP", "Stopping server...");
		for (const timeout of this.sessionTimeouts.values()) clearTimeout(timeout);
		this.sessionTimeouts.clear();

		// Snapshot before iterating: transport.close() fires onclose → cleanupSession,
		// which mutates this.transports while we're walking it.
		const closes = Array.from(this.transports.entries()).map(async ([sid, transport]) => {
			try {
				await transport.close?.();
			} catch (err) {
				logger.warn("MCP", `Error closing transport ${sid.slice(0, 8)}…`, err);
			}
		});
		await Promise.all(closes);
		this.transports.clear();

		if (this.httpServer) {
			const server = this.httpServer;
			let closeTimer: ReturnType<typeof setTimeout> | undefined;
			await Promise.race([
				new Promise<void>((resolve) =>
					server.close(() => {
						if (closeTimer) clearTimeout(closeTimer);
						resolve();
					}),
				),
				new Promise<void>((resolve) => {
					closeTimer = setTimeout(resolve, 2000);
				}),
			]);
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
		try {
			this.config.hooks?.onActivity?.(update);
		} catch (err) {
			logger.warn("MCP", "onActivity hook threw", err);
		}
	}

	/**
	 * Returns the current activity map with stale `working` entries rolled to `idle`.
	 * Pure: derives the rolled view at read time without mutating internal storage.
	 */
	getActivity(): Map<string, ActivityEntry> {
		const now = Date.now();
		const result = new Map<string, ActivityEntry>();
		for (const [name, entry] of this.activity) {
			if (entry.status === "working" && now - entry.updatedAt > ACTIVITY_STALE_MS) {
				result.set(name, { ...entry, status: "idle" });
			} else {
				result.set(name, entry);
			}
		}
		return result;
	}

	getToolCount(): number {
		return this.tools.length;
	}

	getAuditEntries(): readonly AuditEntry[] {
		return this.auditLog.getEntries();
	}

	/**
	 * Decide whether a given Origin header value is allowed to receive the
	 * Authorization-bearing CORS response. We only echo ACAO for trusted
	 * origins so a random page on the user's intranet can't ride the auth
	 * header to talk to our MCP listener via the browser.
	 *
	 * Trusted: missing/null Origin (curl, Obsidian's main process), loopback
	 * HTTP origins (any port), and Obsidian-internal app:// origins (Obsidian's
	 * own MCP client uses Origin: app://obsidian.md).
	 */
	private isOriginAllowed(origin: string | undefined): boolean {
		if (!origin || origin === "null") return true;
		if (origin.startsWith("app://")) return true;
		try {
			const u = new URL(origin);
			if (u.protocol !== "http:" && u.protocol !== "https:") return false;
			const host = u.hostname;
			return (
				host === "127.0.0.1" || host === "localhost" || host === "[::1]" || host === "::1"
			);
		} catch {
			return false;
		}
	}

	private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const origin = req.headers.origin;
		if (this.isOriginAllowed(origin)) {
			// Only echo ACAO when the request comes from a trusted origin.
			// Without an Origin header the browser won't enforce same-origin,
			// so emitting "*" / null is unnecessary — omit entirely.
			if (origin) {
				res.setHeader("Access-Control-Allow-Origin", origin);
				res.setHeader("Vary", "Origin");
			}
		}
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
			logger.debug("MCP", `Auth failed: ${req.method} ${req.url}`);
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

		logger.debug("MCP", `${req.method} /mcp`);

		try {
			if (req.method === "POST") {
				await this.handlePost(req, res);
			} else if (req.method === "GET" || req.method === "DELETE") {
				await this.forwardToTransport(req, res);
			} else {
				res.writeHead(405);
				res.end("Method Not Allowed");
			}
		} catch (err) {
			logger.error("MCP", `Error handling ${req.method} /mcp`, err);
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
		// timingSafeEqual requires equal-length buffers. The length gate leaks
		// only the *header* length, which is a known constant: "Bearer " (7) +
		// 32 hex chars from generateToken() = 39 bytes. No bits of the token
		// secret leak through the length compare.
		if (auth.length !== expected.length) return false;
		return timingSafeEqual(Buffer.from(auth), Buffer.from(expected));
	}

	private async readBody(req: IncomingMessage): Promise<unknown> {
		return new Promise((resolve, reject) => {
			let chunks: Buffer[] = [];
			let size = 0;
			let settled = false;
			const settleResolve = (v: unknown) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(v);
			};
			const settleReject = (err: Error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(err);
			};
			const onData = (chunk: Buffer) => {
				if (settled) return;
				size += chunk.length;
				if (size > MAX_BODY_BYTES) {
					// Drop buffered prefix immediately and tear the request down;
					// remove our listeners so end/error after destroy() can't fire
					// our handlers again or leak references via the closure.
					chunks = [];
					size = 0;
					settleReject(new Error("Request body too large"));
					try {
						req.destroy();
					} catch {
						/* already destroyed */
					}
				} else {
					chunks.push(chunk);
				}
			};
			const onEnd = () => {
				if (settled) return;
				try {
					settleResolve(JSON.parse(Buffer.concat(chunks).toString()));
				} catch {
					settleReject(new Error("Invalid JSON"));
				}
			};
			const onError = (err: Error) => settleReject(err);
			const cleanup = () => {
				req.removeListener("data", onData);
				req.removeListener("end", onEnd);
				req.removeListener("error", onError);
			};
			req.on("data", onData);
			req.on("end", onEnd);
			req.on("error", onError);
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

	/** Pick the timeout budget for a tool — review-modal tools get a longer window. */
	private selectTimeoutMs(tool: McpToolDef): number {
		const mayTriggerReview =
			tool.tier === "writeReviewed" ||
			(tool.tier === "manage" && this.config.enabledTiers.has("writeReviewed"));
		return mayTriggerReview ? this.config.reviewTimeoutMs : this.config.toolTimeoutMs;
	}

	/** Run a tool under the configured timeout and truncate oversize responses;
	 * throws on timeout so the caller can record it as a failure. */
	private async runToolWithLimits(
		tool: McpToolDef,
		args: Record<string, unknown>,
	): Promise<{ result: McpToolResult; success: boolean }> {
		const timeoutMs = this.selectTimeoutMs(tool);
		let timer: ReturnType<typeof setTimeout> | undefined;
		// Note: this setTimeout isn't routed through Plugin.registerInterval
		// because ObsidianMcpServer has no reference to the Plugin instance and
		// adding one for a per-tool-call timer (always cleared in finally) is
		// not worth the coupling. The .finally() clearTimeout below guarantees
		// the timer is released even if the tool throws.
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(
				() =>
					reject(
						new Error(
							tool.tier === "writeReviewed"
								? `Review timed out for '${tool.name}' — user did not respond within ${timeoutMs / 1000}s. The review modal may have been dismissed.`
								: `Tool '${tool.name}' did not respond within ${timeoutMs / 1000}s`,
						),
					),
				timeoutMs,
			);
		});
		const result = await Promise.race([tool.handler(args), timeout]).finally(() => {
			if (timer) clearTimeout(timer);
		});
		// Truncate every text entry independently in the byte domain, then cap
		// the cumulative response at MAX_RESPONSE_TOTAL_BYTES so a tool that
		// returns many sub-cap entries can't still produce a multi-MB payload.
		// String .slice() works in UTF-16 code units, so a naive slice past a
		// multi-byte boundary still over-budgets after re-encoding; we slice
		// the encoded buffer and decode with Replacement-character fallback.
		if (Array.isArray(result.content)) {
			let cumulative = 0;
			for (const entry of result.content) {
				if (typeof entry?.text !== "string") continue;
				if (Buffer.byteLength(entry.text) > MAX_RESPONSE_BYTES) {
					const buf = Buffer.from(entry.text, "utf8").subarray(0, MAX_RESPONSE_BYTES);
					entry.text = buf.toString("utf8") + "\n\n[truncated]";
				}
				const entryBytes = Buffer.byteLength(entry.text);
				const remaining = MAX_RESPONSE_TOTAL_BYTES - cumulative;
				if (remaining <= 0) {
					entry.text = "[truncated]";
				} else if (entryBytes > remaining) {
					const buf = Buffer.from(entry.text, "utf8").subarray(0, remaining);
					entry.text = buf.toString("utf8") + "\n\n[truncated]";
				}
				cumulative += Buffer.byteLength(entry.text);
			}
		}
		return { result, success: !result.isError };
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
				let success = false;
				let result: McpToolResult;
				try {
					const out = await this.runToolWithLimits(tool, args as Record<string, unknown>);
					success = out.success;
					result = out.result;
				} catch (err: unknown) {
					const msg = errMsg(err);
					logger.error("MCP", `Tool ${tool.name} threw`, err);
					result = {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
					};
				}
				const duration = Date.now() - start;
				this.auditLog.record({
					timestamp: Date.now(),
					tool: tool.name,
					success,
					durationMs: duration,
				});
				logger.debug("MCP", `${tool.name} ${success ? "ok" : "err"} ${duration}ms`);
				return result;
			});
		}

		return server;
	}

	/** Resolve mcp-session-id header to a single string, ignoring multi-value forms. */
	private getSessionId(req: IncomingMessage): string | undefined {
		const raw = req.headers["mcp-session-id"];
		if (typeof raw === "string") return raw;
		return undefined;
	}

	private async handlePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const body = await this.readBody(req);
		const sessionId = this.getSessionId(req);

		if (sessionId && this.transports.has(sessionId)) {
			this.resetSessionTimeout(sessionId);
			const transport = this.transports.get(sessionId)!;
			await transport.handleRequest(req, res, body);
			return;
		}

		const transport = new StreamableHTTPServerTransport({
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: (sid: string) => {
				logger.info("MCP", `New session ${sid.slice(0, 8)}…`);
				this.transports.set(sid, transport);
				this.resetSessionTimeout(sid);
			},
		});

		transport.onclose = () => {
			const sid = transport.sessionId;
			if (sid) {
				logger.debug("MCP", `Session ${sid.slice(0, 8)}… closed`);
				this.cleanupSession(sid);
			}
			// No sid means init never completed (no onsessioninitialized). The
			// transport is still being torn down, but we have nothing to remove
			// from this.transports — the entry was never added. Nothing else to
			// do here, but keep the branch explicit so future readers see it.
		};

		try {
			const server = this.createMcpServer();
			await server.connect(transport);
			await transport.handleRequest(req, res, body);
		} catch (err) {
			logger.error("MCP", "Failed to initialize MCP session", err);
			const sid = transport.sessionId;
			if (sid) {
				this.cleanupSession(sid);
			} else {
				// Init failed before onsessioninitialized fired, so the transport
				// isn't tracked in this.transports. Close it directly so we don't
				// leak the underlying SDK resources / SSE keepalives.
				try {
					await transport.close?.();
				} catch (closeErr) {
					logger.debug(
						"MCP",
						"Error closing untracked transport after init failure",
						closeErr,
					);
				}
			}
			throw err;
		}
	}

	private async forwardToTransport(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const sessionId = this.getSessionId(req);
		const transport = sessionId ? this.transports.get(sessionId) : undefined;
		if (!transport || !sessionId) {
			res.writeHead(400, { "Content-Type": "application/json" });
			res.end(JSON.stringify({ error: "Invalid or missing session ID" }));
			return;
		}
		// Treat any traffic on the session (POST/GET-SSE/DELETE) as activity so
		// long-running SSE consumers aren't reaped under the 10-minute idle timer.
		this.resetSessionTimeout(sessionId);
		await transport.handleRequest(req, res);
	}
}

export function generateToken(): string {
	return randomUUID().replace(/-/g, "");
}
