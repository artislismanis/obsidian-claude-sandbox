import type { App, TFile, CachedMetadata } from "obsidian";
import { prepareSimpleSearch, prepareFuzzySearch } from "obsidian";
import { z } from "zod/v4";
import {
	isPathWithinDir,
	isPathAllowed,
	isRealPathWithinBase,
	pathHasParentSegment,
} from "./validation";
import type { WriteOperation } from "./diff-review-modal";
import { registerExtensionTools } from "./mcp-extensions";
import {
	applyTemplaterFolderTemplate,
	previewTemplaterFolderTemplate,
	withTemplaterHookSuppressed,
} from "./templater-adapter";
import { errMsg } from "./logger";
import { getVaultBasePath, getVaultFullPath } from "./obsidian-internals";

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

/** Sentinel session key used by both ActivityUi and the MCP `agent_status_set` tool
 *  to represent activity outside any explicit tmux session name. */
export const DEFAULT_SESSION_KEY = "__default__";

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

export interface McpToolResult {
	[key: string]: unknown;
	content: Array<{ type: "text"; text: string }>;
	isError?: boolean;
}

export function text(str: string): McpToolResult {
	return { content: [{ type: "text", text: str }] };
}

export function error(msg: string): McpToolResult {
	return { content: [{ type: "text", text: msg }], isError: true };
}

/**
 * Build a tool definition whose handler receives args typed to the inferred
 * zod schema. Runtime parsing runs before the handler fires; schema-mismatch
 * inputs return an error result instead of throwing or silently feeding
 * undefined into casts. Handlers can destructure directly:
 *
 *   defineTool({
 *     name: "vault_read",
 *     inputSchema: { path: z.string() },
 *     handler: async ({ path }) => { ... },
 *   })
 */
export function defineTool<S extends Record<string, z.ZodType>>(def: {
	name: string;
	tier: PermissionTier;
	title: string;
	description: string;
	inputSchema?: S;
	handler: (args: z.infer<z.ZodObject<S>>) => Promise<McpToolResult>;
}): McpToolDef {
	const schema = def.inputSchema ? z.object(def.inputSchema) : z.object({});
	return {
		name: def.name,
		tier: def.tier,
		config: {
			title: def.title,
			description: def.description,
			inputSchema: def.inputSchema,
		},
		handler: async (raw) => {
			const parsed = schema.safeParse(raw);
			if (!parsed.success) {
				return error(`Invalid arguments: ${parsed.error.message}`);
			}
			return def.handler(parsed.data as z.infer<z.ZodObject<S>>);
		},
	};
}

/** Extract a 180-char window around the first match offset, with newlines flattened. */
function extractSnippet(content: string, offset: number): string {
	const start = Math.max(0, offset - 60);
	const end = Math.min(content.length, offset + 120);
	return content.slice(start, end).replace(/\n/g, " ");
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
	args: { file?: string; path?: string },
	pathFilter?: PathFilter,
): TFile | null {
	let resolved: TFile | null = null;
	if (args.path) resolved = app.vault.getFileByPath(args.path) ?? null;
	else if (args.file) resolved = app.metadataCache.getFirstLinkpathDest(args.file, "") ?? null;
	if (resolved && pathFilter) {
		if (!isPathAllowed(resolved.path, pathFilter.allowlist, pathFilter.blocklist)) return null;
	}
	if (resolved && !isVaultPathSafe(app, resolved.path)) return null;
	return resolved;
}

/**
 * Posix-segment check for `..` components. Replaces the coarse
 * `path.includes("..")` which would also reject legitimate names like
 * `notes/v1..2.md` or `..safe/foo.md`. We split on both `/` and `\` so callers
 * don't need to worry about backslashes appearing on Windows-shaped inputs.
 */
// pathHasParentSegment is imported from validation.ts (single shared implementation).

/** True when `vaultPath` resolves to a real filesystem path inside the vault base. */
function isVaultPathSafe(app: App, vaultPath: string): boolean {
	const base = getVaultBasePath(app);
	const full = getVaultFullPath(app, vaultPath);
	if (base === null || full === null) return true;
	return isRealPathWithinBase(base, full);
}

/** Parallel-chunked iteration over markdown files; handler returning true stops the walk. */
export async function forEachMarkdownChunked(
	app: App,
	handler: (file: TFile, content: string) => boolean | void | Promise<boolean | void>,
	files: TFile[] = app.vault.getMarkdownFiles(),
	chunkSize = 20,
): Promise<void> {
	for (let i = 0; i < files.length; i += chunkSize) {
		const chunk = files.slice(i, i + chunkSize);
		// Tolerate per-file read errors. A single unreadable file (permission
		// glitch, transient FS error) used to abort the entire scan via
		// Promise.all rejection — meaning vault_search / vault_orphans /
		// vault_suggest_links / vault_tasks_query would fail wholesale because
		// of one bad file. Skip the bad file with empty content so the scan
		// completes and surfaces partial results.
		const contents = await Promise.all(
			chunk.map((f) => app.vault.cachedRead(f).catch(() => "")),
		);
		for (let j = 0; j < chunk.length; j++) {
			const stop = await handler(chunk[j], contents[j]);
			if (stop) return;
		}
	}
}

export type ReviewFn = (request: {
	operation: WriteOperation;
	filePath: string;
	oldContent?: string;
	newContent?: string;
	description: string;
	affectedLinks?: string[];
}) => Promise<{ approved: boolean }>;

/**
 * Shared write boundary for tools that don't go through the writeScoped /
 * writeReviewed / writeVault dispatch — specifically the `manage` and
 * `extensions` tier tools that create or modify vault files. Honors the same
 * VaultWriteMode semantics: writes inside the write directory always pass;
 * writes outside require either `writeVault` (apply directly) or
 * `writeReviewed` (prompt via review); otherwise reject.
 */
export async function gateVaultWrite(args: {
	destPath: string;
	operation: WriteOperation;
	description: string;
	writeDir: string;
	enabledTiers: ReadonlySet<PermissionTier>;
	review: ReviewFn | undefined;
	apply: () => Promise<unknown>;
	successMsg: string;
	oldContent?: string;
	newContent?: string;
	affectedLinks?: string[];
}): Promise<McpToolResult> {
	// Errors thrown by apply() (e.g. the Templater post-validate guard
	// rejecting a path-relocating template) need to surface as clean tool
	// errors. Without this, gateVaultWrite would propagate the throw and the
	// MCP tool runner would either turn it into a generic 500 or return it
	// untyped. Wrap apply() so callers always get a well-formed McpToolResult.
	const runApply = async (): Promise<McpToolResult> => {
		try {
			await args.apply();
			return text(args.successMsg);
		} catch (e) {
			return error(errMsg(e));
		}
	};
	const within = isPathWithinDir(args.destPath, args.writeDir);
	if (within || args.enabledTiers.has("writeVault")) {
		return runApply();
	}
	if (args.enabledTiers.has("writeReviewed") && args.review) {
		const result = await args.review({
			operation: args.operation,
			filePath: args.destPath,
			oldContent: args.oldContent,
			newContent: args.newContent,
			description: args.description,
			affectedLinks: args.affectedLinks,
		});
		if (!result.approved) return error("Change rejected by user.");
		return runApply();
	}
	return error(
		`Path '${args.destPath}' is outside the write directory '${args.writeDir}'. Enable vault-wide or reviewed writes to operate here.`,
	);
}

export type ReviewBatchFn = (request: {
	operation: WriteOperation;
	description: string;
	items: Array<{ filePath: string; oldContent?: string; newContent?: string }>;
}) => Promise<{ approved: boolean; approvedPaths: string[] }>;

const ALL_TIERS: ReadonlySet<PermissionTier> = new Set<PermissionTier>([
	"read",
	"writeScoped",
	"writeReviewed",
	"writeVault",
	"navigate",
	"manage",
	"extensions",
	"agent",
]);

export interface BuildToolsOptions {
	app: App;
	getWriteDir: () => string;
	pathFilter?: PathFilter;
	review?: ReviewFn;
	reviewBatch?: ReviewBatchFn;
	cache?: { get<T>(key: string, compute: () => T): T };
	onActivity?: OnActivity;
	enabledTiers?: ReadonlySet<PermissionTier>;
}

export function buildTools(opts: BuildToolsOptions): McpToolDef[] {
	const {
		app,
		getWriteDir,
		pathFilter,
		review: reviewFn,
		reviewBatch: reviewBatchFn,
		cache,
		onActivity,
		enabledTiers = ALL_TIERS,
	} = opts;
	const tools: McpToolDef[] = [];

	const forEachMarkdown: (
		handler: (file: TFile, content: string) => boolean | void | Promise<boolean | void>,
		files?: TFile[],
		chunkSize?: number,
	) => Promise<void> = (handler, files, chunkSize) =>
		forEachMarkdownChunked(app, handler, files, chunkSize);

	/** Cached compute, falling through directly when no cache is wired (tests). */
	function memo<T>(key: string, compute: () => T): T {
		return cache ? cache.get(key, compute) : compute();
	}

	function computeTagCountsSorted(): [string, number][] {
		const counts: Record<string, number> = {};
		for (const file of app.vault.getMarkdownFiles()) {
			const cache = app.metadataCache.getFileCache(file);
			for (const tag of formatTags(cache)) {
				counts[tag] = (counts[tag] ?? 0) + 1;
			}
		}
		return Object.entries(counts).sort((a, b) => b[1] - a[1]);
	}

	function computePropertyCountsSorted(): [string, number][] {
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
		return Object.entries(counts).sort((a, b) => b[1] - a[1]);
	}

	// ── Read tier ─────────────────────────────────────

	tools.push(
		defineTool({
			name: "vault_read",
			tier: "read",
			title: "Read file",
			description: "Read the contents of a file in the vault.",
			inputSchema: {
				file: z.string().optional().describe("File name (wikilink-style resolution)"),
				path: z.string().optional().describe("Exact path from vault root"),
			},
			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const content = await app.vault.cachedRead(f);
				return text(content);
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_list",
			tier: "read",
			title: "List files",
			description: "List files in the vault. Optionally filter by folder or extension.",
			inputSchema: {
				folder: z.string().optional().describe("Filter by folder path"),
				extension: z.string().optional().describe("Filter by extension (e.g. md, json)"),
			},
			handler: async ({ folder, extension }) => {
				let files = app.vault.getFiles();
				if (folder) files = files.filter((f) => isPathWithinDir(f.path, folder));
				if (extension) files = files.filter((f) => f.extension === extension);
				return text(files.map((f) => f.path).join("\n") || "(no files)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_search",
			tier: "read",
			title: "Search vault",
			description:
				"Search for text across all markdown files in the vault. Returns matching file paths with context.",
			inputSchema: {
				query: z.string().describe("Search query text"),
				limit: z.number().optional().describe("Max results (default 20)"),
			},
			handler: async ({ query, limit: limitArg }) => {
				const limit = limitArg ?? 20;
				const search = prepareSimpleSearch(query);
				const results: string[] = [];
				await forEachMarkdown(
					(file, content) => {
						const match = search(content);
						if (!match) return;
						const snippet = extractSnippet(content, match.matches[0]?.[0] ?? 0);
						results.push(`${file.path}: ...${snippet}...`);
						return results.length >= limit;
					},
					undefined,
					// Chunk size = limit (capped 1..8). forEachMarkdownChunked
					// awaits the whole chunk before checking `stop`, so a chunk
					// of 20 reads 19 extra files when limit=1. Keep chunks tight
					// for low limits and just pay extra round-trips on small
					// vaults — full-batch concurrency only helps when limit is
					// also high.
					Math.max(1, Math.min(limit, 8)),
				);
				return text(results.join("\n") || "No matches found.");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_search_fuzzy",
			tier: "read",
			title: "Fuzzy search vault",
			description:
				"Fuzzy full-text search across all markdown files — tolerates typos and approximate matches. Results are score-sorted.",
			inputSchema: {
				query: z.string().describe("Search query text (fuzzy matched)"),
				limit: z.number().optional().describe("Max results (default 20)"),
			},
			handler: async ({ query, limit: limitArg }) => {
				const limit = limitArg ?? 20;
				const search = prepareFuzzySearch(query);
				const hits: { path: string; score: number; snippet: string }[] = [];
				await forEachMarkdown((file, content) => {
					const match = search(content);
					if (!match) return;
					const snippet = extractSnippet(content, match.matches[0]?.[0] ?? 0);
					hits.push({ path: file.path, score: match.score, snippet });
				});
				hits.sort((a, b) => b.score - a.score);
				const formatted = hits
					.slice(0, limit)
					.map((h) => `${h.path} (score ${h.score.toFixed(2)}): ...${h.snippet}...`);
				return text(formatted.join("\n") || "No matches found.");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_file_info",
			tier: "read",
			title: "File info",
			description: "Get metadata about a file (path, name, size, dates).",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				return text(fileToInfo(f));
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_tags",
			tier: "read",
			title: "List tags",
			description:
				"List all tags in the vault with occurrence counts, or tags for a specific file.",
			inputSchema: {
				file: z.string().optional().describe("File name (omit for vault-wide)"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (f) {
					const cache = app.metadataCache.getFileCache(f);
					const tags = formatTags(cache);
					return text(tags.join("\n") || "(no tags)");
				}
				const sorted = memo("tagCountsSorted", computeTagCountsSorted);
				return text(
					sorted.map(([tag, count]) => `${tag}: ${count}`).join("\n") || "(no tags)",
				);
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_frontmatter",
			tier: "read",
			title: "Read frontmatter",
			description: "Read YAML frontmatter properties from a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				property: z.string().optional().describe("Specific property to read"),
			},

			handler: async ({ file, path, property }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const cache = app.metadataCache.getFileCache(f);
				const fm = cache?.frontmatter;
				if (!fm) return text("(no frontmatter)");
				if (property) {
					const val = fm[property];
					return text(
						val !== undefined
							? JSON.stringify(val)
							: `(property '${property}' not found)`,
					);
				}
				return text(JSON.stringify(frontmatterSnapshot(f), null, 2));
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_links",
			tier: "read",
			title: "Outgoing links",
			description: "List outgoing links from a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const resolved = app.metadataCache.resolvedLinks[f.path] ?? {};
				const entries = Object.entries(resolved).map(
					([target, count]) => `${target} (${count})`,
				);
				return text(entries.join("\n") || "(no outgoing links)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_backlinks",
			tier: "read",
			title: "Backlinks",
			description: "List files that link to a given file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const backlinks = collectBacklinks(f.path);
				return text(backlinks.join("\n") || "(no backlinks)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_headings",
			tier: "read",
			title: "Headings",
			description: "List headings from a file as an outline.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const cache = app.metadataCache.getFileCache(f);
				const headings = cache?.headings ?? [];
				const lines = headings.map((h) => `${"  ".repeat(h.level - 1)}${h.heading}`);
				return text(lines.join("\n") || "(no headings)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_orphans",
			tier: "read",
			title: "Orphan notes",
			description: "List markdown files with no incoming links from other files.",

			handler: async () => {
				const linkedTo = buildLinkGraph().reverse;
				const orphans = app.vault.getMarkdownFiles().filter((f) => !linkedTo.has(f.path));
				return text(orphans.map((f) => f.path).join("\n") || "(no orphans)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_unresolved",
			tier: "read",
			title: "Unresolved links",
			description: "List broken wikilinks that don't resolve to any file.",

			handler: async () => {
				const entries: string[] = [];
				for (const [source, targets] of Object.entries(app.metadataCache.unresolvedLinks)) {
					for (const [target, count] of Object.entries(targets)) {
						entries.push(`${target} (from ${source}, ${count}x)`);
					}
				}
				return text(entries.join("\n") || "(no unresolved links)");
			},
		}),
	);

	// ── Graph & knowledge tools (read tier) ──────────

	tools.push(
		defineTool({
			name: "vault_recent",
			tier: "read",
			title: "Recently modified files",
			description: "List recently modified files sorted by modification time.",
			inputSchema: {
				limit: z.number().optional().describe("Max results (default 20)"),
				folder: z.string().optional().describe("Filter by folder path"),
				extension: z.string().optional().describe("Filter by extension"),
			},

			handler: async ({ limit = 20, folder, extension }) => {
				let files = app.vault.getFiles();
				if (folder) files = files.filter((f) => isPathWithinDir(f.path, folder));
				if (extension) files = files.filter((f) => f.extension === extension);
				files.sort((a, b) => b.stat.mtime - a.stat.mtime);
				const results = files.slice(0, limit).map((f) => {
					const date = new Date(f.stat.mtime).toISOString();
					return `${date}  ${f.path}`;
				});
				return text(results.join("\n") || "(no files)");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_properties",
			tier: "read",
			title: "Vault properties",
			description:
				"List all frontmatter property names across the vault with usage counts, or distinct values for a specific property.",
			inputSchema: {
				property: z
					.string()
					.optional()
					.describe("Property name to get distinct values for"),
			},

			handler: async ({ property }) => {
				if (property) {
					const compute = (): Array<[string, number]> => {
						const values: Record<string, number> = {};
						for (const file of app.vault.getMarkdownFiles()) {
							const fm = app.metadataCache.getFileCache(file)?.frontmatter;
							if (fm && property in fm) {
								const val = JSON.stringify(fm[property]);
								values[val] = (values[val] ?? 0) + 1;
							}
						}
						return Object.entries(values).sort((a, b) => b[1] - a[1]);
					};
					const sorted = memo(`propertyValues:${property}`, compute);
					return text(
						sorted.map(([val, count]) => `${val}: ${count}`).join("\n") ||
							`(no files have property '${property}')`,
					);
				}
				const sorted = memo("propertyCountsSorted", computePropertyCountsSorted);
				return text(
					sorted.map(([key, count]) => `${key}: ${count}`).join("\n") ||
						"(no properties)",
				);
			},
		}),
	);

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
		return memo("graph", computeLinkGraph);
	}

	tools.push(
		defineTool({
			name: "vault_graph_neighborhood",
			tier: "read",
			title: "Graph neighborhood",
			description: "Find all notes within N link-hops of a file.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				depth: z.number().optional().describe("Max hops (1-5, default 1)"),
			},

			handler: async ({ file, path, depth: depthArg }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const depth = Math.min(Math.max(depthArg ?? 1, 1), 5);
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
		}),
	);

	tools.push(
		defineTool({
			name: "vault_graph_path",
			tier: "read",
			title: "Graph path",
			description: "Find the shortest link path between two notes.",
			inputSchema: {
				source: z.string().describe("Source file path"),
				target: z.string().describe("Target file path"),
			},

			handler: async ({ source: sourcePath, target: targetPath }) => {
				if (!app.vault.getFileByPath(sourcePath)) return error("Source file not found.");
				if (!app.vault.getFileByPath(targetPath)) return error("Target file not found.");
				if (sourcePath === targetPath) return text(sourcePath);

				const graph = buildLinkGraph();
				// Reconstruct paths from a parent map instead of carrying full
				// path arrays in the queue. Two wins: (1) avoid the O(n²) cost
				// of `Array.shift()` by walking the queue with an index pointer
				// (Array.shift moves all subsequent elements on each call); (2)
				// memory bounded by visited size, not visited × average path
				// length.
				const queue: string[] = [sourcePath];
				let head = 0;
				const parent = new Map<string, string>();
				const visited = new Set<string>([sourcePath]);
				const MAX_VISITED = 5000;

				const reconstruct = (end: string): string => {
					const trail: string[] = [end];
					let cur: string | undefined = end;
					while ((cur = parent.get(cur))) trail.push(cur);
					trail.reverse();
					return trail.join(" → ");
				};

				while (head < queue.length) {
					const current = queue[head++];
					for (const neighbor of graph.forward.get(current) ?? []) {
						if (visited.has(neighbor)) continue;
						visited.add(neighbor);
						parent.set(neighbor, current);
						if (neighbor === targetPath) return text(reconstruct(neighbor));
						if (visited.size > MAX_VISITED) {
							// Budget exhaustion is an expected outcome on large
							// graphs, not a tool error — return as text so the
							// audit log doesn't record this as a failure.
							return text(
								`Search exhausted at ${MAX_VISITED} nodes — graph too large for exhaustive BFS.`,
							);
						}
						queue.push(neighbor);
					}
				}
				return text("No path found.");
			},
		}),
	);

	tools.push(
		defineTool({
			name: "vault_graph_clusters",
			tier: "read",
			title: "Graph clusters",
			description: "Find groups of densely connected notes.",
			inputSchema: {
				minSize: z.number().optional().describe("Min cluster size (default 3)"),
				maxClusters: z.number().optional().describe("Max clusters to return (default 10)"),
			},

			handler: async ({ minSize = 3, maxClusters = 10 }) => {
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
		}),
	);

	// ── Workflow & context tools ──────────────────────

	tools.push(
		defineTool({
			name: "vault_context",
			tier: "read",
			title: "File context",
			description:
				"Get a file's full context in one call: content, frontmatter, tags, headings, outgoing links, and backlinks.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const content = await app.vault.cachedRead(f);
				const cache = app.metadataCache.getFileCache(f);
				const snapshot = frontmatterSnapshot(f);
				const fm = Object.keys(snapshot).length > 0 ? snapshot : null;
				const tags = formatTags(cache);
				const headings = (cache?.headings ?? []).map(
					(h) => `${"#".repeat(h.level)} ${h.heading}`,
				);
				const outgoing = Object.keys(app.metadataCache.resolvedLinks[f.path] ?? {});
				const backlinks = collectBacklinks(f.path);
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
		}),
	);

	tools.push(
		defineTool({
			name: "vault_suggest_links",
			tier: "read",
			title: "Suggest links",
			description:
				"Find notes that could be linked from a file based on content overlap. Excludes already-linked notes.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				limit: z.number().optional().describe("Max suggestions (default 10)"),
			},

			handler: async ({ file, path, limit = 10 }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const content = await app.vault.cachedRead(f);
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
				// Bounds for an inherently O(N×M) scan: per-file early exit
				// caps each comparison to the first ~5k words (well past the
				// point where any score signal stabilises), and SCAN_FILE_CAP
				// stops the walk once we've examined enough files to populate
				// `limit` results several times over. Without these, a vault
				// of 10k notes × 50 KiB each pegged the UI thread for >30s.
				const PER_FILE_WORD_CAP = 5000;
				const SCAN_FILE_CAP = Math.max(500, limit * 50);
				let scanned = 0;
				const candidates: { path: string; score: number }[] = [];
				await forEachMarkdown((other, otherContent) => {
					if (scanned++ >= SCAN_FILE_CAP) return true;
					let score = 0;
					if (wordSet.has(other.basename.toLowerCase())) score += 5;
					const otherWords = otherContent
						.toLowerCase()
						.replace(/[^\w\s]/g, " ")
						.split(/\s+/);
					const cap = Math.min(otherWords.length, PER_FILE_WORD_CAP);
					for (let i = 0; i < cap; i++) {
						const w = otherWords[i];
						if (w.length > 3 && wordSet.has(w)) score++;
					}
					if (score > 0) candidates.push({ path: other.path, score });
				}, others);

				candidates.sort((a, b) => b.score - a.score);
				const results = candidates
					.slice(0, limit)
					.map((c) => `${c.path} (score: ${c.score})`);
				return text(results.join("\n") || "(no suggestions)");
			},
		}),
	);

	// ── Write tools (scoped + vault-wide via factory) ────

	/**
	 * Review-gate + apply + success wrapper shared by all 8 write handlers.
	 * Handler code is reduced to: resolve the file, compute the change, pass
	 * the diff preview here.
	 */
	async function runWrite(op: {
		operation: WriteOperation;
		filePath: string;
		oldContent?: string;
		newContent?: string;
		description: string;
		review: ReviewFn | undefined;
		/** Optional context to splice into successMsg via the `{result}` placeholder. */
		apply: () => Promise<string | void>;
		/** `{result}` is replaced by the apply()'s returned string when present. */
		successMsg: string;
		affectedLinks?: string[];
		/** When set together with `oldContent` and a review, after approval the
		 *  file is re-read and the write is aborted if the contents changed
		 *  out from under the modal. Compare-and-swap against editor edits that
		 *  raced the review. Without this, the user could approve a stale diff
		 *  and the apply would clobber the change. */
		recheckFile?: TFile;
	}): Promise<McpToolResult> {
		if (op.review) {
			const result = await op.review({
				operation: op.operation,
				filePath: op.filePath,
				oldContent: op.oldContent,
				newContent: op.newContent,
				description: op.description,
				affectedLinks: op.affectedLinks,
			});
			if (!result.approved) return error("Change rejected by user.");
			if (op.recheckFile && op.oldContent !== undefined) {
				const current = await app.vault.read(op.recheckFile);
				if (current !== op.oldContent) {
					return error(
						`File '${op.filePath}' changed during review — aborting to avoid clobbering an external edit. Re-run the tool to see the current contents.`,
					);
				}
			}
		}
		const applyResult = await op.apply();
		const msg = op.successMsg.replace("{result}", applyResult ?? "");
		return text(msg);
	}

	/** Parse `raw` as JSON; fall back to the raw string if it isn't valid JSON. */
	function parseJsonOrString(raw: string): unknown {
		try {
			return JSON.parse(raw);
		} catch {
			return raw;
		}
	}

	/** Snapshot a file's frontmatter for review preview. Excludes Obsidian's internal `position`. */
	function frontmatterSnapshot(f: TFile): Record<string, unknown> {
		const fm = app.metadataCache.getFileCache(f)?.frontmatter;
		if (!fm) return {};
		const { position: _position, ...rest } = fm;
		return rest;
	}

	interface WriteToolConfig {
		tier: PermissionTier;
		suffix: string;
		scopeLabel: string;
		/** Sentence appended to every write-tool description. Gives the model an upfront signal
		 * about where the tool can operate, so it does not discover scope failures only by trial. */
		scopeNote: string;
		guardPath: (path: string) => McpToolResult | null;
		resolveForWrite: (
			args: Record<string, unknown>,
		) => { ok: true; file: TFile } | { ok: false; error: McpToolResult };
		review?: ReviewFn;
	}

	function addWriteTools(cfg: WriteToolConfig): void {
		const { tier, suffix, scopeLabel, scopeNote, guardPath, resolveForWrite, review } = cfg;
		const note = ` ${scopeNote}`;
		tools.push(
			defineTool({
				name: `vault_create${suffix}`,
				tier,
				title: `Create file${scopeLabel}`,
				description: `Create a new file${scopeLabel}.${note}`,
				inputSchema: {
					path: z.string().describe("Path from vault root"),
					content: z.string().optional().describe("Initial content (default empty)"),
				},

				handler: async ({ path, content: contentArg }) => {
					// Defense in depth: reject obvious traversal up-front so we never
					// rely solely on isVaultPathSafe (which only blocks via realpath
					// of an existing ancestor — for an entirely new tree the
					// not-yet-existing portion isn't checked).
					if (pathHasParentSegment(path) || path.startsWith("/") || path.startsWith("\\"))
						return error(
							"Path may not contain a '..' segment or start with '/' or '\\'.",
						);
					const guard = guardPath(path);
					if (guard) return guard;
					if (!isVaultPathSafe(app, path))
						return error("Path resolves outside the vault (symlink).");
					if (app.vault.getFileByPath(path))
						return error("File already exists. Use vault_modify to update it.");
					const content = contentArg ?? "";
					// Only auto-apply the folder template when the caller didn't supply
					// content; otherwise we'd silently clobber the agent's intended payload.
					const tryTemplate = content === "" && path.endsWith(".md");
					// Render the template body for the review modal so what's shown ==
					// what's written. We show the raw template (placeholders intact)
					// because rendering them requires the file to exist; the review
					// gate must happen before file creation.
					let previewContent = content;
					if (review && tryTemplate) {
						const tmplBody = await previewTemplaterFolderTemplate(app, path);
						if (tmplBody !== null) previewContent = tmplBody;
					}
					return runWrite({
						operation: "create",
						filePath: path,
						newContent: previewContent,
						description: `Create new file: ${path}`,
						review,
						apply: () =>
							withTemplaterHookSuppressed(app, async () => {
								const created = await app.vault.create(path, content);
								const tmpl = tryTemplate
									? await applyTemplaterFolderTemplate(app, created)
									: null;
								return tmpl ? ` (applied template ${tmpl})` : "";
							}),
						successMsg: `Created ${path}{result}`,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_modify${suffix}`,
				tier,
				title: `Modify file${scopeLabel}`,
				description: `Replace the full contents of a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("New file content"),
				},

				handler: async ({ file, path, content }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					return runWrite({
						operation: "modify",
						filePath: f.path,
						oldContent: review ? await app.vault.read(f) : undefined,
						newContent: content,
						description: `Modify file: ${f.path}`,
						review,
						apply: () => app.vault.modify(f, content),
						successMsg: `Modified ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_append${suffix}`,
				tier,
				title: `Append to file${scopeLabel}`,
				description: `Append content to the end of a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to append"),
				},

				handler: async ({ file, path, content: addition }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const oldContent = review ? await app.vault.read(f) : undefined;
					return runWrite({
						operation: "append",
						filePath: f.path,
						oldContent,
						newContent:
							oldContent === undefined ? undefined : oldContent + "\n" + addition,
						description: `Append to ${f.path}`,
						review,
						apply: () => app.vault.append(f, "\n" + addition),
						successMsg: `Appended to ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_frontmatter_set${suffix}`,
				tier,
				title: `Set frontmatter${scopeLabel}`,
				description: `Set a YAML frontmatter property on a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name"),
					value: z.string().describe("Property value (JSON-encoded for objects/arrays)"),
				},

				handler: async ({ file, path, property, value: raw }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const value = parseJsonOrString(raw);
					const oldFm = frontmatterSnapshot(f);
					return runWrite({
						operation: "frontmatter_set",
						filePath: f.path,
						oldContent: JSON.stringify(oldFm, null, 2),
						newContent: JSON.stringify({ ...oldFm, [property]: value }, null, 2),
						description: `Set frontmatter '${property}' on ${f.path}`,
						review,
						apply: () =>
							app.fileManager.processFrontMatter(f, (fm) => {
								fm[property] = value;
							}),
						successMsg: `Set ${property} on ${f.path}`,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_frontmatter_delete${suffix}`,
				tier,
				title: `Delete frontmatter property${scopeLabel}`,
				description: `Remove a YAML frontmatter property from a file${scopeLabel}.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					property: z.string().describe("Property name to delete"),
				},

				handler: async ({ file, path, property }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const oldFm = frontmatterSnapshot(f);
					if (!(property in oldFm))
						return error(`Property '${property}' not found in frontmatter.`);
					const { [property]: _dropped, ...newFm } = oldFm;
					return runWrite({
						operation: "frontmatter_delete",
						filePath: f.path,
						oldContent: JSON.stringify(oldFm, null, 2),
						newContent: JSON.stringify(newFm, null, 2),
						description: `Delete frontmatter '${property}' from ${f.path}`,
						review,
						apply: () =>
							app.fileManager.processFrontMatter(f, (fm) => {
								delete fm[property];
							}),
						successMsg: `Deleted ${property} from ${f.path}`,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_search_replace${suffix}`,
				tier,
				title: `Search and replace${scopeLabel}`,
				description: `Find and replace text within a file${scopeLabel}.${note}`,
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

				handler: async ({
					file,
					path,
					search,
					replace: replacement,
					regex: useRegex = false,
					caseSensitive = true,
				}) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const content = await app.vault.read(f);

					// Hard length budget: even without nested quantifiers, a
					// linear-but-large regex on multi-MB content blocks the
					// event loop for seconds — past the MCP tool timeout (which
					// only fires after replace returns), freezing Obsidian's UI
					// thread. 5 MiB is generous for any sane vault note (the
					// largest markdown file in a typical vault is well under
					// 1 MiB) and bounds replace() time to ~100ms even under
					// adversarial regex shapes that don't trip the nested-
					// quantifier guard below.
					const REPLACE_MAX_CONTENT_BYTES = 5 * 1024 * 1024;
					if (content.length > REPLACE_MAX_CONTENT_BYTES) {
						return error(
							`File too large for search/replace (${content.length} chars > ${REPLACE_MAX_CONTENT_BYTES}). Edit a smaller portion or split the file.`,
						);
					}

					let pattern: RegExp;
					if (useRegex) {
						// Reject patterns with nested quantifiers — classic ReDoS
						// shape (e.g. `(a+)+`, `(a*)*`). String.replace runs
						// synchronously and blocks the event loop past the MCP
						// tool timeout (which only fires after replace returns),
						// freezing Obsidian's UI thread.
						if (/(\([^)]*[+*][^)]*\))[+*]/.test(search)) {
							return error(
								"Refusing regex with nested quantifiers (ReDoS risk). Rewrite without `(…+)+` or `(…*)*`.",
							);
						}
						try {
							pattern = new RegExp(search, caseSensitive ? "g" : "gi");
						} catch (e) {
							return error(`Invalid regex: ${errMsg(e)}`);
						}
					} else {
						const escaped = search.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
						pattern = new RegExp(escaped, caseSensitive ? "g" : "gi");
					}

					let count = 0;
					const updated = content.replace(pattern, (...matchArgs) => {
						count++;
						// Honour `$$` (literal `$`) and `$N` only in regex mode. In literal
						// mode the user's pattern has no groups, so `$N` should pass
						// through unchanged.
						if (!useRegex) return replacement;
						return replacement.replace(/\$(\$|\d+)/g, (_, token) => {
							if (token === "$") return "$";
							const idx = parseInt(token, 10);
							const grp = matchArgs[idx];
							return typeof grp === "string" ? grp : "";
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
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_prepend${suffix}`,
				tier,
				title: `Prepend to file${scopeLabel}`,
				description: `Insert content at the top of a file${scopeLabel}, after frontmatter if present.${note}`,
				inputSchema: {
					file: z.string().optional().describe("File name"),
					path: z.string().optional().describe("Exact path from vault root"),
					content: z.string().describe("Content to prepend"),
				},

				handler: async ({ file, path, content }) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const existing = await app.vault.read(f);
					const cache = app.metadataCache.getFileCache(f);
					const fmEnd = cache?.frontmatterPosition?.end;
					// Use Obsidian's authoritative byte offset, then advance past any
					// trailing newline so the inserted content starts on its own line.
					// The line-sum approach this replaces overcounted by 1 when the
					// file had no trailing newline after frontmatter.
					let insertPos = 0;
					if (fmEnd) {
						insertPos = Math.min(fmEnd.offset, existing.length);
						// Skip past any trailing newline (handles `\n` and CRLF `\r\n`).
						while (existing[insertPos] === "\r" || existing[insertPos] === "\n")
							insertPos++;
					}
					const before = existing.slice(0, insertPos);
					const after = existing.slice(insertPos);
					const sep = insertPos > 0 && !before.endsWith("\n") ? "\n" : "";
					const updated = before + sep + content + "\n" + after;
					return runWrite({
						operation: "prepend",
						filePath: f.path,
						oldContent: existing,
						newContent: updated,
						description: `Prepend to ${f.path}`,
						review,
						apply: () => app.vault.modify(f, updated),
						successMsg: `Prepended to ${f.path}`,
						recheckFile: f,
					});
				},
			}),
		);

		tools.push(
			defineTool({
				name: `vault_patch${suffix}`,
				tier,
				title: `Patch file${scopeLabel}`,
				description: `Insert or replace content at a specific location in a file${scopeLabel}.${note}`,
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

				handler: async ({
					file,
					path,
					content: insertContent,
					heading: headingArg,
					line: lineArg,
					position = "after",
				}) => {
					const result = resolveForWrite({ file, path });
					if (!result.ok) return result.error;
					const f = result.file;
					const existing = await app.vault.read(f);
					const lines = existing.split("\n");

					if (!headingArg && lineArg === undefined)
						return error("Provide either 'heading' or 'line' target.");
					if (headingArg && position !== "after")
						return error(
							"Heading targets only support position='after'. Use a line target for before/replace.",
						);

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
								recheckFile: f,
							});
						}
					} else {
						targetLine = lineArg! - 1;
						// `replace` requires the line to actually exist; before/after
						// can target the position past the last line for appending.
						const upper = position === "replace" ? lines.length - 1 : lines.length;
						if (targetLine < 0 || targetLine > upper)
							return error(`Line ${lineArg} is out of range (1-${upper + 1}).`);
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
						recheckFile: f,
					});
				},
			}),
		);
	}

	const resolveAnywhere = (
		args: Record<string, unknown>,
	): { ok: true; file: TFile } | { ok: false; error: McpToolResult } => {
		const f = resolveFile(app, args, pathFilter);
		return f ? { ok: true, file: f } : { ok: false, error: error("File not found.") };
	};

	const guardWithinWriteDir = (path: string): McpToolResult | null => {
		const writeDir = getWriteDir();
		return isPathWithinDir(path, writeDir)
			? null
			: error(`Path must be within the write directory '${writeDir}'.`);
	};
	addWriteTools({
		tier: "writeScoped",
		suffix: "",
		scopeLabel: " (within write directory)",
		scopeNote: `Restricted to the configured write directory — paths outside will be rejected synchronously. To edit elsewhere ask the user to enable the Write (reviewed) or Write (vault-wide) tier. Call mcp_capabilities to see the current write directory and enabled tiers.`,
		guardPath: guardWithinWriteDir,
		resolveForWrite: (args) => {
			const path = args.path as string | undefined;
			const guard = path ? guardWithinWriteDir(path) : null;
			if (guard) return { ok: false, error: guard };
			const f = resolveFile(app, args, pathFilter);
			return f ? { ok: true, file: f } : { ok: false, error: error("File not found.") };
		},
	});

	if (reviewFn) {
		addWriteTools({
			tier: "writeReviewed",
			suffix: "_reviewed",
			scopeLabel: " (reviewed)",
			scopeNote:
				"Each write prompts the user for approval via a diff modal before applying. Call mcp_capabilities to see the current write directory and enabled tiers.",
			guardPath: () => null,
			resolveForWrite: resolveAnywhere,
			review: reviewFn,
		});
	}

	addWriteTools({
		tier: "writeVault",
		suffix: "_anywhere",
		scopeLabel: " (vault-wide)",
		scopeNote:
			"Unrestricted — writes anywhere in the vault without review. Call mcp_capabilities to see the current write directory and enabled tiers.",
		guardPath: () => null,
		resolveForWrite: resolveAnywhere,
	});

	// ── Navigate tier ─────────────────────────────────

	tools.push(
		defineTool({
			name: "vault_open",
			tier: "navigate",
			title: "Open file",
			description: "Open a file in the Obsidian editor. Affects the user's UI.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				newTab: z.boolean().optional().describe("Open in a new tab"),
			},

			handler: async ({ file, path, newTab }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const leaf = app.workspace.getLeaf(newTab ? "tab" : false);
				await leaf.openFile(f);
				return text(`Opened ${f.path}`);
			},
		}),
	);

	// ── Manage tier ───────────────────────────────────

	function collectBacklinks(targetPath: string): string[] {
		return [...(buildLinkGraph().reverse.get(targetPath) ?? [])];
	}

	tools.push(
		defineTool({
			name: "vault_rename",
			tier: "manage",
			title: "Rename file",
			description: "Rename a file. Automatically updates all wikilinks across the vault.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				name: z.string().describe("New file name (extension preserved if omitted)"),
			},

			handler: async ({ file, path, name: newName }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				const trimmed = newName.trim();
				if (
					trimmed.length === 0 ||
					trimmed === "." ||
					trimmed === ".." ||
					trimmed.startsWith(".") ||
					trimmed.includes("/") ||
					trimmed.includes("\\") ||
					pathHasParentSegment(trimmed)
				)
					return error(
						"'name' must be a non-empty, non-hidden bare filename (no slashes, no leading dot, no '..').",
					);
				// Treat as already-extensioned only when the trailing suffix matches
				// the file's current extension EXACTLY (case-sensitive). Names like
				// `v1.2`, `Mr.Smith`, or `notes.tech` keep `.${f.extension}`
				// appended; explicit `name: "foo.md"` round-trips unchanged. The
				// case-sensitive comparison is load-bearing on Linux: `foo.MD` and
				// `foo.md` are different files, so case-folding the suffix would
				// either silently change the casing during rename or treat a user's
				// intentional `.MD` as already-extensioned and skip our `.md` append.
				const hasTrailingExt = f.extension !== "" && trimmed.endsWith(`.${f.extension}`);
				const ext = hasTrailingExt ? "" : f.extension ? `.${f.extension}` : "";
				const dir = f.parent?.path ?? "";
				const newPath = dir ? `${dir}/${trimmed}${ext}` : `${trimmed}${ext}`;
				if (!isVaultPathSafe(app, newPath))
					return error("Destination resolves outside the vault.");
				if (newPath !== f.path && app.vault.getFileByPath(newPath))
					return error(`Destination already exists: ${newPath}`);
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
		}),
	);

	tools.push(
		defineTool({
			name: "vault_move",
			tier: "manage",
			title: "Move file",
			description: "Move a file to a different folder. Automatically updates all wikilinks.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
				to: z.string().describe("Destination folder path"),
			},

			handler: async ({ file, path, to: dest }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
				if (!f) return error("File not found.");
				if (pathHasParentSegment(dest) || dest.includes("\\"))
					return error("'to' may not contain a '..' segment or backslashes.");
				const cleanDest = dest.replace(/^\/+|\/+$/g, "");
				const newPath = cleanDest ? `${cleanDest}/${f.name}` : f.name;
				if (!isVaultPathSafe(app, newPath))
					return error("Destination resolves outside the vault.");
				if (
					pathFilter &&
					!isPathAllowed(newPath, pathFilter.allowlist, pathFilter.blocklist)
				)
					return error("Destination path is blocked by allow/block list.");
				// Pre-check destination collision so the failure surfaces as a
				// clean MCP error instead of the renameFile rejection bubbling
				// up as a generic 500 from the tool runner. No-op when the
				// destination is the same path as the source (no actual move).
				if (newPath !== f.path && app.vault.getFileByPath(newPath))
					return error(`Destination already exists: ${newPath}`);
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
		}),
	);

	tools.push(
		defineTool({
			name: "vault_delete",
			tier: "manage",
			title: "Delete file",
			description: "Move a file to trash.",
			inputSchema: {
				file: z.string().optional().describe("File name"),
				path: z.string().optional().describe("Exact path from vault root"),
			},

			handler: async ({ file, path }) => {
				const f = resolveFile(app, { file, path }, pathFilter);
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
		}),
	);

	tools.push(
		defineTool({
			name: "vault_create_folder",
			tier: "manage",
			title: "Create folder",
			description: "Create a new folder in the vault.",
			inputSchema: {
				path: z.string().describe("Folder path from vault root"),
			},

			handler: async ({ path }) => {
				if (!isVaultPathSafe(app, path))
					return error("Path resolves outside the vault (symlink).");
				return gateVaultWrite({
					destPath: path,
					operation: "create",
					description: `Create folder ${path}`,
					writeDir: getWriteDir(),
					enabledTiers,
					review: reviewFn,
					apply: () => app.vault.createFolder(path),
					successMsg: `Created folder ${path}`,
				});
			},
		}),
	);

	// ── Batch operations ──────────────────────────────

	tools.push(
		defineTool({
			name: "vault_batch_frontmatter",
			tier: "manage",
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

			handler: async ({ query, property, value: rawValue, dryRun = true }) => {
				const search = prepareSimpleSearch(query);
				// Cap matches so a broad query (`"the"`) doesn't load the entire
				// vault into memory and synchronously rewrite every frontmatter
				// block. The dry-run preview still prints the truncated list and
				// callers see the "showing first N of M" tail.
				const BATCH_MATCH_CAP = 500;
				const matched: TFile[] = [];
				let totalMatched = 0;
				await forEachMarkdown((file, content) => {
					if (!search(content)) return;
					totalMatched++;
					if (matched.length < BATCH_MATCH_CAP) matched.push(file);
				});

				if (matched.length === 0) return text("No files matched the query.");
				const truncationNote =
					totalMatched > BATCH_MATCH_CAP
						? `\n\n[showing first ${BATCH_MATCH_CAP} of ${totalMatched} matches — narrow the query to operate on more]`
						: "";

				if (dryRun) {
					const label = rawValue !== undefined ? `set ${property}` : `delete ${property}`;
					return text(
						`Dry run — would ${label} on ${matched.length} file(s):\n${matched.map((f) => f.path).join("\n")}${truncationNote}`,
					);
				}

				// Gate writes outside the configured write directory the same way
				// vault_modify does: writeVault → apply directly; writeReviewed →
				// hand to the batch-review modal; otherwise, if any target sits
				// outside the write dir, reject. Without this gate, `manage` users
				// with `mcpVaultWrites: "none"` could mutate frontmatter anywhere
				// in the vault via search query.
				const writeDir = getWriteDir();
				const outOfScope = matched.filter((f) => !isPathWithinDir(f.path, writeDir));
				if (outOfScope.length > 0) {
					if (!enabledTiers.has("writeVault") && !enabledTiers.has("writeReviewed")) {
						return error(
							`Refusing batch: ${outOfScope.length} of ${matched.length} matches are outside the write directory '${writeDir}'. Enable Vault-wide writes (or Reviewed writes) to operate here.`,
						);
					}
				}

				const value = rawValue !== undefined ? parseJsonOrString(rawValue) : undefined;

				let targets: TFile[] = matched;
				if (reviewBatchFn) {
					const items = matched.map((file) => {
						const oldFm = frontmatterSnapshot(file);
						let newFm: Record<string, unknown>;
						if (rawValue !== undefined) {
							newFm = { ...oldFm, [property]: value };
						} else {
							const { [property]: _dropped, ...rest } = oldFm;
							newFm = rest;
						}
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

				// Process in chunks. Obsidian serialises per-file internally; modest
				// concurrency across files cuts wall time for large batches without
				// triggering the per-file race window.
				const FRONTMATTER_CHUNK = 10;
				for (let i = 0; i < targets.length; i += FRONTMATTER_CHUNK) {
					const chunk = targets.slice(i, i + FRONTMATTER_CHUNK);
					await Promise.all(
						chunk.map((file) =>
							app.fileManager.processFrontMatter(file, (fm) => {
								if (rawValue !== undefined) {
									fm[property] = value;
								} else {
									delete fm[property];
								}
							}),
						),
					);
				}

				const label = rawValue !== undefined ? `Set ${property}` : `Deleted ${property}`;
				return text(`${label} on ${targets.length} file(s).${truncationNote}`);
			},
		}),
	);

	// ── Extensions tier (plugin integrations) ─────────

	registerExtensionTools(app, (tool) => tools.push(tool), getWriteDir, enabledTiers, reviewFn);

	// ── Agent tier ────────────────────────────────────

	tools.push(
		defineTool({
			name: "agent_status_set",
			tier: "agent",
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
			handler: async ({ status, sessionName, detail }) => {
				const name = (sessionName ?? "").trim() || DEFAULT_SESSION_KEY;
				onActivity?.({ sessionName: name, status, detail });
				return text("OK");
			},
		}),
	);

	return tools;
}
