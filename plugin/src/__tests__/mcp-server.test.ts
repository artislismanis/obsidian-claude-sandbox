import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
import * as http from "http";
import type { IncomingHttpHeaders } from "http";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => null),
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
		},
		metadataCache: {
			getFileCache: vi.fn(() => null),
			getFirstLinkpathDest: vi.fn(() => null),
			resolvedLinks: {},
			unresolvedLinks: {},
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
			expect(res.headers["access-control-allow-origin"]).toBe("*");
			expect(res.headers["access-control-allow-methods"]).toContain("POST");
			expect(res.headers["access-control-allow-headers"]).toContain("Authorization");
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
		it("includes CORS headers on authenticated responses", async () => {
			const res = await httpRequest(
				"POST",
				"/mcp",
				{
					"Content-Type": "application/json",
					Authorization: `Bearer ${TEST_TOKEN}`,
				},
				JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
			);
			expect(res.headers["access-control-allow-origin"]).toBe("*");
			expect(res.headers["access-control-expose-headers"]).toContain("Mcp-Session-Id");
		});
	});

	describe("stop", () => {
		it("stops cleanly and reports not running", async () => {
			const tempServer = new ObsidianMcpServer(app as never, {
				port: TEST_PORT + 1,
				token: "temp",
				enabledTiers: new Set(["read"]),
				getWriteDir: () => "agent-workspace",
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
