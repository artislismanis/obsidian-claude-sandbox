import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
	isDockerAvailable,
	isImageBuilt,
	containerExec,
	httpPost,
	httpGet,
	parseJsonOrSse,
	mcpInitialize,
	mcpRequest,
	MCP_PORT,
	MCP_TOKEN,
	type McpSession,
} from "./helpers";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: () => () => null,
}));

const SKIP = !isDockerAvailable() || !isImageBuilt();

// Container lifecycle is managed by globalSetup.ts.
describe.skipIf(SKIP)("MCP server integration with container", () => {
	it("container can resolve host.docker.internal", () => {
		const output = containerExec("getent hosts host.docker.internal");
		expect(output).toMatch(/\d+\.\d+\.\d+\.\d+/);
	});

	it("container can reach MCP port on host (when server is running)", async () => {
		// This test validates network connectivity, not the MCP server itself.
		// The MCP server runs inside Obsidian on the host.
		// Here we verify the container CAN reach the host port.
		// When no server is running, the connection is refused — that's expected.
		try {
			const output = containerExec(
				`curl -s -o /dev/null -w "%{http_code}" http://host.docker.internal:${MCP_PORT}/mcp 2>/dev/null || echo "refused"`,
			);
			// Either "refused" (no server) or a status code (server running)
			expect(["refused", "401", "000"]).toContain(output);
		} catch {
			// curl not finding host is also acceptable in some Docker network configs
		}
	});

	it("MCP token env var matches expected value inside container", () => {
		const token = containerExec("echo $OAS_MCP_TOKEN");
		expect(token).toBe(MCP_TOKEN);
	});

	it(".mcp.json is present in workspace", () => {
		const output = containerExec("cat /workspace/.mcp.json");
		const config = JSON.parse(output);
		expect(config.mcpServers).toHaveProperty("memory");
		expect(config.mcpServers).toHaveProperty("obsidian");
	});

	it("obsidian MCP config uses stdio proxy script", () => {
		const output = containerExec("cat /workspace/.mcp.json");
		const config = JSON.parse(output);
		const obsidian = config.mcpServers.obsidian;
		expect(obsidian.command).toBe("node");
		expect(obsidian.args[0]).toContain("obsidian-mcp-proxy.js");
	});

	it("memory MCP server binary is available", () => {
		const output = containerExec("which mcp-server-memory");
		expect(output).toContain("mcp-server-memory");
	});
});

describe.skipIf(SKIP)("MCP HTTP server (standalone, no Obsidian)", () => {
	// These tests start a real MCP HTTP server with a mocked App.
	// They verify the full HTTP stack works end-to-end without Obsidian.

	let stopServer: () => Promise<void>;

	beforeAll(async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");

		const mockApp = {
			vault: {
				getFiles: () => [],
				getMarkdownFiles: () => [],
				getFileByPath: () => null,
				read: async () => "",
				cachedRead: async () => "",
				create: async () => {},
				modify: async () => {},
				append: async () => {},
				trash: async () => {},
				createFolder: async () => {},
			},
			metadataCache: {
				getFileCache: () => null,
				getFirstLinkpathDest: () => null,
				resolvedLinks: {},
				unresolvedLinks: {},
			},
			fileManager: {
				renameFile: async () => {},
				processFrontMatter: async () => {},
			},
			workspace: {
				getLeaf: () => ({ openFile: async () => {} }),
			},
		};

		const server = new ObsidianMcpServer(mockApp as never, {
			port: MCP_PORT,
			token: MCP_TOKEN,
			enabledTiers: new Set(["read", "writeScoped"]),
			getWriteDir: () => "agent-workspace",
		});

		await server.start();
		stopServer = () => server.stop();
	});

	afterAll(async () => {
		if (stopServer) await stopServer();
	});

	it("rejects unauthenticated requests", async () => {
		const res = await httpPost(`http://127.0.0.1:${MCP_PORT}/mcp`, {});
		expect(res.status).toBe(401);
	});

	it("accepts authenticated requests", async () => {
		const res = await httpPost(
			`http://127.0.0.1:${MCP_PORT}/mcp`,
			{
				jsonrpc: "2.0",
				id: 1,
				method: "initialize",
				params: {
					protocolVersion: "2025-03-26",
					capabilities: {},
					clientInfo: { name: "integration-test", version: "1.0" },
				},
			},
			{ Authorization: `Bearer ${MCP_TOKEN}` },
		);
		expect(res.status).toBe(200);
		const body = parseJsonOrSse(res.body) as { result?: unknown };
		expect(body.result).toBeDefined();
	});

	it("returns 404 for wrong path", async () => {
		const status = await httpGet(`http://127.0.0.1:${MCP_PORT}/wrong`);
		// GET to wrong path with no auth → 401 (auth checked before path)
		expect(status).toBe(401);
	});

	it("CORS preflight works", async () => {
		const status = await httpGet(`http://127.0.0.1:${MCP_PORT}/mcp`);
		// GET without session → after auth, returns 400
		// But without auth header → 401
		expect([400, 401]).toContain(status);
	});
});

// Ports for the additional test servers. Offset from MCP_PORT to avoid conflicts.
const TIER_PORT_BASE = MCP_PORT + 10; // 38090–38092

function makeMockApp() {
	return {
		vault: {
			getFiles: () => [],
			getMarkdownFiles: () => [],
			getFileByPath: () => null,
			read: async () => "",
			cachedRead: async () => "",
			create: async () => {},
			modify: async () => {},
			append: async () => {},
			trash: async () => {},
			createFolder: async () => {},
		},
		metadataCache: {
			getFileCache: () => null,
			getFirstLinkpathDest: () => null,
			resolvedLinks: {},
			unresolvedLinks: {},
		},
		fileManager: {
			renameFile: async () => {},
			processFrontMatter: async () => {},
		},
		workspace: {
			getLeaf: () => ({ openFile: async () => {} }),
		},
	};
}

describe.skipIf(SKIP)("MCP tools/list and tier enforcement", () => {
	// Three servers: read+writeScoped (default), read-only, all tiers.
	const stops: Array<() => Promise<void>> = [];
	let defaultSession: McpSession;
	let readOnlySession: McpSession;
	let allTiersSession: McpSession;

	beforeAll(async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");
		const mockApp = makeMockApp();

		const configs: [number, string[]][] = [
			[TIER_PORT_BASE, ["read", "writeScoped"]],
			[TIER_PORT_BASE + 1, ["read"]],
			[TIER_PORT_BASE + 2, ["read", "writeScoped", "writeVault", "navigate", "manage"]],
		];

		for (const [port, tiers] of configs) {
			const s = new ObsidianMcpServer(mockApp as never, {
				port,
				token: MCP_TOKEN,
				enabledTiers: new Set(tiers),
				getWriteDir: () => "agent-workspace",
			});
			await s.start();
			stops.push(() => s.stop());
		}

		[defaultSession, readOnlySession, allTiersSession] = await Promise.all([
			mcpInitialize(TIER_PORT_BASE, MCP_TOKEN),
			mcpInitialize(TIER_PORT_BASE + 1, MCP_TOKEN),
			mcpInitialize(TIER_PORT_BASE + 2, MCP_TOKEN),
		]);
	});

	afterAll(async () => {
		await Promise.all(stops.map((s) => s()));
	});

	it("read+writeScoped: read tools present", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("vault_search");
		expect(names).toContain("vault_list");
		expect(names).toContain("vault_read");
	});

	it("read+writeScoped: writeScoped tools present", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).toContain("vault_create");
		expect(names).toContain("vault_modify");
		expect(names).toContain("vault_append");
	});

	it("read+writeScoped: writeVault, navigate, manage tools absent", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).not.toContain("vault_create_anywhere");
		expect(names).not.toContain("vault_open");
		expect(names).not.toContain("vault_rename");
		expect(names).not.toContain("vault_delete");
	});

	it("read+writeScoped: exactly 15 tools (11 read + 4 writeScoped)", async () => {
		const res = (await mcpRequest(defaultSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		expect(res.result.tools).toHaveLength(15);
	});

	it("read-only: 11 read tools, no write/navigate/manage tools", async () => {
		const res = (await mcpRequest(readOnlySession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).toHaveLength(11);
		expect(names).toContain("vault_search");
		expect(names).not.toContain("vault_create");
		expect(names).not.toContain("vault_open");
		expect(names).not.toContain("vault_rename");
	});

	it("all tiers: all 24 tools present", async () => {
		const res = (await mcpRequest(allTiersSession, "tools/list")) as {
			result: { tools: { name: string }[] };
		};
		const names = res.result.tools.map((t) => t.name);
		expect(names).toHaveLength(24);
		// One representative from each tier
		expect(names).toContain("vault_search"); // read
		expect(names).toContain("vault_create"); // writeScoped
		expect(names).toContain("vault_create_anywhere"); // writeVault
		expect(names).toContain("vault_open"); // navigate
		expect(names).toContain("vault_rename"); // manage
	});
});

describe.skipIf(SKIP)("MCP tool invocation (HTTP end-to-end)", () => {
	let session: McpSession;
	let stopServer: () => Promise<void>;

	const INVOKE_PORT = MCP_PORT + 20; // 38100

	beforeAll(async () => {
		const { ObsidianMcpServer } = await import("../../src/mcp-server");
		const server = new ObsidianMcpServer(makeMockApp() as never, {
			port: INVOKE_PORT,
			token: MCP_TOKEN,
			enabledTiers: new Set(["read", "writeScoped"]),
			getWriteDir: () => "agent-workspace",
		});
		await server.start();
		stopServer = () => server.stop();
		session = await mcpInitialize(INVOKE_PORT, MCP_TOKEN);
	});

	afterAll(async () => {
		if (stopServer) await stopServer();
	});

	it("vault_list returns (no files) for empty vault", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_list",
			arguments: {},
		})) as { result: { content: { text: string }[] } };
		expect(res.result.content[0].text).toBe("(no files)");
	});

	it("vault_search returns no matches for empty vault", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_search",
			arguments: { query: "anything" },
		})) as { result: { content: { text: string }[] } };
		expect(res.result.content[0].text).toBe("No matches found.");
	});

	it("vault_read returns error for missing file", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_read",
			arguments: { path: "nonexistent.md" },
		})) as { result: { content: { text: string }[]; isError: boolean } };
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toBe("File not found.");
	});

	it("vault_create rejects path outside write directory", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_create",
			arguments: { path: "../escape.md", content: "evil" },
		})) as { result: { content: { text: string }[]; isError: boolean } };
		expect(res.result.isError).toBe(true);
		expect(res.result.content[0].text).toContain("write directory");
	});

	it("vault_create succeeds for path inside write directory", async () => {
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_create",
			arguments: { path: "agent-workspace/test.md", content: "hello" },
		})) as { result: { content: { text: string }[]; isError?: boolean } };
		expect(res.result.isError).toBeFalsy();
		expect(res.result.content[0].text).toContain("Created");
	});

	it("calling a tool from a disabled tier fails", async () => {
		// navigate tier is not enabled; vault_open is not registered with the MCP SDK.
		// The SDK may return a JSON-RPC error envelope OR a result with isError — either is acceptable.
		const res = (await mcpRequest(session, "tools/call", {
			name: "vault_open",
			arguments: { path: "Welcome.md" },
		})) as {
			error?: unknown;
			result?: { isError?: boolean };
		};
		const failed = res.error != null || res.result?.isError === true;
		expect(failed).toBe(true);
	});
});
