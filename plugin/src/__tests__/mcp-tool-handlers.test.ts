import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TFile, TFolder } from "obsidian";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(),
}));

import { buildTools } from "../mcp-tools";
import type { McpToolDef } from "../mcp-tools";

function makeTFile(path: string, content = ""): TFile {
	const parts = path.split("/");
	const name = parts[parts.length - 1];
	const ext = name.includes(".") ? name.split(".").pop()! : "";
	const basename = name.replace(`.${ext}`, "");
	return {
		path,
		name,
		basename,
		extension: ext,
		stat: { ctime: 1700000000000, mtime: 1700001000000, size: content.length || 100 },
		vault: {} as never,
		parent: { path: parts.slice(0, -1).join("/") || "" } as TFolder,
	} as TFile;
}

function createMockApp(files: TFile[], caches: Record<string, unknown> = {}) {
	const app = {
		vault: {
			getFiles: vi.fn(() => files),
			getMarkdownFiles: vi.fn(() => files.filter((f) => f.extension === "md")),
			getFileByPath: vi.fn((path: string) => files.find((f) => f.path === path) ?? null),
			read: vi.fn(async (f: TFile) => `content of ${f.path}`),
			cachedRead: vi.fn(async (f: TFile) => `content of ${f.path}`),
			create: vi.fn(async () => {}),
			modify: vi.fn(async () => {}),
			append: vi.fn(async () => {}),
			trash: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
		},
		metadataCache: {
			getFileCache: vi.fn((f: TFile) => caches[f.path] ?? null),
			getFirstLinkpathDest: vi.fn(
				(link: string) => files.find((f) => f.basename === link || f.name === link) ?? null,
			),
			resolvedLinks: {} as Record<string, Record<string, number>>,
			unresolvedLinks: {} as Record<string, Record<string, number>>,
		},
		fileManager: {
			renameFile: vi.fn(async () => {}),
			processFrontMatter: vi.fn(
				async (_f: TFile, fn: (fm: Record<string, unknown>) => void) => {
					const fm: Record<string, unknown> = {};
					fn(fm);
				},
			),
		},
		workspace: {
			getLeaf: vi.fn(() => ({ openFile: vi.fn(async () => {}) })),
		},
	};
	return app;
}

function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`Tool ${name} not found`);
	return tool;
}

function getResult(result: { content: Array<{ text: string }>; isError?: boolean }) {
	return { text: result.content[0].text, isError: result.isError ?? false };
}

describe("MCP tool handlers", () => {
	const testFiles = [
		makeTFile("notes/hello.md"),
		makeTFile("notes/world.md"),
		makeTFile("agent-workspace/draft.md"),
		makeTFile("config.json"),
	];

	const caches: Record<string, unknown> = {
		"notes/hello.md": {
			tags: [{ tag: "#project" }, { tag: "#important" }],
			frontmatter: { title: "Hello", status: "active", position: {} },
			headings: [
				{ heading: "Introduction", level: 1 },
				{ heading: "Details", level: 2 },
			],
		},
		"notes/world.md": {
			tags: [{ tag: "#project" }],
			frontmatter: { tags: ["travel", "notes"] },
			headings: [],
		},
	};

	let app: ReturnType<typeof createMockApp>;
	let tools: McpToolDef[];

	beforeEach(() => {
		app = createMockApp(testFiles, caches);
		app.metadataCache.resolvedLinks = {
			"notes/hello.md": { "notes/world.md": 2 },
			"notes/world.md": {},
		};
		app.metadataCache.unresolvedLinks = {
			"notes/hello.md": { nonexistent: 1 },
		};
		tools = buildTools(app as never, () => "agent-workspace");
	});

	describe("tool registration", () => {
		it("registers all expected tools", () => {
			const names = tools.map((t) => t.name);
			expect(names).toContain("vault_read");
			expect(names).toContain("vault_list");
			expect(names).toContain("vault_search");
			expect(names).toContain("vault_tags");
			expect(names).toContain("vault_frontmatter");
			expect(names).toContain("vault_links");
			expect(names).toContain("vault_backlinks");
			expect(names).toContain("vault_headings");
			expect(names).toContain("vault_orphans");
			expect(names).toContain("vault_unresolved");
			expect(names).toContain("vault_create");
			expect(names).toContain("vault_modify");
			expect(names).toContain("vault_append");
			expect(names).toContain("vault_frontmatter_set");
			expect(names).toContain("vault_create_anywhere");
			expect(names).toContain("vault_open");
			expect(names).toContain("vault_rename");
			expect(names).toContain("vault_move");
			expect(names).toContain("vault_delete");
			expect(names).toContain("vault_create_folder");
		});

		it("assigns correct tiers", () => {
			expect(getTool(tools, "vault_read").tier).toBe("read");
			expect(getTool(tools, "vault_create").tier).toBe("writeScoped");
			expect(getTool(tools, "vault_create_anywhere").tier).toBe("writeVault");
			expect(getTool(tools, "vault_open").tier).toBe("navigate");
			expect(getTool(tools, "vault_rename").tier).toBe("manage");
		});
	});

	describe("vault_read", () => {
		it("reads file by path", async () => {
			const r = getResult(
				await getTool(tools, "vault_read").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("content of notes/hello.md");
		});

		it("reads file by wikilink name", async () => {
			const r = getResult(await getTool(tools, "vault_read").handler({ file: "hello" }));
			expect(r.isError).toBe(false);
			expect(r.text).toContain("hello.md");
		});

		it("returns error for nonexistent file", async () => {
			const r = getResult(await getTool(tools, "vault_read").handler({ path: "nope.md" }));
			expect(r.isError).toBe(true);
			expect(r.text).toBe("File not found.");
		});
	});

	describe("vault_list", () => {
		it("lists all files", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({}));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("config.json");
		});

		it("filters by folder", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({ folder: "notes" }));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).not.toContain("config.json");
		});

		it("filters by extension", async () => {
			const r = getResult(await getTool(tools, "vault_list").handler({ extension: "json" }));
			expect(r.text).toBe("config.json");
		});
	});

	describe("vault_file_info", () => {
		it("returns file metadata", async () => {
			const r = getResult(
				await getTool(tools, "vault_file_info").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("path: notes/hello.md");
			expect(r.text).toContain("name: hello");
			expect(r.text).toContain("extension: md");
		});
	});

	describe("vault_tags", () => {
		it("returns tags for a specific file", async () => {
			const r = getResult(
				await getTool(tools, "vault_tags").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("#project");
			expect(r.text).toContain("#important");
		});

		it("returns vault-wide tag counts", async () => {
			const r = getResult(await getTool(tools, "vault_tags").handler({}));
			expect(r.text).toContain("#project: 2");
		});

		it("normalizes frontmatter tags with # prefix", async () => {
			const r = getResult(
				await getTool(tools, "vault_tags").handler({ path: "notes/world.md" }),
			);
			expect(r.text).toContain("#travel");
			expect(r.text).toContain("#notes");
		});
	});

	describe("vault_frontmatter", () => {
		it("returns full frontmatter", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({ path: "notes/hello.md" }),
			);
			const parsed = JSON.parse(r.text);
			expect(parsed.title).toBe("Hello");
			expect(parsed.status).toBe("active");
			expect(parsed.position).toBeUndefined();
		});

		it("returns specific property", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({
					path: "notes/hello.md",
					property: "status",
				}),
			);
			expect(r.text).toBe('"active"');
		});

		it("returns error for missing property", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({
					path: "notes/hello.md",
					property: "nonexistent",
				}),
			);
			expect(r.text).toContain("not found");
		});

		it("handles file without frontmatter", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter").handler({
					path: "agent-workspace/draft.md",
				}),
			);
			expect(r.text).toBe("(no frontmatter)");
		});
	});

	describe("vault_links", () => {
		it("returns outgoing links", async () => {
			const r = getResult(
				await getTool(tools, "vault_links").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("notes/world.md (2)");
		});

		it("returns empty for file with no links", async () => {
			const r = getResult(
				await getTool(tools, "vault_links").handler({ path: "notes/world.md" }),
			);
			expect(r.text).toBe("(no outgoing links)");
		});
	});

	describe("vault_backlinks", () => {
		it("returns files linking to target", async () => {
			const r = getResult(
				await getTool(tools, "vault_backlinks").handler({ path: "notes/world.md" }),
			);
			expect(r.text).toContain("notes/hello.md");
		});
	});

	describe("vault_headings", () => {
		it("returns indented outline", async () => {
			const r = getResult(
				await getTool(tools, "vault_headings").handler({ path: "notes/hello.md" }),
			);
			expect(r.text).toContain("Introduction");
			expect(r.text).toContain("  Details");
		});
	});

	describe("vault_orphans", () => {
		it("returns files with no incoming links", async () => {
			const r = getResult(await getTool(tools, "vault_orphans").handler({}));
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("agent-workspace/draft.md");
			expect(r.text).not.toContain("notes/world.md");
		});
	});

	describe("vault_unresolved", () => {
		it("returns broken wikilinks", async () => {
			const r = getResult(await getTool(tools, "vault_unresolved").handler({}));
			expect(r.text).toContain("nonexistent");
			expect(r.text).toContain("notes/hello.md");
		});
	});

	describe("vault_create (scoped)", () => {
		it("creates file within write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/new.md",
					content: "hello",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.create).toHaveBeenCalledWith("agent-workspace/new.md", "hello");
		});

		it("rejects file outside write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "notes/evil.md",
					content: "hack",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("write directory");
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it("rejects path traversal", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/../secret.md",
				}),
			);
			expect(r.isError).toBe(true);
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it("rejects if file already exists", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/draft.md",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("already exists");
		});
	});

	describe("vault_create_anywhere (vault-wide)", () => {
		it("creates file at any path", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_anywhere").handler({
					path: "notes/new.md",
					content: "hello",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.create).toHaveBeenCalledWith("notes/new.md", "hello");
		});
	});

	describe("vault_modify (scoped)", () => {
		it("modifies file within write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_modify").handler({
					path: "agent-workspace/draft.md",
					content: "updated",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalled();
		});

		it("rejects file outside write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_modify").handler({
					path: "notes/hello.md",
					content: "evil",
				}),
			);
			expect(r.isError).toBe(true);
		});
	});

	describe("vault_frontmatter_set", () => {
		it("sets property on file in write dir", async () => {
			const r = getResult(
				await getTool(tools, "vault_frontmatter_set").handler({
					path: "agent-workspace/draft.md",
					property: "status",
					value: "done",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.processFrontMatter).toHaveBeenCalled();
		});

		it("parses JSON values", async () => {
			await getTool(tools, "vault_frontmatter_set").handler({
				path: "agent-workspace/draft.md",
				property: "tags",
				value: '["a","b"]',
			});
			const callback = app.fileManager.processFrontMatter.mock.calls[0][1];
			const fm: Record<string, unknown> = {};
			callback(fm);
			expect(fm.tags).toEqual(["a", "b"]);
		});
	});

	describe("vault_rename", () => {
		it("renames file and preserves extension", async () => {
			const r = getResult(
				await getTool(tools, "vault_rename").handler({
					path: "notes/hello.md",
					name: "greeting",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"notes/greeting.md",
			);
		});
	});

	describe("vault_move", () => {
		it("moves file to new folder", async () => {
			const r = getResult(
				await getTool(tools, "vault_move").handler({
					path: "notes/hello.md",
					to: "archive",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.fileManager.renameFile).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				"archive/hello.md",
			);
		});
	});

	describe("vault_delete", () => {
		it("trashes file", async () => {
			const r = getResult(
				await getTool(tools, "vault_delete").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.trash).toHaveBeenCalledWith(
				expect.objectContaining({ path: "notes/hello.md" }),
				true,
			);
		});
	});

	describe("vault_create_folder", () => {
		it("creates folder", async () => {
			const r = getResult(
				await getTool(tools, "vault_create_folder").handler({ path: "new-folder" }),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.createFolder).toHaveBeenCalledWith("new-folder");
		});
	});
});
