import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	prepareFuzzySearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	FileSystemAdapter: class {},
}));

import { buildTools } from "../mcp-tools";
import { makeTFile, createMockApp, getTool } from "./fixtures";

describe("vault_batch_frontmatter batch review", () => {
	const files = [makeTFile("a.md"), makeTFile("b.md"), makeTFile("c.md")];
	let app: ReturnType<typeof createMockApp>;

	beforeEach(() => {
		app = createMockApp(files, { readBody: "body", defaultCache: { frontmatter: {} } });
	});

	it("invokes reviewBatchFn and applies only to approved paths", async () => {
		const reviewBatch = vi.fn(async () => ({
			approved: true,
			approvedPaths: ["a.md", "c.md"],
		}));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			reviewBatch: reviewBatch,
		});
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: false,
		});
		expect(result.isError ?? false).toBe(false);
		expect(reviewBatch).toHaveBeenCalledTimes(1);
		const firstCall = reviewBatch.mock.calls[0] as unknown as [
			{ items: Array<{ filePath: string }> },
		];
		expect(firstCall[0].items).toHaveLength(3);
		expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(2);
	});

	it("aborts when user rejects all", async () => {
		const reviewBatch = vi.fn(async () => ({
			approved: false,
			approvedPaths: [],
		}));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			reviewBatch: reviewBatch,
		});
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: false,
		});
		expect(result.isError).toBe(true);
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});

	it("falls through to direct apply when reviewBatchFn is absent", async () => {
		const tools = buildTools({ app: app as never, getWriteDir: () => "agent-workspace" });
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: false,
		});
		expect(result.isError ?? false).toBe(false);
		expect(app.fileManager.processFrontMatter).toHaveBeenCalledTimes(3);
	});

	it("respects dryRun (no review call, no mutation)", async () => {
		const reviewBatch = vi.fn(async () => ({
			approved: true,
			approvedPaths: ["a.md"],
		}));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			reviewBatch: reviewBatch,
		});
		const result = await getTool(tools, "vault_batch_frontmatter").handler({
			query: "anything",
			property: "status",
			value: '"draft"',
			dryRun: true,
		});
		expect(result.isError ?? false).toBe(false);
		expect(reviewBatch).not.toHaveBeenCalled();
		expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
	});
});
