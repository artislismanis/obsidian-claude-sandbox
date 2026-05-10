import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "http";
import type { IncomingHttpHeaders } from "http";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => null),
	prepareFuzzySearch: vi.fn(() => () => null),
	FileSystemAdapter: class {},
}));

vi.mock("@modelcontextprotocol/sdk/server/mcp.js", () => {
	class MockMcpServer {
		connect = vi.fn(async () => {});
		registerTool = vi.fn();
	}
	return { McpServer: MockMcpServer };
});

vi.mock("@modelcontextprotocol/sdk/server/streamableHttp.js", () => {
	class MockTransport {
		sessionId: string | null = null;
		onclose: (() => void) | null = null;
		private opts: { onsessioninitialized?: (sid: string) => void };
		constructor(opts: { onsessioninitialized?: (sid: string) => void } = {}) {
			this.opts = opts;
		}
		close = vi.fn(async () => {});
		handleRequest = vi.fn(
			async (
				_req: unknown,
				res: {
					writeHead: (code: number, headers?: Record<string, string>) => void;
					end: (body?: string) => void;
				},
			) => {
				if (this.opts.onsessioninitialized) {
					this.sessionId = "test-session-id";
					this.opts.onsessioninitialized("test-session-id");
				}
				res.writeHead(200, { "Content-Type": "application/json" });
				res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: {} }));
			},
		);
	}
	return { StreamableHTTPServerTransport: MockTransport };
});

import { ObsidianMcpServer, generateToken } from "../mcp-server";

const TEST_PORT = 39182;
const TEST_TOKEN = "test-token-abc123";

function createMockApp() {
	return {
		vault: {
			getFiles: vi.fn(() => []),
			getMarkdownFiles: vi.fn(() => []),
			getFileByPath: vi.fn(() => null),
			read: vi.fn(async () => ""),
			cachedRead: vi.fn(async () => ""),
			create: vi.fn(async () => {}),
			modify: vi.fn(async () => {}),
			append: vi.fn(async () => {}),
			trash: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
			adapter: {
				exists: vi.fn(async () => false),
				mkdir: vi.fn(async () => {}),
				stat: vi.fn(async () => ({ size: 0 })),
				rename: vi.fn(async () => {}),
				remove: vi.fn(async () => {}),
				append: vi.fn(async () => {}),
			},
		},
		metadataCache: {
			getFileCache: vi.fn(() => null),
			getFirstLinkpathDest: vi.fn(() => null),
			resolvedLinks: {},
			unresolvedLinks: {},
			on: vi.fn(() => ({})),
			off: vi.fn(),
			offref: vi.fn(),
		},
		fileManager: {
			renameFile: vi.fn(async () => {}),
			processFrontMatter: vi.fn(async () => {}),
		},
		workspace: {
			getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })),
		},
	};
}

function httpRequest(
	method: string,
	path: string,
	headers: Record<string, string> = {},
	body?: string,
): Promise<{ status: number; body: string; headers: IncomingHttpHeaders }> {
	return new Promise((resolve, reject) => {
		const req = http.request(
			{ hostname: "127.0.0.1", port: TEST_PORT, path, method, headers },
			(res: http.IncomingMessage) => {
				let data = "";
				res.on("data", (chunk: Buffer) => (data += chunk.toString()));
				res.on("end", () =>
					resolve({ status: res.statusCode!, body: data, headers: res.headers }),
				);
			},
		);
		req.on("error", reject);
		if (body) req.write(body);
		req.end();
	});
}

describe("ObsidianMcpServer", () => {
	let server: ObsidianMcpServer;
	const app = createMockApp();

	beforeAll(async () => {
		server = new ObsidianMcpServer(app as never, {
			port: TEST_PORT,
			token: TEST_TOKEN,
			enabledTiers: new Set(["read", "writeScoped"]),
			getWriteDir: () => "agent-workspace",
			toolTimeoutMs: 10_000,
			reviewTimeoutMs: 180_000,
		});
		await server.start();
	});

	afterAll(async () => {
		await server.stop();
	});

	describe("lifecycle", () => {
		it("reports running after start", () => {
			expect(server.isRunning()).toBe(true);
		});

		it("start is idempotent", async () => {
			await server.start();
			expect(server.isRunning()).toBe(true);
		});
	});

	describe("rate limiter boundary", () => {
		it("expires entries at exactly RATE_WINDOW_MS (not before, not after)", () => {
			interface BucketShape {
				timestamps: number[];
			}
			interface RateLimiterShape {
				buckets: Map<string, BucketShape>;
				check: (tool: string, tier: "read" | "writeScoped") => boolean;
			}
			const rl = (server as unknown as { rateLimiter: RateLimiterShape }).rateLimiter;
			// Seed a bucket with a synthetic timestamp exactly RATE_WINDOW_MS
			// in the past so we can assert the boundary semantics: the
			// implementation uses `now - ts >= RATE_WINDOW_MS` to expire, so
			// an entry at exactly the window boundary is expired (drops out
			// of the count) and a new request is accepted.
			const RATE_WINDOW_MS = 60_000;
			const now = Date.now();
			rl.buckets.set("__boundary_probe__", {
				timestamps: [now - RATE_WINDOW_MS],
			});
			// First check: the boundary entry is expired-and-removed; the
			// new entry is recorded and allowed.
			expect(rl.check("__boundary_probe__", "read")).toBe(true);
			const bucket = rl.buckets.get("__boundary_probe__")!;
			expect(bucket.timestamps.length).toBe(1);
			expect(bucket.timestamps[0]).toBeGreaterThanOrEqual(now);
		});
	});

	describe("auth length compare", () => {
		it("rejects on length mismatch without going through timingSafeEqual", async () => {
			// timingSafeEqual throws on length mismatch — checkAuth must
			// guard with a length check first. A wrong-token of a different
			// length should produce a clean 401 (not a 500 thrown error).
			const res = await httpRequest(
				"POST",
				"/mcp",
				{ "Content-Type": "application/json", Authorization: "Bearer short" },
				"{}",
			);
			expect(res.status).toBe(401);
		});

		it("rejects on length mismatch even when much longer than expected", async () => {
			const res = await httpRequest(
				"POST",
				"/mcp",
				{
					"Content-Type": "application/json",
					Authorization: "Bearer " + "a".repeat(1000),
				},
				"{}",
			);
			expect(res.status).toBe(401);
		});
	});

	describe("body size limit", () => {
		it("rejects payloads above MAX_BODY_BYTES with auth ok", async () => {
			// MAX_BODY_BYTES is 1 MiB. We send 1.5 MiB of JSON-ish junk
			// (still inside an envelope) so the listener accepts the
			// connection then trips the size guard mid-stream.
			const big = JSON.stringify({
				jsonrpc: "2.0",
				id: 1,
				method: "x",
				payload: "a".repeat(1_500_000),
			});
			const res = await httpRequest(
				"POST",
				"/mcp",
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TEST_TOKEN}`,
				},
				big,
			).catch(() => null);
			// On many platforms the server destroys the request before
			// finishing the response, which surfaces as a connection
			// reset (null result). Either outcome is acceptable — what
			// matters is the listener is still alive after.
			if (res) expect(res.status).toBeGreaterThanOrEqual(400);
			// Listener still up: a small follow-up request goes through.
			const after = await httpRequest("GET", "/mcp/health", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(after.status).toBe(200);
		});
	});

	describe("authentication", () => {
		it("rejects requests without auth header", async () => {
			const res = await httpRequest(
				"POST",
				"/mcp",
				{ "Content-Type": "application/json" },
				"{}",
			);
			expect(res.status).toBe(401);
			expect(JSON.parse(res.body).error).toBe("Unauthorized");
		});

		it("rejects requests with wrong token", async () => {
			const res = await httpRequest(
				"POST",
				"/mcp",
				{ "Content-Type": "application/json", Authorization: "Bearer wrong-token" },
				"{}",
			);
			expect(res.status).toBe(401);
		});

		it("accepts requests with correct token", async () => {
			const res = await httpRequest(
				"POST",
				"/mcp",
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TEST_TOKEN}`,
				},
				JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "initialize",
					params: {
						protocolVersion: "2025-03-26",
						capabilities: {},
						clientInfo: { name: "test", version: "1.0" },
					},
				}),
			);
			expect(res.status).toBe(200);
		});
	});

	describe("routing", () => {
		it("returns 404 for wrong path", async () => {
			const res = await httpRequest("POST", "/wrong", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(res.status).toBe(404);
		});

		it("returns 405 for unsupported method", async () => {
			const res = await httpRequest("PUT", "/mcp", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(res.status).toBe(405);
		});

		it("handles CORS preflight without auth", async () => {
			const res = await httpRequest("OPTIONS", "/mcp");
			expect(res.status).toBe(204);
			// No Origin header was sent → no ACAO echoed; only the always-on
			// methods/headers are advertised. Loopback-origin echoing is
			// covered by the dedicated "echoes ACAO" test below.
			expect(res.headers["access-control-allow-origin"]).toBeUndefined();
			expect(res.headers["access-control-allow-methods"]).toContain("POST");
			expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
		});

		it("echoes ACAO for loopback origins", async () => {
			const res = await httpRequest("OPTIONS", "/mcp", { Origin: "http://127.0.0.1:5555" });
			expect(res.status).toBe(204);
			expect(res.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:5555");
			expect(res.headers["vary"]).toBe("Origin");
		});

		it("echoes ACAO for app:// origins (Obsidian client)", async () => {
			const res = await httpRequest("OPTIONS", "/mcp", { Origin: "app://obsidian.md" });
			expect(res.status).toBe(204);
			expect(res.headers["access-control-allow-origin"]).toBe("app://obsidian.md");
		});

		it("omits ACAO for non-loopback origins", async () => {
			const res = await httpRequest("OPTIONS", "/mcp", {
				Origin: "https://evil.example.com",
			});
			expect(res.status).toBe(204);
			expect(res.headers["access-control-allow-origin"]).toBeUndefined();
		});

		it("returns 400 for GET without session", async () => {
			const res = await httpRequest("GET", "/mcp", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(res.status).toBe(400);
		});

		it("returns 400 for DELETE without session", async () => {
			const res = await httpRequest("DELETE", "/mcp", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(res.status).toBe(400);
		});
	});

	describe("CORS headers", () => {
		it("includes CORS expose-headers on authenticated responses", async () => {
			const res = await httpRequest(
				"POST",
				"/mcp",
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TEST_TOKEN}`,
					Origin: "http://localhost:1234",
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			);
			expect(res.headers["access-control-allow-origin"]).toBe("http://localhost:1234");
			expect(res.headers["access-control-expose-headers"]).toContain("Mcp-Session-Id");
		});
	});

	describe("health check", () => {
		it("returns status, tool count, and uptime", async () => {
			const res = await httpRequest("GET", "/mcp/health", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(res.status).toBe(200);
			const body = JSON.parse(res.body);
			expect(body.status).toBe("ok");
			expect(typeof body.tools).toBe("number");
			expect(typeof body.uptimeMs).toBe("number");
			expect(body.uptimeMs).toBeGreaterThanOrEqual(0);
		});
	});

	describe("audit log", () => {
		it("returns entries array", async () => {
			const res = await httpRequest("GET", "/mcp/audit", {
				Authorization: `Bearer ${TEST_TOKEN}`,
			});
			expect(res.status).toBe(200);
			const body = JSON.parse(res.body);
			expect(Array.isArray(body.entries)).toBe(true);
		});

		it("creates .oas directory and appends a JSON line per invocation", async () => {
			// Reach into private state to trigger an audit entry via the sink.
			// Easier than spinning up a full MCP tool invocation over HTTP.
			interface AuditShape {
				timestamp: number;
				tool: string;
				success: boolean;
				durationMs: number;
			}
			const sinkFn = (
				server as unknown as {
					auditLog: { record: (e: AuditShape) => void };
				}
			).auditLog;
			sinkFn.record({
				timestamp: Date.now(),
				tool: "vault_read",
				success: true,
				durationMs: 3,
			});
			await new Promise((r) => setTimeout(r, 5));
			expect(app.vault.adapter.append).toHaveBeenCalledWith(
				".oas/mcp-audit.jsonl",
				expect.stringContaining('"tool":"vault_read"'),
			);
		});

		it("does not throw when the file sink fails", async () => {
			app.vault.adapter.append.mockRejectedValueOnce(new Error("disk full"));
			interface AuditShape {
				timestamp: number;
				tool: string;
				success: boolean;
				durationMs: number;
			}
			const log = (
				server as unknown as {
					auditLog: { record: (e: AuditShape) => void };
				}
			).auditLog;
			expect(() =>
				log.record({
					timestamp: Date.now(),
					tool: "vault_read",
					success: true,
					durationMs: 2,
				}),
			).not.toThrow();
			await new Promise((r) => setTimeout(r, 5));
		});
	});

	describe("tool count", () => {
		it("returns count via getToolCount()", () => {
			expect(typeof server.getToolCount()).toBe("number");
		});
	});

	describe("stop", () => {
		it("stops cleanly and reports not running", async () => {
			const tempServer = new ObsidianMcpServer(app as never, {
				port: TEST_PORT + 1,
				token: "temp",
				enabledTiers: new Set(["read"]),
				getWriteDir: () => "agent-workspace",
				toolTimeoutMs: 10_000,
				reviewTimeoutMs: 180_000,
			});
			await tempServer.start();
			expect(tempServer.isRunning()).toBe(true);
			await tempServer.stop();
			expect(tempServer.isRunning()).toBe(false);
		});
	});
});

describe("generateToken", () => {
	it("returns a 32-char hex string", () => {
		const token = generateToken();
		expect(token).toMatch(/^[a-f0-9]{32}$/);
	});

	it("returns unique values", () => {
		const a = generateToken();
		const b = generateToken();
		expect(a).not.toBe(b);
	});
});
