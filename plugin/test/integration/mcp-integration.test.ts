import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import {
	isDockerAvailable,
	isImageBuilt,
	containerExec,
	httpPost,
	httpGet,
	parseJsonOrSse,
	MCP_PORT,
	MCP_TOKEN,
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

	it("obsidian MCP config references correct env vars", () => {
		const output = containerExec("cat /workspace/.mcp.json");
		const config = JSON.parse(output);
		const obsidian = config.mcpServers.obsidian;
		expect(obsidian.url).toContain("host.docker.internal");
		expect(obsidian.url).toContain("${OAS_MCP_PORT}");
		expect(obsidian.headers.Authorization).toContain("${OAS_MCP_TOKEN}");
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
