/**
 * Shared test fixtures for MCP tool tests. Replaces the near-identical
 * `makeTFile` / `createMockApp` / `getTool` helpers that used to live in each
 * test file. Per-test divergence (read body, cache contents, etc.) is handled
 * via the `opts` overrides on `createMockApp`.
 */

import type { TFile, TFolder } from "obsidian";
import { vi } from "vitest";
import type { McpToolDef } from "../mcp-tools";

export function makeTFile(path: string, content = ""): TFile {
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

export interface MockAppOptions {
	/** Per-path metadata cache entries. */
	caches?: Record<string, unknown>;
	/** Cache returned when no per-path entry is set; defaults to null. */
	defaultCache?: unknown;
	/**
	 * Body returned by `read` / `cachedRead`. String, or a function of the
	 * file. Defaults to `` `content of ${f.path}` ``.
	 */
	readBody?: string | ((f: TFile) => string);
}

export function createMockApp(files: TFile[] = [], opts: MockAppOptions = {}) {
	const readImpl = async (f: TFile): Promise<string> => {
		if (typeof opts.readBody === "function") return opts.readBody(f);
		if (typeof opts.readBody === "string") return opts.readBody;
		return `content of ${f.path}`;
	};
	const caches = opts.caches ?? {};
	const defaultCache = opts.defaultCache ?? null;
	return {
		vault: {
			getFiles: vi.fn(() => files),
			getMarkdownFiles: vi.fn(() => files.filter((f) => f.extension === "md")),
			getFileByPath: vi.fn((p: string) => files.find((f) => f.path === p) ?? null),
			read: vi.fn(readImpl),
			cachedRead: vi.fn(readImpl),
			create: vi.fn(async (path: string, content = "") => makeTFile(path, content)),
			modify: vi.fn(async () => {}),
			append: vi.fn(async () => {}),
			trash: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
		},
		metadataCache: {
			getFileCache: vi.fn((f: TFile) => caches[f.path] ?? defaultCache),
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
}

export function getTool(tools: McpToolDef[], name: string): McpToolDef {
	const tool = tools.find((t) => t.name === name);
	if (!tool) throw new Error(`Tool ${name} not found`);
	return tool;
}
