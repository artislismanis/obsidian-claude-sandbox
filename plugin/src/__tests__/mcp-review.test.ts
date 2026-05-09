import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	prepareFuzzySearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	FileSystemAdapter: class {},
}));

import { buildTools } from "../mcp-tools";
import { makeTFile, createMockApp, getTool } from "./fixtures";

describe("write tools honor reviewFn", () => {
	const file = makeTFile("notes/a.md");
	let app: ReturnType<typeof createMockApp>;

	beforeEach(() => {
		app = createMockApp([file], {
			readBody: "original body\n",
			defaultCache: {
				frontmatter: { existing: "value" },
				headings: [{ heading: "H", level: 1, position: { start: { line: 0 } } }],
			},
		});
	});

	const reviewedWriteCases: {
		name: string;
		args: Record<string, unknown>;
		mutated: "create" | "modify" | "append" | "processFrontMatter";
	}[] = [
		{
			name: "vault_create_reviewed",
			args: { path: "notes/new.md", content: "x" },
			mutated: "create",
		},
		{
			name: "vault_modify_reviewed",
			args: { path: "notes/a.md", content: "new" },
			mutated: "modify",
		},
		{
			name: "vault_append_reviewed",
			args: { path: "notes/a.md", content: "tail" },
			mutated: "append",
		},
		{
			name: "vault_frontmatter_set_reviewed",
			args: { path: "notes/a.md", property: "k", value: "v" },
			mutated: "processFrontMatter",
		},
		{
			name: "vault_frontmatter_delete_reviewed",
			args: { path: "notes/a.md", property: "existing" },
			mutated: "processFrontMatter",
		},
		{
			name: "vault_search_replace_reviewed",
			args: { path: "notes/a.md", search: "original", replace: "revised" },
			mutated: "modify",
		},
		{
			name: "vault_prepend_reviewed",
			args: { path: "notes/a.md", content: "head" },
			mutated: "modify",
		},
		{
			name: "vault_patch_reviewed",
			args: { path: "notes/a.md", content: "ins", line: 1, position: "after" },
			mutated: "modify",
		},
	];

	for (const c of reviewedWriteCases) {
		it(`${c.name} calls review and aborts on rejection`, async () => {
			const review = vi.fn(async () => ({ approved: false }));
			const tools = buildTools({
				app: app as never,
				getWriteDir: () => "agent-workspace",
				review,
			});
			const result = await getTool(tools, c.name).handler(c.args);
			expect(review).toHaveBeenCalledTimes(1);
			expect(result.isError).toBe(true);
			expect(app.vault.create).not.toHaveBeenCalled();
			expect(app.vault.modify).not.toHaveBeenCalled();
			expect(app.vault.append).not.toHaveBeenCalled();
			expect(app.fileManager.processFrontMatter).not.toHaveBeenCalled();
		});

		it(`${c.name} proceeds on approval`, async () => {
			const review = vi.fn(async () => ({ approved: true }));
			const tools = buildTools({
				app: app as never,
				getWriteDir: () => "agent-workspace",
				review,
			});
			const result = await getTool(tools, c.name).handler(c.args);
			expect(review).toHaveBeenCalledTimes(1);
			expect(result.isError ?? false).toBe(false);
			const mutator =
				app.vault[c.mutated as "create" | "modify" | "append"] ??
				app.fileManager.processFrontMatter;
			expect(mutator).toHaveBeenCalled();
		});
	}

	it("non-reviewed tier does not invoke reviewFn even when one is provided", async () => {
		const review = vi.fn(async () => ({ approved: true }));
		const tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review,
		});
		await getTool(tools, "vault_modify").handler({ path: "notes/a.md", content: "x" });
		expect(review).not.toHaveBeenCalled();
	});

	describe("manage tier review (rename/move/delete)", () => {
		const manageCases: {
			name: string;
			args: Record<string, unknown>;
			operation: string;
			mutated: "renameFile" | "trash";
		}[] = [
			{
				name: "vault_rename",
				args: { path: "notes/a.md", name: "b.md" },
				operation: "rename",
				mutated: "renameFile",
			},
			{
				name: "vault_move",
				args: { path: "notes/a.md", to: "archive" },
				operation: "move",
				mutated: "renameFile",
			},
			{
				name: "vault_delete",
				args: { path: "notes/a.md" },
				operation: "delete",
				mutated: "trash",
			},
		];

		for (const c of manageCases) {
			it(`${c.name} calls review with affectedLinks and aborts on rejection`, async () => {
				const review = vi.fn(async () => ({ approved: false }));
				app.metadataCache.resolvedLinks = {
					"notes/other.md": { "notes/a.md": 1 },
				} as never;
				const tools = buildTools({
					app: app as never,
					getWriteDir: () => "agent-workspace",
					review,
				});
				const result = await getTool(tools, c.name).handler(c.args);
				expect(review).toHaveBeenCalledTimes(1);
				const firstCall = review.mock.calls[0] as unknown as [
					{ operation: string; affectedLinks?: string[] },
				];
				expect(firstCall[0].operation).toBe(c.operation);
				expect(firstCall[0].affectedLinks).toEqual(["notes/other.md"]);
				expect(result.isError).toBe(true);
				expect(app.fileManager.renameFile).not.toHaveBeenCalled();
				expect(app.vault.trash).not.toHaveBeenCalled();
			});

			it(`${c.name} proceeds on approval`, async () => {
				const review = vi.fn(async () => ({ approved: true }));
				const tools = buildTools({
					app: app as never,
					getWriteDir: () => "agent-workspace",
					review,
				});
				const result = await getTool(tools, c.name).handler(c.args);
				expect(review).toHaveBeenCalledTimes(1);
				expect(result.isError ?? false).toBe(false);
				const mutator =
					c.mutated === "trash" ? app.vault.trash : app.fileManager.renameFile;
				expect(mutator).toHaveBeenCalled();
			});
		}
	});
});
