import type { App, TFile, CachedMetadata } from "obsidian";
import { prepareSimpleSearch, prepareFuzzySearch } from "obsidian";
import { z } from "zod/v4";
import { isPathWithinDir, isPathAllowed, isRealPathWithinBase } from "./validation";
import { FileSystemAdapter } from "obsidian";
import type { WriteOperation } from "./diff-review-modal";
import { registerExtensionTools } from "./mcp-extensions";

export type { WriteOperation };

export type PermissionTier =
	| "read"
	| "writeScoped"
	| "writeReviewed"
	| "writeVault"
	| "navigate"
	| "manage"
	| "extensions"
	| "agent";

export type AgentStatus = "idle" | "working" | "awaiting_input";

export type OnActivity = (update: {
	sessionName: string;
	status: AgentStatus;
	detail?: string;
}) => void;

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

export interface PathFilter {
	allowlist: string[];
	blocklist: string[];
}

function resolveFile(
	app: App,
	args: Record<string, unknown>,
	pathFilter?: PathFilter,
): TFile | null {
	const path = args.path as string | undefined;
	const file = args.file as string | undefined;
	let resolved: TFile | null = null;
	if (path) resolved = app.vault.getFileByPath(path) ?? null;
	else if (file) resolved = app.metadataCache.getFirstLinkpathDest(file, "") ?? null;
	if (resolved && pathFilter) {
		if (!isPathAllowed(resolved.path, pathFilter.allowlist, pathFilter.blocklist)) return null;
	}
	if (resolved && !isVaultPathSafe(app, resolved.path)) return null;
	return resolved;
}

/** True when `vaultPath` resolves to a real filesystem path inside the vault base. */
function isVaultPathSafe(app: App, vaultPath: string): boolean {
	const adapter = app.vault.adapter;
	if (!(adapter instanceof FileSystemAdapter)) return true;
	return isRealPathWithinBase(adapter.getBasePath(), adapter.getFullPath(vaultPath));
}

export type ReviewFn = (request: {
	operation: WriteOperation;
	filePath: string;
	oldContent?: string;
	newContent?: string;
	description: string;
	affectedLinks?: string[];
}) => Promise<{ approved: boolean }>;

export type ReviewBatchFn = (request: {
	operation: WriteOperation;
	description: string;
	items: Array<{ filePath: string; oldContent?: string; newContent?: string }>;
}) => Promise<{ approved: boolean; approvedPaths: string[] }>;

export function buildTools(
	app: App,
	getWriteDir: () => string,
	pathFilter?: PathFilter,
	reviewFn?: ReviewFn,
	cache?: { get<T>(key: string, compute: () => T): T },
	reviewBatchFn?: ReviewBatchFn,
	onActivity?: OnActivity,
): McpToolDef[] {
	const tools: McpToolDef[] = [];

	/**
	 * Iterate the vault's markdown files in parallel chunks, short-circuiting
	 * when the handler returns `true`. Used by any tool that wants parallel
	 * cachedReads without loading the entire vault at once.
	 */
	async function forEachMarkdownChunked(
		handler: (file: TFile, content: string) => boolean | void | Promise<boolean | void>,
		files: TFile[] = app.vault.getMarkdownFiles(),
		chunkSize = 20,
	): Promise<void> {
		for (let i = 0; i < files.length; i += chunkSize) {
			const chunk = files.slice(i, i + chunkSize);
			const contents = await Promise.all(chunk.map((f) => app.vault.cachedRead(f)));
			for (let j = 0; j < chunk.length; j++) {
				const stop = await handler(chunk[j], contents[j]);
				if (stop) return;
			}
		}
	}

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
			const f = resolveFile(app, args, pathFilter);
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
			await forEachMarkdownChunked((file, content) => {
				const match = search(content);
				if (!match) return;
				const firstOffset = match.matches[0]?.[0] ?? 0;
				const start = Math.max(0, firstOffset - 60);
				const end = Math.min(content.length, firstOffset + 120);
				const snippet = content.slice(start, end).replace(/\n/g, " ");
				results.push(`${file.path}: ...${snippet}...`);
				return results.length >= limit;
			});
			return text(results.join("\n") || "No matches found.");
		},
	});

	tools.push({
		name: "vault_search_fuzzy",
		tier: "read",
		config: {
			title: "Fuzzy search vault",
			description:
				"Fuzzy full-text search across all markdown files — tolerates typos and approximate matches. Results are score-sorted.",
			inputSchema: {
				query: z.string().describe("Search query text (fuzzy matched)"),
				limit: z.number().optional().describe("Max results (default 20)"),
			},
		},
		handler: async (args) => {
			const query = args.query as string;
			const limit = (args.limit as number | undefined) ?? 20;
			const search = prepareFuzzySearch(query);
			const hits: { path: string; score: number; snippet: string }[] = [];
			await forEachMarkdownChunked((file, content) => {
				const match = search(content);
				if (!match) return;
				const firstOffset = match.matches[0]?.[0] ?? 0;
				const start = Math.max(0, firstOffset - 60);
				const end = Math.min(content.length, firstOffset + 120);
				const snippet = content.slice(start, end).replace(/\n/g, " ");
				hits.push({ path: file.path, score: match.score, snippet });
			});
			hits.sort((a, b) => b.score - a.score);
			const formatted = hits
				.slice(0, limit)
				.map((h) => `${h.path} (score ${h.score.toFixed(2)}): ...${h.snippet}...`);
			return text(formatted.join("\n") || "No matches found.");
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
			const f = resolveFile(app, args, pathFilter);
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
			const f = resolveFile(app, args, pathFilter);
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
			const f = resolveFile(app, args, pathFilter);
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
			const f = resolveFile(app, args, pathFilter);
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
			const f = resolveFile(app, args, pathFilter);
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
			const f = resolveFile(app, args, pathFilter);
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

	// ── Graph & knowledge tools (read tier) ──────────

	tools.push({
		name: "vault_recent",
		tier: "read",
		config: {
			title: "Recently modified files",
			description: "List recently modified files sorted by modification time.",
			inputSchema: {
				limit: z.number().optional().describe("Max results (default 20)"),
				folder: z.string().optional().describe("Filter by folder path"),
				extension: z.string().optional().describe("Filter by extension"),
			},
		},
		handler: async (args) => {
			const limit = (args.limit as number | undefined) ?? 20;
			let files = app.vault.getFiles();
			const folder = args.folder as string | undefined;
			const ext = args.extension as string | undefined;
			if (folder) files = files.filter((f) => f.path.startsWith(folder + "/"));
			if (ext) files = files.filter((f) => f.extension === ext);
			files.sort((a, b) => b.stat.mtime - a.stat.mtime);
			const results = files.slice(0, limit).map((f) => {
				const date = new Date(f.stat.mtime).toISOString();
				return `${date}  ${f.path}`;
			});
			return text(results.join("\n") || "(no files)");
		},
	});

	tools.push({
		name: "vault_properties",
		tier: "read",
		config: {
			title: "Vault properties",
			description:
				"List all frontmatter property names across the vault with usage counts, or distinct values for a specific property.",
			inputSchema: {
				property: z
					.string()
					.optional()
					.describe("Property name to get distinct values for"),
			},
		},
		handler: async (args) => {
			const prop = args.property as string | undefined;
			if (prop) {
				const values: Record<string, number> = {};
				for (const file of app.vault.getMarkdownFiles()) {
					const cache = app.metadataCache.getFileCache(file);
					const fm = cache?.frontmatter;
					if (fm && prop in fm) {
						const val = JSON.stringify(fm[prop]);
						values[val] = (values[val] ?? 0) + 1;
					}
				}
				const sorted = Object.entries(values).sort((a, b) => b[1] - a[1]);
				return text(
					sorted.map(([val, count]) => `${val}: ${count}`).join("\n") ||
						`(no files have property '${prop}')`,
				);
			}
			const counts: Record<string, number> = {};
			for (const file of app.vault.getMarkdownFiles()) {
				const cache = app.metadataCache.getFileCache(file);
				const fm = cache?.frontmatter;
				if (!fm) continue;
				for (const key of Object.keys(fm)) {
					if (key === "position") continue;
					counts[key] = (counts[key] ?? 0) + 1;
				}
			}
			const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1]);
			return text(
				sorted.map(([key, count]) => `${key}: ${count}`).join("\n") || "(no properties)",
			);
		},
	});

	interface LinkGraph {
		forward: Map<string, Set<string>>;
		reverse: Map<string, Set<string>>;
	}

	function computeLinkGraph(): LinkGraph {
		const forward = new Map<string, Set<string>>();
		const reverse = new Map<string, Set<string>>();
		for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
			if (!forward.has(source)) forward.set(source, new Set());
			for (const target of Object.keys(targets)) {
				forward.get(source)!.add(target);
				if (!reverse.has(target)) reverse.set(target, new Set());
				reverse.get(target)!.add(source);
			}
		}
		return { forward, reverse };
	}

	function buildLinkGraph(): LinkGraph {
		return cache ? cache.get("graph", computeLinkGraph) : computeLinkGraph();
	}

	tools.push({
		name: "vault_graph_neighborhood",
		tier: "read",
		config: {
			title: "Graph neighborhood",
			description: "Find all notes within N link-hops of a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				depth: z.number().optional().describe("Max hops (1-5, default 1)"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			const depth = Math.min(Math.max((args.depth as number | undefined) ?? 1, 1), 5);
			const graph = buildLinkGraph();
			const visited = new Set<string>([f.path]);
			let frontier = new Set<string>([f.path]);
			const levels: string[][] = [];
			for (let d = 0; d < depth; d++) {
				const nextFrontier = new Set<string>();
				for (const node of frontier) {
					for (const neighbor of graph.forward.get(node) ?? []) {
						if (!visited.has(neighbor)) {
							visited.add(neighbor);
							nextFrontier.add(neighbor);
						}
					}
					for (const neighbor of graph.reverse.get(node) ?? []) {
						if (!visited.has(neighbor)) {
							visited.add(neighbor);
							nextFrontier.add(neighbor);
						}
					}
				}
				if (nextFrontier.size > 0) levels.push([...nextFrontier].sort());
				frontier = nextFrontier;
			}
			if (levels.length === 0) return text("(no linked notes)");
			const output = levels
				.map((nodes, i) => `Depth ${i + 1}:\n  ${nodes.join("\n  ")}`)
				.join("\n");
			return text(output);
		},
	});

	tools.push({
		name: "vault_graph_path",
		tier: "read",
		config: {
			title: "Graph path",
			description: "Find the shortest link path between two notes.",
			inputSchema: {
				source: z.string().describe("Source file path"),
				target: z.string().describe("Target file path"),
			},
		},
		handler: async (args) => {
			const sourcePath = args.source as string;
			const targetPath = args.target as string;
			if (!app.vault.getFileByPath(sourcePath)) return error("Source file not found.");
			if (!app.vault.getFileByPath(targetPath)) return error("Target file not found.");
			if (sourcePath === targetPath) return text(sourcePath);

			const graph = buildLinkGraph();
			const queue: string[][] = [[sourcePath]];
			const visited = new Set<string>([sourcePath]);

			while (queue.length > 0) {
				const path = queue.shift()!;
				const current = path[path.length - 1];
				for (const neighbor of graph.forward.get(current) ?? []) {
					if (neighbor === targetPath) return text([...path, neighbor].join(" → "));
					if (!visited.has(neighbor)) {
						visited.add(neighbor);
						queue.push([...path, neighbor]);
					}
				}
			}
			return text("No path found.");
		},
	});

	tools.push({
		name: "vault_graph_clusters",
		tier: "read",
		config: {
			title: "Graph clusters",
			description: "Find groups of densely connected notes.",
			inputSchema: {
				minSize: z.number().optional().describe("Min cluster size (default 3)"),
				maxClusters: z.number().optional().describe("Max clusters to return (default 10)"),
			},
		},
		handler: async (args) => {
			const minSize = (args.minSize as number | undefined) ?? 3;
			const maxClusters = (args.maxClusters as number | undefined) ?? 10;
			const graph = buildLinkGraph();

			const allNodes = new Set<string>();
			for (const [k, v] of graph.forward) {
				allNodes.add(k);
				for (const n of v) allNodes.add(n);
			}

			const parent = new Map<string, string>();
			for (const n of allNodes) parent.set(n, n);

			function find(x: string): string {
				let root = x;
				while (parent.get(root) !== root) root = parent.get(root)!;
				let cur = x;
				while (cur !== root) {
					const next = parent.get(cur)!;
					parent.set(cur, root);
					cur = next;
				}
				return root;
			}
			function union(a: string, b: string): void {
				parent.set(find(a), find(b));
			}

			for (const [source, targets] of graph.forward) {
				for (const target of targets) union(source, target);
			}

			const groups = new Map<string, string[]>();
			for (const node of allNodes) {
				const root = find(node);
				if (!groups.has(root)) groups.set(root, []);
				groups.get(root)!.push(node);
			}

			const clusters = [...groups.values()]
				.filter((g) => g.length >= minSize)
				.sort((a, b) => b.length - a.length)
				.slice(0, maxClusters);

			if (clusters.length === 0) return text("(no clusters found)");
			return text(
				clusters
					.map(
						(c, i) =>
							`Cluster ${i + 1} (${c.length} notes):\n  ${c.sort().join("\n  ")}`,
					)
					.join("\n\n"),
			);
		},
	});

	// ── Workflow & context tools ──────────────────────

	tools.push({
		name: "vault_context",
		tier: "read",
		config: {
			title: "File context",
			description:
				"Get a file's full context in one call: content, frontmatter, tags, headings, outgoing links, and backlinks.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			const content = await app.vault.read(f);
			const cache = app.metadataCache.getFileCache(f);
			const fm = cache?.frontmatter
				? Object.fromEntries(
						Object.entries(cache.frontmatter).filter(([k]) => k !== "position"),
					)
				: null;
			const tags = formatTags(cache);
			const headings = (cache?.headings ?? []).map(
				(h) => `${"#".repeat(h.level)} ${h.heading}`,
			);
			const outgoing = Object.keys(app.metadataCache.resolvedLinks[f.path] ?? {});
			const backlinks: string[] = [];
			for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
				if (f.path in targets) backlinks.push(source);
			}
			const sections: string[] = [
				`# ${f.path}\n`,
				fm ? `## Frontmatter\n${JSON.stringify(fm, null, 2)}\n` : "",
				tags.length ? `## Tags\n${tags.join(", ")}\n` : "",
				headings.length ? `## Headings\n${headings.join("\n")}\n` : "",
				outgoing.length ? `## Outgoing links\n${outgoing.join("\n")}\n` : "",
				backlinks.length ? `## Backlinks\n${backlinks.join("\n")}\n` : "",
				`## Content\n${content}`,
			];
			return text(sections.filter(Boolean).join("\n"));
		},
	});

	tools.push({
		name: "vault_suggest_links",
		tier: "read",
		config: {
			title: "Suggest links",
			description:
				"Find notes that could be linked from a file based on content overlap. Excludes already-linked notes.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				limit: z.number().optional().describe("Max suggestions (default 10)"),
			},
		},
		handler: async (args) => {
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			const limit = (args.limit as number | undefined) ?? 10;
			const content = await app.vault.read(f);
			const alreadyLinked = new Set(
				Object.keys(app.metadataCache.resolvedLinks[f.path] ?? {}),
			);
			alreadyLinked.add(f.path);

			const words = content
				.toLowerCase()
				.replace(/[^\w\s]/g, " ")
				.split(/\s+/)
				.filter((w) => w.length > 3);
			const wordSet = new Set(words);

			const others = app.vault
				.getMarkdownFiles()
				.filter((other) => !alreadyLinked.has(other.path));
			const candidates: { path: string; score: number }[] = [];
			await forEachMarkdownChunked((other, otherContent) => {
				let score = 0;
				if (wordSet.has(other.basename.toLowerCase())) score += 5;
				const otherWords = otherContent
					.toLowerCase()
					.replace(/[^\w\s]/g, " ")
					.split(/\s+/)
					.filter((w) => w.length > 3);
				for (const w of otherWords) {
					if (wordSet.has(w)) score++;
				}
				if (score > 0) candidates.push({ path: other.path, score });
			}, others);

			candidates.sort((a, b) => b.score - a.score);
			const results = candidates.slice(0, limit).map((c) => `${c.path} (score: ${c.score})`);
			return text(results.join("\n") || "(no suggestions)");
		},
	});

	// ── Write tools (scoped + vault-wide via factory) ────

	async function requireReview(
		review: ReviewFn | undefined,
		operation: WriteOperation,
		filePath: string,
		oldContent: string | undefined,
		newContent: string | undefined,
		description: string,
		affectedLinks: string[] | undefined = undefined,
	): Promise<McpToolResult | null> {
		if (!review) return null;
		const result = await review({
			operation,
			filePath,
			oldContent,
			newContent,
			description,
			affectedLinks,
		});
		return result.approved ? null : error("Change rejected by user.");
	}

	/**
	 * Review-gate + apply + success wrapper shared by all 8 write handlers.
	 * Handler code is reduced to: resolve the file, compute the change, pass
	 * the diff preview here. This is the only site that calls `requireReview`.
	 */
	async function runWrite(op: {
		operation: WriteOperation;
		filePath: string;
		oldContent?: string;
		newContent?: string;
		description: string;
		review: ReviewFn | undefined;
		apply: () => Promise<unknown>;
		successMsg: string;
		affectedLinks?: string[];
	}): Promise<McpToolResult> {
		const rejected = await requireReview(
			op.review,
			op.operation,
			op.filePath,
			op.oldContent,
			op.newContent,
			op.description,
			op.affectedLinks,
		);
		if (rejected) return rejected;
		await op.apply();
		return text(op.successMsg);
	}

	/** Snapshot a file's frontmatter for review preview. Excludes Obsidian's internal `position`. */
	function frontmatterSnapshot(f: TFile): Record<string, unknown> {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) return {};
		const { position: _p, ...rest } = fm as Record<string, unknown>;
		void _p;
		return rest;
	}

	interface WriteToolConfig {
		tier: PermissionTier;
		suffix: string;
		scopeLabel: string;
		guardPath: (path: string) => McpToolResult | null;
		resolveForWrite: (args: Record<string, unknown>) => TFile | McpToolResult;
		review?: ReviewFn;
	}

	function addWriteTools(cfg: WriteToolConfig): void {
		const { tier, suffix, scopeLabel, guardPath, resolveForWrite, review } = cfg;
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
				if (!isVaultPathSafe(app, path))
					return error("Path resolves outside the vault (symlink).");
				if (app.vault.getFileByPath(path))
					return error("File already exists. Use vault_modify to update it.");
				const content = (args.content as string | undefined) ?? "";
				return runWrite({
					operation: "create",
					filePath: path,
					newContent: content,
					description: `Create new file: ${path}`,
					review,
					apply: () => app.vault.create(path, content),
					successMsg: `Created ${path}`,
				});
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
				const newContent = args.content as string;
				return runWrite({
					operation: "modify",
					filePath: f.path,
					oldContent: review ? await app.vault.read(f) : undefined,
					newContent,
					description: `Modify file: ${f.path}`,
					review,
					apply: () => app.vault.modify(f, newContent),
					successMsg: `Modified ${f.path}`,
				});
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
				const addition = args.content as string;
				const oldContent = review ? await app.vault.read(f) : undefined;
				return runWrite({
					operation: "append",
					filePath: f.path,
					oldContent,
					newContent: oldContent === undefined ? undefined : oldContent + "\n" + addition,
					description: `Append to ${f.path}`,
					review,
					apply: () => app.vault.append(f, "\n" + addition),
					successMsg: `Appended to ${f.path}`,
				});
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
				const oldFm = frontmatterSnapshot(f);
				return runWrite({
					operation: "frontmatter_set",
					filePath: f.path,
					oldContent: JSON.stringify(oldFm, null, 2),
					newContent: JSON.stringify({ ...oldFm, [prop]: value }, null, 2),
					description: `Set frontmatter '${prop}' on ${f.path}`,
					review,
					apply: () =>
						app.fileManager.processFrontMatter(f, (fm) => {
							fm[prop] = value;
						}),
					successMsg: `Set ${prop} on ${f.path}`,
				});
			},
		});

		tools.push({
			name: `vault_frontmatter_delete${suffix}`,
			tier,
			config: {
				title: `Delete frontmatter property${scopeLabel}`,
				description: `Remove a YAML frontmatter property from a file${scopeLabel}.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name to delete"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				const prop = args.property as string;
				const cache = app.metadataCache.getFileCache(f);
				if (!cache?.frontmatter || !(prop in cache.frontmatter))
					return error(`Property '${prop}' not found in frontmatter.`);
				const oldFm = frontmatterSnapshot(f);
				const { [prop]: _removed, ...newFm } = oldFm;
				void _removed;
				return runWrite({
					operation: "frontmatter_delete",
					filePath: f.path,
					oldContent: JSON.stringify(oldFm, null, 2),
					newContent: JSON.stringify(newFm, null, 2),
					description: `Delete frontmatter '${prop}' from ${f.path}`,
					review,
					apply: () =>
						app.fileManager.processFrontMatter(f, (fm) => {
							delete fm[prop];
						}),
					successMsg: `Deleted ${prop} from ${f.path}`,
				});
			},
		});

		tools.push({
			name: `vault_search_replace${suffix}`,
			tier,
			config: {
				title: `Search and replace${scopeLabel}`,
				description: `Find and replace text within a file${scopeLabel}.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					search: z.string().describe("Text or regex pattern to find"),
					replace: z.string().describe("Replacement text"),
					regex: z.boolean().optional().describe("Treat search as regex (default false)"),
					caseSensitive: z
						.boolean()
						.optional()
						.describe("Case-sensitive match (default true)"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				const content = await app.vault.read(f);
				const search = args.search as string;
				const replacement = args.replace as string;
				const useRegex = (args.regex as boolean | undefined) ?? false;
				const caseSensitive = (args.caseSensitive as boolean | undefined) ?? true;

				let pattern: RegExp;
				if (useRegex) {
					try {
						pattern = new RegExp(search, caseSensitive ? "g" : "gi");
					} catch (e) {
						return error(`Invalid regex: ${(e as Error).message}`);
					}
				} else {
					const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
					pattern = new RegExp(escaped, caseSensitive ? "g" : "gi");
				}

				let count = 0;
				const updated = content.replace(pattern, (...matchArgs) => {
					count++;
					return replacement.replace(/\$(\d+)/g, (_, n) => {
						const idx = parseInt(n, 10);
						return (matchArgs[idx] as string | undefined) ?? "";
					});
				});
				if (count === 0) return error("No matches found.");
				return runWrite({
					operation: "search_replace",
					filePath: f.path,
					oldContent: content,
					newContent: updated,
					description: `Replace ${count} occurrence(s) in ${f.path}`,
					review,
					apply: () => app.vault.modify(f, updated),
					successMsg: `Replaced ${count} occurrence(s) in ${f.path}`,
				});
			},
		});

		tools.push({
			name: `vault_prepend${suffix}`,
			tier,
			config: {
				title: `Prepend to file${scopeLabel}`,
				description: `Insert content at the top of a file${scopeLabel}, after frontmatter if present.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to prepend"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				const existing = await app.vault.read(f);
				const cache = app.metadataCache.getFileCache(f);
				const fmEnd = cache?.frontmatterPosition?.end;
				let insertPos = 0;
				if (fmEnd) {
					const lines = existing.split("\n");
					let charCount = 0;
					for (let i = 0; i <= fmEnd.line && i < lines.length; i++) {
						charCount += lines[i].length + 1;
					}
					insertPos = charCount;
				}
				const before = existing.slice(0, insertPos);
				const after = existing.slice(insertPos);
				const sep = insertPos > 0 && !before.endsWith("\n") ? "\n" : "";
				const updated = before + sep + (args.content as string) + "\n" + after;
				return runWrite({
					operation: "prepend",
					filePath: f.path,
					oldContent: existing,
					newContent: updated,
					description: `Prepend to ${f.path}`,
					review,
					apply: () => app.vault.modify(f, updated),
					successMsg: `Prepended to ${f.path}`,
				});
			},
		});

		tools.push({
			name: `vault_patch${suffix}`,
			tier,
			config: {
				title: `Patch file${scopeLabel}`,
				description: `Insert or replace content at a specific location in a file${scopeLabel}.`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to insert"),
					heading: z
						.string()
						.optional()
						.describe("Target heading text (e.g. '## Details')"),
					line: z.number().optional().describe("Target line number (1-based)"),
					position: z
						.enum(["before", "after", "replace"])
						.optional()
						.describe("Where to insert relative to target (default 'after')"),
				},
			},
			handler: async (args) => {
				const result = resolveForWrite(args);
				if ("isError" in result) return result as McpToolResult;
				const f = result as TFile;
				const existing = await app.vault.read(f);
				const lines = existing.split("\n");
				const insertContent = args.content as string;
				const position = (args.position as string | undefined) ?? "after";
				const headingArg = args.heading as string | undefined;
				const lineArg = args.line as number | undefined;

				if (!headingArg && lineArg === undefined)
					return error("Provide either 'heading' or 'line' target.");

				let targetLine: number;

				if (headingArg) {
					const cache = app.metadataCache.getFileCache(f);
					const headings = cache?.headings ?? [];
					const match = headings.find(
						(h) => h.heading === headingArg.replace(/^#+\s*/, ""),
					);
					if (!match) return error(`Heading '${headingArg}' not found.`);
					targetLine = match.position.start.line;

					if (position === "after") {
						const matchLevel = match.level;
						let endLine = lines.length;
						const matchIdx = headings.indexOf(match);
						const next = headings
							.slice(matchIdx + 1)
							.find((h) => h.level <= matchLevel);
						if (next) endLine = next.position.start.line;
						const updated = [
							...lines.slice(0, endLine),
							insertContent,
							...lines.slice(endLine),
						].join("\n");
						return runWrite({
							operation: "patch",
							filePath: f.path,
							oldContent: existing,
							newContent: updated,
							description: `Patch ${f.path} after heading '${headingArg}'`,
							review,
							apply: () => app.vault.modify(f, updated),
							successMsg: `Patched ${f.path} after heading '${headingArg}'`,
						});
					}
				} else {
					targetLine = lineArg! - 1;
					if (targetLine < 0 || targetLine > lines.length)
						return error(`Line ${lineArg} is out of range (1-${lines.length}).`);
				}

				if (position === "before") {
					lines.splice(targetLine, 0, insertContent);
				} else if (position === "replace") {
					lines.splice(targetLine, 1, insertContent);
				} else {
					lines.splice(targetLine + 1, 0, insertContent);
				}
				const updated = lines.join("\n");
				return runWrite({
					operation: "patch",
					filePath: f.path,
					oldContent: existing,
					newContent: updated,
					description: `Patch ${f.path} at line ${targetLine + 1}`,
					review,
					apply: () => app.vault.modify(f, updated),
					successMsg: `Patched ${f.path} at line ${targetLine + 1}`,
				});
			},
		});
	}

	const resolveAnywhere = (args: Record<string, unknown>) =>
		resolveFile(app, args, pathFilter) ?? error("File not found.");

	addWriteTools({
		tier: "writeScoped",
		suffix: "",
		scopeLabel: " (within write directory)",
		guardPath: (path) => {
			const writeDir = getWriteDir();
			return isPathWithinDir(path, writeDir)
				? null
				: error(`Path must be within the write directory '${writeDir}'.`);
		},
		resolveForWrite: (args) => {
			const path = args.path as string | undefined;
			if (path) {
				const writeDir = getWriteDir();
				if (!isPathWithinDir(path, writeDir))
					return error(`Path must be within the write directory '${writeDir}'.`);
			}
			const f = resolveFile(app, args, pathFilter);
			return f ?? error("File not found.");
		},
	});

	if (reviewFn) {
		addWriteTools({
			tier: "writeReviewed",
			suffix: "_reviewed",
			scopeLabel: " (reviewed)",
			guardPath: () => null,
			resolveForWrite: resolveAnywhere,
			review: reviewFn,
		});
	}

	addWriteTools({
		tier: "writeVault",
		suffix: "_anywhere",
		scopeLabel: " (vault-wide)",
		guardPath: () => null,
		resolveForWrite: resolveAnywhere,
	});

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
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			const leaf = app.workspace.getLeaf(args.newTab ? "tab" : false);
			await leaf.openFile(f);
			return text(`Opened ${f.path}`);
		},
	});

	// ── Manage tier ───────────────────────────────────

	function collectBacklinks(targetPath: string): string[] {
		const backlinks: string[] = [];
		for (const [source, targets] of Object.entries(app.metadataCache.resolvedLinks)) {
			if (targets[targetPath]) backlinks.push(source);
		}
		return backlinks;
	}

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
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			const newName = args.name as string;
			const ext = newName.includes(".") ? "" : `.${f.extension}`;
			const dir = f.parent?.path ?? "";
			const newPath = dir ? `${dir}/${newName}${ext}` : `${newName}${ext}`;
			return runWrite({
				operation: "rename",
				filePath: f.path,
				description: `Rename ${f.path} → ${newPath}`,
				affectedLinks: collectBacklinks(f.path),
				review: reviewFn,
				apply: () => app.fileManager.renameFile(f, newPath),
				successMsg: `Renamed to ${newPath}`,
			});
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
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			const dest = args.to as string;
			const newPath = `${dest}/${f.name}`;
			return runWrite({
				operation: "move",
				filePath: f.path,
				description: `Move ${f.path} → ${newPath}`,
				affectedLinks: collectBacklinks(f.path),
				review: reviewFn,
				apply: () => app.fileManager.renameFile(f, newPath),
				successMsg: `Moved to ${newPath}`,
			});
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
			const f = resolveFile(app, args, pathFilter);
			if (!f) return error("File not found.");
			return runWrite({
				operation: "delete",
				filePath: f.path,
				description: `Delete ${f.path}`,
				affectedLinks: collectBacklinks(f.path),
				review: reviewFn,
				apply: () => app.vault.trash(f, true),
				successMsg: `Deleted ${f.path}`,
			});
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
			if (!isVaultPathSafe(app, path))
				return error("Path resolves outside the vault (symlink).");
			await app.vault.createFolder(path);
			return text(`Created folder ${path}`);
		},
	});

	// ── Batch operations ──────────────────────────────

	tools.push({
		name: "vault_batch_frontmatter",
		tier: "manage",
		config: {
			title: "Batch frontmatter update",
			description:
				"Set or delete a frontmatter property across all files matching a search query. Use dryRun to preview changes.",
			inputSchema: {
				query: z.string().describe("Search query to match files"),
				property: z.string().describe("Frontmatter property name"),
				value: z
					.string()
					.optional()
					.describe("Value to set (JSON-encoded for objects/arrays). Omit to delete."),
				dryRun: z.boolean().optional().describe("Preview only, no changes (default true)"),
			},
		},
		handler: async (args) => {
			const query = args.query as string;
			const property = args.property as string;
			const rawValue = args.value as string | undefined;
			const dryRun = (args.dryRun as boolean | undefined) ?? true;

			const search = prepareSimpleSearch(query);
			const matched: TFile[] = [];
			await forEachMarkdownChunked((file, content) => {
				if (search(content)) matched.push(file);
			});

			if (matched.length === 0) return text("No files matched the query.");

			if (dryRun) {
				const label = rawValue !== undefined ? `set ${property}` : `delete ${property}`;
				return text(
					`Dry run — would ${label} on ${matched.length} file(s):\n${matched.map((f) => f.path).join("\n")}`,
				);
			}

			let value: unknown;
			if (rawValue !== undefined) {
				try {
					value = JSON.parse(rawValue);
				} catch {
					value = rawValue;
				}
			}

			let targets: TFile[] = matched;
			if (reviewBatchFn) {
				const items = matched.map((file) => {
					const oldFm = frontmatterSnapshot(file);
					const newFm =
						rawValue !== undefined
							? { ...oldFm, [property]: value }
							: (() => {
									const { [property]: _r, ...rest } = oldFm;
									void _r;
									return rest;
								})();
					return {
						filePath: file.path,
						oldContent: JSON.stringify(oldFm, null, 2),
						newContent: JSON.stringify(newFm, null, 2),
					};
				});
				const op: WriteOperation =
					rawValue !== undefined ? "frontmatter_set" : "frontmatter_delete";
				const verb = rawValue !== undefined ? `Set ${property}` : `Delete ${property}`;
				const result = await reviewBatchFn({
					operation: op,
					description: `${verb} on ${matched.length} file(s) matching "${query}"`,
					items,
				});
				if (!result.approved) return error("Change rejected by user.");
				const approved = new Set(result.approvedPaths);
				targets = matched.filter((f) => approved.has(f.path));
				if (targets.length === 0)
					return text("Batch approved with no files selected; nothing to do.");
			}

			for (const file of targets) {
				await app.fileManager.processFrontMatter(file, (fm) => {
					if (rawValue !== undefined) {
						fm[property] = value;
					} else {
						delete fm[property];
					}
				});
			}

			const label = rawValue !== undefined ? `Set ${property}` : `Deleted ${property}`;
			return text(`${label} on ${targets.length} file(s).`);
		},
	});

	// ── Extensions tier (plugin integrations) ─────────

	registerExtensionTools(app, (tool) => tools.push(tool));

	// ── Agent tier ────────────────────────────────────

	tools.push({
		name: "agent_status_set",
		tier: "agent",
		config: {
			title: "Set agent activity status",
			description:
				"Report the current agent lifecycle state so the plugin can show which sessions are working, awaiting input, or idle. Call on transitions (e.g. at the start of a long tool call, when a user prompt is needed, when you're done).",
			inputSchema: {
				status: z
					.enum(["idle", "working", "awaiting_input"])
					.describe("Current agent state"),
				sessionName: z
					.string()
					.optional()
					.describe(
						"tmux session name if running inside one (e.g. $(tmux display-message -p '#S')). Omit for an unnamed session.",
					),
				detail: z
					.string()
					.optional()
					.describe("Short human-readable context (e.g. tool name, question)"),
			},
		},
		handler: async (args) => {
			const status = args.status as AgentStatus;
			const sessionName =
				((args.sessionName as string | undefined) ?? "").trim() || "__default__";
			const detail = (args.detail as string | undefined) ?? undefined;
			onActivity?.({ sessionName, status, detail });
			return text("OK");
		},
	});

	return tools;
}
