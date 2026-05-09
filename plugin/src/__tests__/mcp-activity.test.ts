import { describe, it, expect, vi } from "vitest";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => null),
	prepareFuzzySearch: vi.fn(() => () => null),
	FileSystemAdapter: class {},
}));

import { buildTools } from "../mcp-tools";
import type { McpToolDef } from "../mcp-tools";

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
		workspace: { getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })) },
	};
}

function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const t = tools.find((x) => x.name === name);
	if (!t) throw new Error(`Missing tool ${name}`);
	return t;
}

describe("agent_status_set", () => {
	it("is registered under the 'agent' tier", () => {
		const tools = buildTools({
			app: createMockApp() as never,
			getWriteDir: () => "agent-workspace",
			onActivity: undefined,
		});
		const tool = tools.find((t) => t.name === "agent_status_set");
		expect(tool).toBeDefined();
		expect(tool!.tier).toBe("agent");
	});

	it("invokes onActivity with status + sessionName + detail", async () => {
		const onActivity = vi.fn();
		const tools = buildTools({
			app: createMockApp() as never,
			getWriteDir: () => "agent-workspace",
			onActivity: onActivity,
		});
		const result = await getTool(tools, "agent_status_set").handler({
			status: "awaiting_input",
			sessionName: "work",
			detail: "pick a file",
		});
		expect(result.isError ?? false).toBe(false);
		expect(onActivity).toHaveBeenCalledTimes(1);
		const firstCall = onActivity.mock.calls[0] as unknown as [
			{ sessionName: string; status: string; detail?: string },
		];
		expect(firstCall[0]).toMatchObject({
			sessionName: "work",
			status: "awaiting_input",
			detail: "pick a file",
		});
	});

	it("uses __default__ when sessionName is omitted or empty", async () => {
		const onActivity = vi.fn();
		const tools = buildTools({
			app: createMockApp() as never,
			getWriteDir: () => "agent-workspace",
			onActivity: onActivity,
		});
		await getTool(tools, "agent_status_set").handler({ status: "working" });
		const firstCall = onActivity.mock.calls[0] as unknown as [{ sessionName: string }];
		expect(firstCall[0].sessionName).toBe("__default__");
	});

	it("succeeds even when onActivity is not provided", async () => {
		const tools = buildTools({
			app: createMockApp() as never,
			getWriteDir: () => "agent-workspace",
		});
		const result = await getTool(tools, "agent_status_set").handler({ status: "idle" });
		expect(result.isError ?? false).toBe(false);
	});
});
