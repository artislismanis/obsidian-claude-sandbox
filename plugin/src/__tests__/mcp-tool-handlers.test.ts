import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TFile } from "obsidian";

vi.mock("obsidian", () => ({
	prepareSimpleSearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	prepareFuzzySearch: vi.fn(() => () => ({ score: 1, matches: [[0, 5]] })),
	FileSystemAdapter: class {},
}));

import { buildTools } from "../mcp-tools";
import type { McpToolDef } from "../mcp-tools";
import { makeTFile, createMockApp, getTool } from "./fixtures";

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
		app = createMockApp(testFiles, { caches });
		app.metadataCache.resolvedLinks = {
			"notes/hello.md": { "notes/world.md": 2 },
			"notes/world.md": {},
		};
		app.metadataCache.unresolvedLinks = {
			"notes/hello.md": { nonexistent: 1 },
		};
		tools = buildTools({
			app: app as never,
			getWriteDir: () => "agent-workspace",
			review: async () => ({ approved: true }),
		});
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
			expect(names).toContain("vault_frontmatter_delete");
			expect(names).toContain("vault_search_replace");
			expect(names).toContain("vault_prepend");
			expect(names).toContain("vault_patch");
			expect(names).toContain("vault_create_anywhere");
			expect(names).toContain("vault_frontmatter_delete_anywhere");
			expect(names).toContain("vault_search_replace_anywhere");
			expect(names).toContain("vault_prepend_anywhere");
			expect(names).toContain("vault_patch_anywhere");
			expect(names).toContain("vault_recent");
			expect(names).toContain("vault_properties");
			expect(names).toContain("vault_graph_neighborhood");
			expect(names).toContain("vault_graph_path");
			expect(names).toContain("vault_graph_clusters");
			expect(names).toContain("vault_open");
			expect(names).toContain("vault_rename");
			expect(names).toContain("vault_move");
			expect(names).toContain("vault_delete");
			expect(names).toContain("vault_create_folder");
			expect(names).toContain("vault_context");
			expect(names).toContain("vault_suggest_links");
			expect(names).toContain("vault_batch_frontmatter");
			expect(names).toContain("vault_create_reviewed");
			expect(names).toContain("vault_modify_reviewed");
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

	describe("vault_create + Templater folder templates", () => {
		interface FolderTemplate {
			folder?: string;
			template?: string;
		}
		function installTemplater(opts: {
			enabled?: boolean;
			folderTemplates?: FolderTemplate[];
			templateFiles?: TFile[];
			writeImpl?: (tpl: TFile, target: TFile) => Promise<void>;
			triggerOnFileCreation?: boolean;
		}): {
			write: ReturnType<typeof vi.fn>;
			settings: {
				enable_folder_templates: boolean;
				trigger_on_file_creation: boolean;
				folder_templates: FolderTemplate[];
			};
		} {
			const write = vi.fn(opts.writeImpl ?? (async () => {}));
			const settings = {
				enable_folder_templates: opts.enabled ?? true,
				trigger_on_file_creation: opts.triggerOnFileCreation ?? true,
				folder_templates: opts.folderTemplates ?? [],
			};
			(app as unknown as { plugins: unknown }).plugins = {
				plugins: {
					"templater-obsidian": {
						settings,
						templater: { write_template_to_file: write },
					},
				},
			};
			// Make any template files resolvable via getFileByPath.
			const original = app.vault.getFileByPath.getMockImplementation();
			app.vault.getFileByPath = vi.fn((path: string) => {
				const tpl = (opts.templateFiles ?? []).find((f) => f.path === path);
				return tpl ?? (original ? original(path) : null);
			}) as never;
			return { write, settings };
		}

		it("no-op when Templater is not installed", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Created agent-workspace/n.md");
			expect(app.vault.create).toHaveBeenCalledWith("agent-workspace/n.md", "");
		});

		it("no-op when folder templates are disabled", async () => {
			const tplFile = makeTFile("Templates/Default.md");
			const { write } = installTemplater({
				enabled: false,
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Default.md" }],
				templateFiles: [tplFile],
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(write).not.toHaveBeenCalled();
		});

		it("applies the matching folder template and reports it in the success message", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: "agent-workspace/2026-05-06.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0][0].path).toBe("Templates/Daily.md");
			expect(write.mock.calls[0][1].path).toBe("agent-workspace/2026-05-06.md");
			expect(r.text).toContain("applied template Templates/Daily.md");
		});

		it("longest-prefix folder match wins", async () => {
			const root = makeTFile("Templates/Root.md");
			const nested = makeTFile("Templates/Nested.md");
			const { write } = installTemplater({
				folderTemplates: [
					{ folder: "/", template: "Templates/Root.md" },
					{ folder: "agent-workspace", template: "Templates/Nested.md" },
				],
				templateFiles: [root, nested],
			});
			await getTool(tools, "vault_create").handler({ path: "agent-workspace/sub/n.md" });
			expect(write).toHaveBeenCalledTimes(1);
			expect(write.mock.calls[0][0].path).toBe("Templates/Nested.md");
		});

		it("does not apply a template when the agent supplied content", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			await getTool(tools, "vault_create").handler({
				path: "agent-workspace/n.md",
				content: "agent wrote this",
			});
			expect(write).not.toHaveBeenCalled();
			expect(app.vault.create).toHaveBeenCalledWith(
				"agent-workspace/n.md",
				"agent wrote this",
			);
		});

		it("does not apply a template to non-markdown files", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			await getTool(tools, "vault_create").handler({ path: "agent-workspace/data.json" });
			expect(write).not.toHaveBeenCalled();
		});

		it("no-op when no folder template matches the target path", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			const { write } = installTemplater({
				folderTemplates: [{ folder: "elsewhere", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Created agent-workspace/n.md");
			expect(write).not.toHaveBeenCalled();
		});

		it("suppresses the create-hook during apply and restores it afterwards", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			let observedDuringCreate: boolean | undefined;
			const { settings } = installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
				triggerOnFileCreation: true,
			});
			(app.vault.create as ReturnType<typeof vi.fn>).mockImplementationOnce(
				async (path: string) => {
					observedDuringCreate = settings.trigger_on_file_creation;
					return makeTFile(path);
				},
			);
			await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" });
			expect(observedDuringCreate).toBe(false);
			expect(settings.trigger_on_file_creation).toBe(true);
		});

		it("surfaces a plain create message when write_template_to_file throws", async () => {
			const tplFile = makeTFile("Templates/Daily.md");
			installTemplater({
				folderTemplates: [{ folder: "agent-workspace", template: "Templates/Daily.md" }],
				templateFiles: [tplFile],
				writeImpl: async () => {
					throw new Error("boom");
				},
			});
			const r = getResult(
				await getTool(tools, "vault_create").handler({ path: "agent-workspace/n.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toBe("Created agent-workspace/n.md");
			expect(app.vault.create).toHaveBeenCalledWith("agent-workspace/n.md", "");
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

	describe("vault_recent", () => {
		it("returns files sorted by mtime", async () => {
			const r = getResult(await getTool(tools, "vault_recent").handler({ limit: 2 }));
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/hello.md");
		});
	});

	describe("vault_properties", () => {
		it("lists all property keys with counts", async () => {
			const r = getResult(await getTool(tools, "vault_properties").handler({}));
			expect(r.isError).toBe(false);
			expect(r.text).toContain("title:");
			expect(r.text).toContain("status:");
		});

		it("lists distinct values for a specific property", async () => {
			const r = getResult(
				await getTool(tools, "vault_properties").handler({ property: "title" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain('"Hello"');
		});
	});

	describe("vault_graph_neighborhood", () => {
		it("returns 1-hop neighbors", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_neighborhood").handler({
					path: "notes/hello.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/world.md");
		});

		it("returns empty for disconnected node", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_neighborhood").handler({
					path: "config.json",
				}),
			);
			expect(r.text).toContain("no linked notes");
		});
	});

	describe("vault_graph_path", () => {
		it("finds direct path", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_path").handler({
					source: "notes/hello.md",
					target: "notes/world.md",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("hello.md");
			expect(r.text).toContain("world.md");
			expect(r.text).toContain("→");
		});

		it("returns no path for disconnected nodes", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_path").handler({
					source: "notes/hello.md",
					target: "config.json",
				}),
			);
			expect(r.text).toContain("No path found");
		});
	});

	describe("vault_graph_clusters", () => {
		it("finds connected components", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_clusters").handler({ minSize: 2 }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("Cluster 1");
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("notes/world.md");
		});

		it("returns empty when no clusters meet minSize", async () => {
			const r = getResult(
				await getTool(tools, "vault_graph_clusters").handler({ minSize: 100 }),
			);
			expect(r.text).toContain("no clusters");
		});
	});

	describe("vault_context", () => {
		it("returns combined context for a file", async () => {
			const r = getResult(
				await getTool(tools, "vault_context").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("notes/hello.md");
			expect(r.text).toContain("Frontmatter");
			expect(r.text).toContain("Content");
			expect(r.text).toContain("content of notes/hello.md");
		});
	});

	describe("vault_suggest_links", () => {
		it("returns suggestions excluding already-linked files", async () => {
			app.vault.cachedRead.mockResolvedValue("hello world notes");
			const r = getResult(
				await getTool(tools, "vault_suggest_links").handler({ path: "notes/hello.md" }),
			);
			expect(r.isError).toBe(false);
		});
	});

	describe("vault_batch_frontmatter", () => {
		it("dry run lists matching files", async () => {
			const r = getResult(
				await getTool(tools, "vault_batch_frontmatter").handler({
					query: "content",
					property: "reviewed",
					value: "true",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("Dry run");
		});
	});

	describe("vault_frontmatter_delete", () => {
		it("deletes existing property", async () => {
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatter: { title: "Hello", status: "active", position: {} },
			});
			const r = getResult(
				await getTool(tools, "vault_frontmatter_delete").handler({
					path: "agent-workspace/draft.md",
					property: "status",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("Deleted status");
		});

		it("errors on missing property", async () => {
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatter: { title: "Hello" },
			});
			const r = getResult(
				await getTool(tools, "vault_frontmatter_delete").handler({
					path: "agent-workspace/draft.md",
					property: "nonexistent",
				}),
			);
			expect(r.isError).toBe(true);
		});
	});

	describe("vault_search_replace", () => {
		it("replaces literal text", async () => {
			app.vault.read.mockResolvedValueOnce("hello world hello");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "hello",
					replace: "hi",
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("2 occurrence(s)");
			expect(app.vault.modify).toHaveBeenCalledWith(expect.anything(), "hi world hi");
		});

		it("replaces with regex", async () => {
			app.vault.read.mockResolvedValueOnce("foo123 bar456");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "([a-z]+)(\\d+)",
					replace: "$2-$1",
					regex: true,
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(expect.anything(), "123-foo 456-bar");
		});

		it("case-insensitive match", async () => {
			app.vault.read.mockResolvedValueOnce("Hello HELLO hello");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "hello",
					replace: "hi",
					caseSensitive: false,
				}),
			);
			expect(r.isError).toBe(false);
			expect(r.text).toContain("3 occurrence(s)");
		});

		it("errors on invalid regex", async () => {
			app.vault.read.mockResolvedValueOnce("test");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "[invalid",
					replace: "x",
					regex: true,
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("Invalid regex");
		});

		it("errors when no matches found", async () => {
			app.vault.read.mockResolvedValueOnce("nothing here");
			const r = getResult(
				await getTool(tools, "vault_search_replace").handler({
					path: "agent-workspace/draft.md",
					search: "missing",
					replace: "x",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("No matches");
		});
	});

	describe("vault_prepend", () => {
		it("prepends to file without frontmatter", async () => {
			app.vault.read.mockResolvedValueOnce("existing content");
			app.metadataCache.getFileCache.mockReturnValueOnce(null);
			const r = getResult(
				await getTool(tools, "vault_prepend").handler({
					path: "agent-workspace/draft.md",
					content: "NEW LINE",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"NEW LINE\nexisting content",
			);
		});

		it("prepends after frontmatter", async () => {
			app.vault.read.mockResolvedValueOnce("---\ntitle: Test\n---\nbody");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				frontmatterPosition: { start: { line: 0 }, end: { line: 2 } },
			});
			const r = getResult(
				await getTool(tools, "vault_prepend").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toContain("---\ntitle: Test\n---\nINSERTED\nbody");
		});
	});

	describe("vault_patch", () => {
		it("inserts after a specific line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2\nline3");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
					line: 2,
					position: "after",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"line1\nline2\nINSERTED\nline3",
			);
		});

		it("inserts before a specific line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2\nline3");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "INSERTED",
					line: 2,
					position: "before",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"line1\nINSERTED\nline2\nline3",
			);
		});

		it("replaces a specific line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2\nline3");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "REPLACED",
					line: 2,
					position: "replace",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.modify).toHaveBeenCalledWith(
				expect.anything(),
				"line1\nREPLACED\nline3",
			);
		});

		it("errors when no target specified", async () => {
			app.vault.read.mockResolvedValueOnce("test");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("heading");
		});

		it("errors on out-of-range line", async () => {
			app.vault.read.mockResolvedValueOnce("line1\nline2");
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					line: 99,
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("out of range");
		});

		it("inserts after heading", async () => {
			app.vault.read.mockResolvedValueOnce("# Title\nIntro\n## Details\nBody\n## Next");
			app.metadataCache.getFileCache.mockReturnValueOnce({
				headings: [
					{ heading: "Title", level: 1, position: { start: { line: 0 } } },
					{ heading: "Details", level: 2, position: { start: { line: 2 } } },
					{ heading: "Next", level: 2, position: { start: { line: 4 } } },
				],
			});
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "ADDED",
					heading: "## Details",
					position: "after",
				}),
			);
			expect(r.isError).toBe(false);
			const modified = (app.vault.modify.mock.calls[0] as unknown[])[1] as string;
			expect(modified).toContain("Body\nADDED\n## Next");
		});

		it("errors on nonexistent heading", async () => {
			app.vault.read.mockResolvedValueOnce("no headings");
			app.metadataCache.getFileCache.mockReturnValueOnce({ headings: [] });
			const r = getResult(
				await getTool(tools, "vault_patch").handler({
					path: "agent-workspace/draft.md",
					content: "x",
					heading: "Missing",
				}),
			);
			expect(r.isError).toBe(true);
			expect(r.text).toContain("not found");
		});
	});

	describe("vault_search chunked early-exit", () => {
		it("stops reading once limit is reached and never returns more than limit", async () => {
			const manyFiles = Array.from({ length: 100 }, (_, i) => makeTFile(`notes/f${i}.md`));
			const localApp = createMockApp(manyFiles, {});
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
			});
			const r = getResult(
				await getTool(localTools, "vault_search").handler({ query: "x", limit: 5 }),
			);
			expect(r.isError).toBe(false);
			expect(r.text.split("\n")).toHaveLength(5);
			// chunk size is 20 — with limit 5 every file matches (mocked), so
			// one chunk is enough. We should not have read the full 100.
			expect(localApp.vault.cachedRead.mock.calls.length).toBeLessThanOrEqual(20);
		});
	});

	describe("writeScoped out-of-scope fast-fail", () => {
		const outOfScopePath = "notes/hello.md";
		const inScopePath = "agent-workspace/draft.md";
		const writeDir = "agent-workspace";

		it("vault_create rejects a path outside the write directory synchronously", async () => {
			const t0 = Date.now();
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: outOfScopePath,
					content: "x",
				}),
			);
			expect(Date.now() - t0).toBeLessThan(50);
			expect(r.isError).toBe(true);
			expect(r.text).toContain(writeDir);
			expect(app.vault.create).not.toHaveBeenCalled();
		});

		it.each([
			["vault_modify", { content: "x" }],
			["vault_append", { content: "x" }],
			["vault_prepend", { content: "x" }],
			["vault_search_replace", { search: "a", replace: "b" }],
			["vault_frontmatter_set", { property: "k", value: '"v"' }],
			["vault_frontmatter_delete", { property: "k" }],
			["vault_patch", { content: "x", heading: "Introduction" }],
		])("%s rejects a path outside the write directory", async (name, extra) => {
			const t0 = Date.now();
			const r = getResult(
				await getTool(tools, name).handler({ path: outOfScopePath, ...extra }),
			);
			expect(Date.now() - t0).toBeLessThan(50);
			expect(r.isError).toBe(true);
			expect(r.text).toContain(writeDir);
		});

		it("vault_create accepts a path within the write directory", async () => {
			const r = getResult(
				await getTool(tools, "vault_create").handler({
					path: `${inScopePath}.new`,
					content: "x",
				}),
			);
			expect(r.isError).toBe(false);
			expect(app.vault.create).toHaveBeenCalled();
		});

		it("writeScoped tool descriptions name the active write directory", () => {
			const createTool = getTool(tools, "vault_create");
			expect(createTool.config.description).toContain(writeDir);
		});
	});

	describe("tier filtering contract", () => {
		it("only builds tools registered across tiers; filtering is the server's job", () => {
			// buildTools does not filter — verify writeVault/manage/reviewed variants exist
			// in the raw list. The server filter at mcp-server.ts:210 is what gates them.
			const names = tools.map((t) => t.name);
			expect(names).toContain("vault_create");
			expect(names).toContain("vault_create_anywhere");
			expect(names).toContain("vault_create_reviewed");
			expect(names).toContain("vault_rename");
			expect(names).toContain("vault_delete");
		});

		it("reviewed variants are absent when no reviewFn is provided", () => {
			const localApp = createMockApp(testFiles, { caches });
			const localTools = buildTools({
				app: localApp as never,
				getWriteDir: () => "agent-workspace",
			});
			const names = localTools.map((t) => t.name);
			expect(names).not.toContain("vault_create_reviewed");
			expect(names).not.toContain("vault_modify_reviewed");
		});
	});
});
