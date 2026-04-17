import type { App, TFile, CachedMetadata } from "obsidian";
import { prepareSimpleSearch } from "obsidian";
import { z } from "zod/v4";
import { isPathWithinDir } from "./validation";

export type PermissionTier = "read" | "writeScoped" | "writeVault" | "navigate" | "manage";

export interface McpToolDef {
	name: string;
	tier: PermissionTier;
	config: {
		title: string;
		description: string;
		inputSchema?: Record<string, z.ZodType>;
	};
	handler: (args: Record<string, unknown>) => Promise<McpToolResult>;
}

interface McpToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

function text(str: string): McpToolResult {
	return { content: [{ type: "text", text: str }] };
}

function error(msg: string): McpToolResult {
	return { content: [{ type: "text", text: msg }], isError: true };
}

function fileToInfo(file: TFile): string {
	return [
		`path: ${file.path}`,
		`name: ${file.basename}`,
		`extension: ${file.extension}`,
		`size: ${file.stat.size}`,
		`created: ${file.stat.ctime}`,
		`modified: ${file.stat.mtime}`,
	].join("\n");
}

function formatTags(cache: CachedMetadata | null): string[] {
	if (!cache) return [];
	const tags: string[] = [];
	if (cache.tags) {
		for (const t of cache.tags) tags.push(t.tag);
	}
	if (cache.frontmatter?.tags) {
		const fm = cache.frontmatter.tags;
		if (Array.isArray(fm)) {
			for (const t of fm)
				tags.push(typeof t === "string" && !t.startsWith("#") ? `#${t}` : String(t));
		}
	}
	return [...new Set(tags)];
}

function resolveFile(app: App, args: Record<string, unknown>): TFile | null {
	const path = args.path as string | undefined;
	const file = args.file as string | undefined;
	if (path) return app.vault.getFileByPath(path) ?? null;
	if (file) {
		const resolved = app.metadataCache.getFirstLinkpathDest(file, "");
		return resolved ?? null;
	}
	return null;
}

export function buildTools(app: App, getWriteDir: () => string): McpToolDef[] {
	const tools: McpToolDef[] = [];

	// ── Read tier ─────────────────────────────────────

	tools.push({
		name: "vault_read",
		tier: "read",
		config: {
			title: "Read file",
			description: "Read the contents of a file in the vault.",
			inputSchema: {
				file: z.string().optional().describe("File name (wikilink-style resolution)"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const content = await app.vault.read(f);
			return text(content);
		},
	});

	tools.push({
		name: "vault_list",
		tier: "read",
		config: {
			title: "List files",
			description: "List files in the vault. Optionally filter by folder or extension.",
			inputSchema: {
				folder: z.string().optional().describe("Filter by folder path"),
				extension: z.string().optional().describe("Filter by extension (e.g. md, json)"),
			},
		},
		handler: async (args) => {
			let files = app.vault.getFiles();
			const folder = args.folder as string | undefined;
			const ext = args.extension as string | undefined;
			if (folder)
				files = files.filter(
					(f) => f.path.startsWith(folder + "/") || f.path.startsWith(folder),
				);
			if (ext) files = files.filter((f) => f.extension === ext);
			return text(files.map((f) => f.path).join("\n") || "(no files)");
		},
	});

	tools.push({
		name: "vault_search",
		tier: "read",
		config: {
			title: "Search vault",
			description:
				"Search for text across all markdown files in the vault. Returns matching file paths with context.",
			inputSchema: {
				query: z.string().describe("Search query text"),
				limit: z.number().optional().describe("Max results (default 20)"),
			},
		},
		handler: async (args) => {
			const query = args.query as string;
			const limit = (args.limit as number | undefined) ?? 20;
			const search = prepareSimpleSearch(query);
			const results: string[] = [];
			for (const file of app.vault.getMarkdownFiles()) {
				if (results.length >= limit) break;
				const content = await app.vault.cachedRead(file);
				const match = search(content);
				if (match) {
					const firstOffset = match.matches[0]?.[0] ?? 0;
					const start = Math.max(0, firstOffset - 60);
					const end = Math.min(content.length, firstOffset + 120);
					const snippet = content.slice(start, end).replace(/\n/g, " ");
					results.push(`${file.path}: ...${snippet}...`);
				}
			}
			return text(results.join("\n") || "No matches found.");
		},
	});

	tools.push({
		name: "vault_file_info",
		tier: "read",
		config: {
			title: "File info",
			description: "Get metadata about a file (path, name, size, dates).",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			return text(fileToInfo(f));
		},
	});

	tools.push({
		name: "vault_tags",
		tier: "read",
		config: {
			title: "List tags",
			description:
				"List all tags in the vault with occurrence counts, or tags for a specific file.",
			inputSchema: {
				file: z.string().optional().describe("File name (omit for vault-wide)"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (f) {
				const cache = app.metadataCache.getFileCache(f);
				const tags = formatTags(cache);
				return text(tags.join("\n") || "(no tags)");
			}
			const tagCounts: Record<string, number> = {};
			for (const file of app.vault.getMarkdownFiles()) {
				const cache = app.metadataCache.getFileCache(file);
				for (const tag of formatTags(cache)) {
					tagCounts[tag] = (tagCounts[tag] ?? 0) + 1;
				}
			}
			const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
			return text(sorted.map(([tag, count]) => `${tag}: ${count}`).join("\n") || "(no tags)");
		},
	});

	tools.push({
		name: "vault_frontmatter",
		tier: "read",
		config: {
			title: "Read frontmatter",
			description: "Read YAML frontmatter properties from a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				property: z.string().optional().describe("Specific property to read"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const cache = app.metadataCache.getFileCache(f);
			const fm = cache?.frontmatter;
			if (!fm) return text("(no frontmatter)");
			const prop = args.property as string | undefined;
			if (prop) {
				const val = fm[prop];
				return text(
					val !== undefined ? JSON.stringify(val) : `(property '${prop}' not found)`,
				);
			}
			const filtered = Object.fromEntries(
				Object.entries(fm).filter(([k]) => k !== "position"),
			);
			return text(JSON.stringify(filtered, null, 2));
		},
	});

	tools.push({
		name: "vault_links",
		tier: "read",
		config: {
			title: "Outgoing links",
			description: "List outgoing links from a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const resolved = app.metadataCache.resolvedLinks[f.path] ?? {};
			const entries = Object.entries(resolved).map(
				([target, count]) => `${target} (${count})`,
			);
			return text(entries.join("\n") || "(no outgoing links)");
		},
	});

	tools.push({
		name: "vault_backlinks",
		tier: "read",
		config: {
			title: "Backlinks",
			description: "List files that link to a given file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const backlinks: string[] = [];
			for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
				if (targets[f.path]) backlinks.push(source);
			}
			return text(backlinks.join("\n") || "(no backlinks)");
		},
	});

	tools.push({
		name: "vault_headings",
		tier: "read",
		config: {
			title: "Headings",
			description: "List headings from a file as an outline.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const cache = app.metadataCache.getFileCache(f);
			const headings = cache?.headings ?? [];
			const lines = headings.map((h) => `${"  ".repeat(h.level - 1)}${h.heading}`);
			return text(lines.join("\n") || "(no headings)");
		},
	});

	tools.push({
		name: "vault_orphans",
		tier: "read",
		config: {
			title: "Orphan notes",
			description: "List markdown files with no incoming links from other files.",
		},
		handler: async () => {
			const linkedTo = new Set<string>();
			for (const targets of Object.values(app.metadataCache.resolvedLinks)) {
				for (const target of Object.keys(targets)) linkedTo.add(target);
			}
			const orphans = app.vault.getMarkdownFiles().filter((f) => !linkedTo.has(f.path));
			return text(orphans.map((f) => f.path).join("\n") || "(no orphans)");
		},
	});

	tools.push({
		name: "vault_unresolved",
		tier: "read",
		config: {
			title: "Unresolved links",
			description: "List broken wikilinks that don't resolve to any file.",
		},
		handler: async () => {
			const entries: string[] = [];
			for (const [source, targets] of Object.entries(app.metadataCache.unresolvedLinks)) {
				for (const [target, count] of Object.entries(targets)) {
					entries.push(`${target} (from ${source}, ${count}x)`);
				}
			}
			return text(entries.join("\n") || "(no unresolved links)");
		},
	});

	// ── Write tools (scoped + vault-wide via factory) ────

	function addWriteTools(
		tier: PermissionTier,
		suffix: string,
		scopeLabel: string,
		guardPath: (path: string) => McpToolResult | null,
		resolveForWrite: (args: Record<string, unknown>) => TFile | McpToolResult,
	): void {
		tools.push({
			name: `vault_create${suffix}`,
			tier,
			config: {
				title: `Create file${scopeLabel}`,
				description: `Create a new file${scopeLabel}.`,
				inputSchema: {
					path: z.string().describe("Path from vault root"),
					content: z.string().optional().describe("Initial content (default empty)"),
				},
			},
			handler: async (args) => {
				const path = args.path as string;
				const guard = guardPath(path);
				if (guard) return guard;
				if (app.vault.getFileByPath(path))
					return error("File already exists. Use vault_modify to update it.");
				await app.vault.create(path, (args.content as string | undefined) ?? "");
				return text(`Created ${path}`);
			},
		});

		tools.push({
			name: `vault_modify${suffix}`,
			tier,
			config: {
				title: `Modify file${scopeLabel}`,
				description: `Replace the full contents of a file${scopeLabel}.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("New file content"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				await app.vault.modify(f, args.content as string);
				return text(`Modified ${f.path}`);
			},
		});

		tools.push({
			name: `vault_append${suffix}`,
			tier,
			config: {
				title: `Append to file${scopeLabel}`,
				description: `Append content to the end of a file${scopeLabel}.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to append"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				await app.vault.append(f, "\n" + (args.content as string));
				return text(`Appended to ${f.path}`);
			},
		});

		tools.push({
			name: `vault_frontmatter_set${suffix}`,
			tier,
			config: {
				title: `Set frontmatter${scopeLabel}`,
				description: `Set a YAML frontmatter property on a file${scopeLabel}.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name"),
					value: z.string().describe("Property value (JSON-encoded for objects/arrays)"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				const prop = args.property as string;
				const raw = args.value as string;
				let value: unknown;
				try {
					value = JSON.parse(raw);
				} catch {
					value = raw;
				}
				await app.fileManager.processFrontMatter(f, (fm) => {
					fm[prop] = value;
				});
				return text(`Set ${prop} on ${f.path}`);
			},
		});
	}

	addWriteTools(
		"writeScoped",
		"",
		" (within write directory)",
		(path) => {
			const writeDir = getWriteDir();
			return isPathWithinDir(path, writeDir)
				? null
				: error(`Path must be within the write directory '${writeDir}'.`);
		},
		(args) => {
			const path = args.path as string | undefined;
			if (path) {
				const writeDir = getWriteDir();
				if (!isPathWithinDir(path, writeDir))
					return error(`Path must be within the write directory '${writeDir}'.`);
			}
			const f = resolveFile(app, args);
			return f ?? error("File not found.");
		},
	);

	addWriteTools(
		"writeVault",
		"_anywhere",
		" (vault-wide)",
		() => null,
		(args) => resolveFile(app, args) ?? error("File not found."),
	);

	// ── Navigate tier ─────────────────────────────────

	tools.push({
		name: "vault_open",
		tier: "navigate",
		config: {
			title: "Open file",
			description: "Open a file in the Obsidian editor. Affects the user's UI.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				newTab: z.boolean().optional().describe("Open in a new tab"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const leaf = app.workspace.getLeaf(args.newTab ? "tab" : false);
			await leaf.openFile(f);
			return text(`Opened ${f.path}`);
		},
	});

	// ── Manage tier ───────────────────────────────────

	tools.push({
		name: "vault_rename",
		tier: "manage",
		config: {
			title: "Rename file",
			description: "Rename a file. Automatically updates all wikilinks across the vault.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				name: z.string().describe("New file name (extension preserved if omitted)"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const newName = args.name as string;
			const ext = newName.includes(".") ? "" : `.${f.extension}`;
			const dir = f.parent?.path ?? "";
			const newPath = dir ? `${dir}/${newName}${ext}` : `${newName}${ext}`;
			await app.fileManager.renameFile(f, newPath);
			return text(`Renamed to ${newPath}`);
		},
	});

	tools.push({
		name: "vault_move",
		tier: "manage",
		config: {
			title: "Move file",
			description: "Move a file to a different folder. Automatically updates all wikilinks.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				to: z.string().describe("Destination folder path"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			const dest = args.to as string;
			const newPath = `${dest}/${f.name}`;
			await app.fileManager.renameFile(f, newPath);
			return text(`Moved to ${newPath}`);
		},
	});

	tools.push({
		name: "vault_delete",
		tier: "manage",
		config: {
			title: "Delete file",
			description: "Move a file to trash.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args);
			if (!f) return error("File not found.");
			await app.vault.trash(f, true);
			return text(`Deleted ${f.path}`);
		},
	});

	tools.push({
		name: "vault_create_folder",
		tier: "manage",
		config: {
			title: "Create folder",
			description: "Create a new folder in the vault.",
			inputSchema: {
				path: z.string().describe("Folder path from vault root"),
			},
		},
		handler: async (args) => {
			const path = args.path as string;
			await app.vault.createFolder(path);
			return text(`Created folder ${path}`);
		},
	});

	return tools;
}
