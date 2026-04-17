import { createServer } from "http";
import type { Server, IncomingMessage, ServerResponse } from "http";
import type { App } from "obsidian";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { randomUUID, timingSafeEqual } from "crypto";
import type { PermissionTier, McpToolDef } from "./mcp-tools";
import { buildTools } from "./mcp-tools";

export interface McpServerConfig {
	port: number;
	token: string;
	enabledTiers: Set<PermissionTier>;
	getWriteDir: () => string;
}

const SESSION_TIMEOUT_MS = 10 * 60_000;
const MAX_BODY_BYTES = 1024 * 1024;

export class ObsidianMcpServer {
	private httpServer: Server | null = null;
	private transports = new Map<string, StreamableHTTPServerTransport>();
	private sessionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();
	private app: App;
	private config: McpServerConfig;
	private tools: McpToolDef[] = [];

	constructor(app: App, config: McpServerConfig) {
		this.app = app;
		this.config = config;
	}

	async start(): Promise<void> {
		if (this.httpServer) return;

		this.tools = buildTools(this.app, this.config.getWriteDir).filter((t) =>
			this.config.enabledTiers.has(t.tier),
		);

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
				try {
					return await tool.handler(args as Record<string, unknown>);
				} catch (err: unknown) {
					const msg = err instanceof Error ? err.message : String(err);
					return {
						content: [{ type: "text" as const, text: `Error: ${msg}` }],
						isError: true,
					};
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
