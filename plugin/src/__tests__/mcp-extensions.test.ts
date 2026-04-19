import { describe, it, expect, vi } from "vitest";
import type { TFile } from "obsidian";

vi.mock("obsidian", () => {
	class TFile {}
	return {
		prepareSimpleSearch: vi.fn(() => () => null),
		prepareFuzzySearch: vi.fn(() => () => null),
		FileSystemAdapter: class {},
		TFile,
	};
});

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

describe("Dataview integration", () => {
	const initial = JSON.stringify({ nodes: [], edges: [] });

	function appWithDataview(query: (s: string) => unknown) {
		const { app } = mockApp(initial);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => (id === "dataview" ? { api: { query } } : null),
			enabledPlugins: new Set(["dataview"]),
		};
		return app;
	}

	it("is absent when Dataview is not installed", () => {
		const { app } = mockApp(initial);
		const tools = buildTools(app as never, () => "agent-workspace");
		expect(tools.find((t) => t.name === "vault_dataview_query")).toBeUndefined();
	});

	it("is absent when Dataview is installed but disabled", () => {
		const { app } = mockApp(initial);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) => (id === "dataview" ? { api: { query: () => null } } : null),
			enabledPlugins: new Set(), // not enabled
		};
		const tools = buildTools(app as never, () => "agent-workspace");
		expect(tools.find((t) => t.name === "vault_dataview_query")).toBeUndefined();
	});

	it("registers + returns serialized query value on success", async () => {
		const app = appWithDataview(() => ({
			successful: true,
			value: { headers: ["file"], values: [["a.md"]] },
		}));
		const tools = buildTools(app as never, () => "agent-workspace");
		const tool = getTool(tools, "vault_dataview_query");
		expect(tool.tier).toBe("extensions");
		const result = await tool.handler({ query: "TABLE FROM #x" });
		expect(result.isError ?? false).toBe(false);
		const body = JSON.parse((result.content[0] as { text: string }).text);
		expect(body).toEqual({ headers: ["file"], values: [["a.md"]] });
	});

	it("surfaces Dataview failure as error result", async () => {
		const app = appWithDataview(() => ({ successful: false, error: "parse error" }));
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_dataview_query").handler({
			query: "GARBAGE",
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("parse error");
	});

	it("surfaces thrown exceptions as error result", async () => {
		const app = appWithDataview(() => {
			throw new Error("boom");
		});
		const tools = buildTools(app as never, () => "agent-workspace");
		const result = await getTool(tools, "vault_dataview_query").handler({
			query: "TABLE",
		});
		expect(result.isError).toBe(true);
		expect((result.content[0] as { text: string }).text).toContain("boom");
	});
});

describe("Tasks integration", () => {
	function mdFile(path: string): TFile {
		return {
			path,
			name: path.split("/").pop(),
			basename: path.replace(/\.md$/, "").split("/").pop(),
			extension: "md",
			stat: { ctime: 1, mtime: 2, size: 100 },
			vault: {} as never,
			parent: null as never,
		} as unknown as TFile;
	}

	function appWithTasks(opts: {
		files: Record<string, string>;
		toggle?: (line: string, path: string) => string;
	}) {
		const files = Object.keys(opts.files).map(mdFile);
		const modify = vi.fn(async () => {});
		const app = {
			vault: {
				getFiles: vi.fn(() => files),
				getMarkdownFiles: vi.fn(() => files),
				getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
				read: vi.fn(async (f: TFile) => opts.files[f.path]),
				cachedRead: vi.fn(async (f: TFile) => opts.files[f.path]),
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
			plugins: {
				getPlugin: (id: string) =>
					id === "obsidian-tasks-plugin"
						? { apiV1: { executeToggleTaskDoneCommand: opts.toggle } }
						: null,
				enabledPlugins: new Set(["obsidian-tasks-plugin"]),
			},
		};
		return { app, modify };
	}

	it("is absent when Tasks plugin is not installed", () => {
		const { app } = mockApp("{}");
		const tools = buildTools(app as never, () => "agent-workspace");
		expect(tools.find((t) => t.name === "vault_tasks_query")).toBeUndefined();
		expect(tools.find((t) => t.name === "vault_tasks_toggle")).toBeUndefined();
	});

	it("vault_tasks_query returns only open items by default", async () => {
		const { app } = appWithTasks({
			files: {
				"notes.md": "- [ ] open task\n- [x] done task\n- plain bullet",
			},
		});
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_tasks_query").handler({});
		const body = (r.content[0] as { text: string }).text;
		expect(body).toContain("open task");
		expect(body).not.toContain("done task");
	});

	it("vault_tasks_query filters by tag, due date, and priority", async () => {
		const { app } = appWithTasks({
			files: {
				"x.md":
					"- [ ] A 📅 2026-04-15 #work\n" +
					"- [ ] B 📅 2026-04-20 #home\n" +
					"- [ ] C ⏫ #work\n",
			},
		});
		const tools = buildTools(app as never, () => "agent-workspace");
		const byTag = await getTool(tools, "vault_tasks_query").handler({ tag: "#work" });
		expect((byTag.content[0] as { text: string }).text).toMatch(/A/);
		expect((byTag.content[0] as { text: string }).text).not.toMatch(/ B /);
		const byDue = await getTool(tools, "vault_tasks_query").handler({
			dueOnOrBefore: "2026-04-16",
		});
		expect((byDue.content[0] as { text: string }).text).toMatch(/A/);
		expect((byDue.content[0] as { text: string }).text).not.toMatch(/ B /);
		const byPri = await getTool(tools, "vault_tasks_query").handler({
			priorityAtLeast: "high",
		});
		expect((byPri.content[0] as { text: string }).text).toMatch(/C/);
		expect((byPri.content[0] as { text: string }).text).not.toMatch(/A/);
	});

	it("vault_tasks_toggle delegates to apiV1 and writes updated content", async () => {
		const toggle = vi.fn((line: string) => line.replace("[ ]", "[x]"));
		const { app, modify } = appWithTasks({
			files: { "t.md": "header\n- [ ] thing\n" },
			toggle,
		});
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_tasks_toggle").handler({
			path: "t.md",
			line: 2,
		});
		expect(r.isError ?? false).toBe(false);
		expect(toggle).toHaveBeenCalledTimes(1);
		const written = (modify.mock.calls[0] as unknown as [TFile, string])[1];
		expect(written).toContain("- [x] thing");
	});

	it("vault_tasks_toggle rejects a non-task line", async () => {
		const toggle = vi.fn((line: string) => line);
		const { app } = appWithTasks({
			files: { "t.md": "just a header\n" },
			toggle,
		});
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_tasks_toggle").handler({
			path: "t.md",
			line: 1,
		});
		expect(r.isError).toBe(true);
		expect(toggle).not.toHaveBeenCalled();
	});
});

describe("Templater integration", () => {
	it("is absent when Templater is not installed", () => {
		const { app } = mockApp("{}");
		const tools = buildTools(app as never, () => "agent-workspace");
		expect(tools.find((t) => t.name === "vault_templater_create")).toBeUndefined();
	});

	it("resolves the template path to a TFile and delegates to create_new_note_from_template", async () => {
		const { app } = mockApp("{}");
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		const create = vi.fn(async () => ({ path: "notes/new.md" }) as TFile);
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? { templater: { create_new_note_from_template: create } }
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "Notes",
			filename: "2026-04-19",
		});
		expect(r.isError ?? false).toBe(false);
		expect(create).toHaveBeenCalledWith(templateFile, "Notes", "2026-04-19", false);
	});

	it("returns an error when the template path does not exist", async () => {
		const { app } = mockApp("{}");
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn(() => null);
		const create = vi.fn();
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? { templater: { create_new_note_from_template: create } }
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/missing.md",
		});
		expect(r.isError).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});
});

describe("Periodic Notes integration", () => {
	it("is absent when plugin isn't installed", () => {
		const { app } = mockApp("{}");
		const tools = buildTools(app as never, () => "agent-workspace");
		expect(tools.find((t) => t.name === "vault_periodic_note")).toBeUndefined();
	});

	it("formats the daily-note path and reports existence", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "periodic-notes"
					? {
							instance: {
								settings: {
									daily: { enabled: true, folder: "Daily", format: "YYYY-MM-DD" },
								},
							},
						}
					: null,
			enabledPlugins: new Set(["periodic-notes"]),
		};
		app.vault.getFileByPath = vi.fn((p: string) =>
			p === "Daily/2026-04-19.md" ? ({ path: p } as TFile) : null,
		);
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "daily",
			date: "2026-04-19",
		});
		expect(r.isError ?? false).toBe(false);
		expect((r.content[0] as { text: string }).text).toContain("Daily/2026-04-19.md");
	});

	it("returns not-found when create:false and file absent", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "periodic-notes"
					? {
							instance: {
								settings: {
									monthly: { enabled: true, folder: "M", format: "YYYY-MM" },
								},
							},
						}
					: null,
			enabledPlugins: new Set(["periodic-notes"]),
		};
		app.vault.getFileByPath = vi.fn((_p: string) => null);
		const tools = buildTools(app as never, () => "agent-workspace");
		const r = await getTool(tools, "vault_periodic_note").handler({
			periodicity: "monthly",
			date: "2026-04-19",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("M/2026-04.md");
	});
});

describe("Write gate — extensions tier boundary enforcement", () => {
	function appWithTemplater(createImpl: ReturnType<typeof vi.fn>) {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "templater-obsidian"
					? { templater: { create_new_note_from_template: createImpl } }
					: null,
			enabledPlugins: new Set(["templater-obsidian"]),
		};
		return app;
	}

	async function setupTemplaterApp() {
		const { TFile: TFileClass } = await import("obsidian");
		const templateFile = Object.assign(new (TFileClass as new () => object)(), {
			path: "Templates/daily.md",
			name: "daily.md",
			basename: "daily",
			extension: "md",
		}) as unknown as TFile;
		const create = vi.fn(async () => ({ path: "Out/note.md" }) as TFile);
		const app = appWithTemplater(create);
		(
			app.vault as unknown as { getAbstractFileByPath: (p: string) => unknown }
		).getAbstractFileByPath = vi.fn((p: string) =>
			p === "Templates/daily.md" ? templateFile : null,
		);
		return { app, create };
	}

	it("scoped-only mode rejects templater writes outside the write directory", async () => {
		const { app, create } = await setupTemplaterApp();
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "extensions"]),
		);
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect((r.content[0] as { text: string }).text).toContain("outside the write directory");
		expect(create).not.toHaveBeenCalled();
	});

	it("scoped-only mode allows templater writes inside the write directory", async () => {
		const { app, create } = await setupTemplaterApp();
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "extensions"]),
		);
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "agent-workspace/journal",
			filename: "x",
		});
		expect(r.isError ?? false).toBe(false);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("reviewed mode routes out-of-scope templater writes through review", async () => {
		const { app, create } = await setupTemplaterApp();
		const review = vi.fn(async () => ({ approved: true }));
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			review,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "writeReviewed", "extensions"]),
		);
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError ?? false).toBe(false);
		expect(review).toHaveBeenCalledTimes(1);
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("reviewed mode aborts when the user rejects", async () => {
		const { app, create } = await setupTemplaterApp();
		const review = vi.fn(async () => ({ approved: false }));
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			review,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "writeReviewed", "extensions"]),
		);
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError).toBe(true);
		expect(create).not.toHaveBeenCalled();
	});

	it("full vault-write mode allows templater writes anywhere without review", async () => {
		const { app, create } = await setupTemplaterApp();
		const review = vi.fn();
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			review,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "writeVault", "extensions"]),
		);
		const r = await getTool(tools, "vault_templater_create").handler({
			template: "Templates/daily.md",
			folder: "OtherFolder",
			filename: "x",
		});
		expect(r.isError ?? false).toBe(false);
		expect(review).not.toHaveBeenCalled();
		expect(create).toHaveBeenCalledTimes(1);
	});

	it("scoped-only mode rejects canvas writes outside the write directory", async () => {
		const initial = JSON.stringify({ nodes: [], edges: [] });
		const { app, modify } = mockApp(initial);
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "extensions"]),
		);
		const r = await getTool(tools, "vault_canvas_modify").handler({
			path: "board.canvas",
			changes: JSON.stringify({ addNodes: [{ id: "n2", type: "text" }] }),
		});
		expect(r.isError).toBe(true);
		expect(modify).not.toHaveBeenCalled();
	});

	it("scoped-only mode rejects vault_create_folder outside write directory", async () => {
		const { app } = mockApp("{}");
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "manage"]),
		);
		const r = await getTool(tools, "vault_create_folder").handler({
			path: "SomeOtherDir/subdir",
		});
		expect(r.isError).toBe(true);
		expect(app.vault.createFolder).not.toHaveBeenCalled();
	});

	it("scoped-only mode allows vault_create_folder inside write directory", async () => {
		const { app } = mockApp("{}");
		const tools = buildTools(
			app as never,
			() => "agent-workspace",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			new Set(["read", "writeScoped", "manage"]),
		);
		const r = await getTool(tools, "vault_create_folder").handler({
			path: "agent-workspace/newdir",
		});
		expect(r.isError ?? false).toBe(false);
		expect(app.vault.createFolder).toHaveBeenCalledWith("agent-workspace/newdir");
	});
});

describe("plugin_extensions_list", () => {
	it("reports native-canvas always + per-plugin detection", async () => {
		const { app } = mockApp("{}");
		(app as unknown as { plugins: unknown }).plugins = {
			getPlugin: (id: string) =>
				id === "dataview" ? { api: { query: () => ({ successful: true }) } } : null,
			enabledPlugins: new Set(["dataview"]),
		};
		const tools = buildTools(app as never, () => "agent-workspace");
		const tool = getTool(tools, "plugin_extensions_list");
		const r = await tool.handler({});
		const body = (r.content[0] as { text: string }).text;
		expect(body).toContain("canvas: always");
		expect(body).toContain("dataview: enabled");
		expect(body).toContain("tasks: not available");
	});
});
