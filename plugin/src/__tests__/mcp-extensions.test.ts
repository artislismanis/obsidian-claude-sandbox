import { describe, it, expect, vi } from "vitest";
import type { TFile } from "obsidian";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => null),
	prepareFuzzySearch: vi.fn(() => () => null),
	FileSystemAdapter: class {},
}));

import { buildTools } from "../mcp-tools";
import type { McpToolDef } from "../mcp-tools";

function canvasFile(path: string): TFile {
	return {
		path,
		name: path.split("/").pop(),
		basename: path
			.replace(/\.canvas$/, "")
			.split("/")
			.pop(),
		extension: "canvas",
		stat: { ctime: 1, mtime: 2, size: 100 },
		vault: {} as never,
		parent: null as never,
	} as unknown as TFile;
}

function mockApp(canvasContent: string) {
	const file = canvasFile("board.canvas");
	const modify = vi.fn(async () => {});
	return {
		app: {
			vault: {
				getFiles: vi.fn(() => [file]),
				getMarkdownFiles: vi.fn(() => []),
				getFileByPath: vi.fn((p: string) => (p === file.path ? file : null)),
				read: vi.fn(async () => canvasContent),
				cachedRead: vi.fn(async () => canvasContent),
				modify,
				create: vi.fn(async () => {}),
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
			workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })) },
		},
		modify,
	};
}

function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const t = tools.find((x) => x.name === name);
	if (!t) throw new Error(`Missing tool ${name}`);
	return t;
}

describe("Canvas tools", () => {
	const initial = JSON.stringify({
		nodes: [{ id: "n1", type: "text", text: "hello" }],
		edges: [],
	});

	it("vault_canvas_read returns parsed JSON", async () => {
		const { app } = mockApp(initial);
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_canvas_read").handler({
			path: "board.canvas",
		});
		expect(result.isError ?? false).toBe(false);
		const content = (result.content[0] as { text: string }).text;
		expect(JSON.parse(content)).toEqual({
			nodes: [{ id: "n1", type: "text", text: "hello" }],
			edges: [],
		});
	});

	it("vault_canvas_read rejects non-canvas files", async () => {
		const { app } = mockApp(initial);
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_canvas_read").handler({
			path: "not.md",
		});
		expect(result.isError).toBe(true);
	});

	it("vault_canvas_modify adds and removes nodes + cascades edges", async () => {
		const withEdge = JSON.stringify({
			nodes: [
				{ id: "n1", type: "text" },
				{ id: "n2", type: "text" },
			],
			edges: [{ id: "e1", fromNode: "n1", toNode: "n2" }],
		});
		const { app, modify } = mockApp(withEdge);
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_canvas_modify").handler({
			path: "board.canvas",
			changes: JSON.stringify({
				addNodes: [{ id: "n3", type: "text" }],
				removeNodeIds: ["n2"],
			}),
		});
		expect(result.isError ?? false).toBe(false);
		const writtenCall = modify.mock.calls[0] as unknown as [TFile, string];
		const doc = JSON.parse(writtenCall[1]);
		expect(doc.nodes.map((n: { id: string }) => n.id).sort()).toEqual(["n1", "n3"]);
		expect(doc.edges).toEqual([]); // edge cascaded out
	});

	it("vault_canvas_modify rejects malformed JSON in `changes`", async () => {
		const { app } = mockApp(initial);
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_canvas_modify").handler({
			path: "board.canvas",
			changes: "not-json",
		});
		expect(result.isError).toBe(true);
	});

	it("both canvas tools are registered under the 'extensions' tier", () => {
		const { app } = mockApp(initial);
		const tools = buildTools(app as never, () => "agent-workspace");
		expect(getTool(tools, "vault_canvas_read").tier).toBe("extensions");
		expect(getTool(tools, "vault_canvas_modify").tier).toBe("extensions");
	});
});
