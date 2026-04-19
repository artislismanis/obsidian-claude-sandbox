/**
 * Plugin API integrations — MCP tools that delegate to other installed
 * Obsidian plugins. Each integration registers its tools only when its
 * target plugin is loaded; missing plugins mean the tool is absent from
 * the tool list, not present-but-erroring.
 *
 * Canvas is the exception: `.canvas` files are native Obsidian JSON, so
 * the read/modify tools work without any target plugin installed.
 */

import type { App, TFile } from "obsidian";
import { z } from "zod/v4";
import type { McpToolDef } from "./mcp-tools";
import { defineTool, text, error } from "./mcp-tools";

type ToolPusher = (tool: McpToolDef) => void;

type PluginsHost = {
	plugins: {
		getPlugin?: (id: string) => unknown;
		plugins?: Record<string, unknown>;
		enabledPlugins?: Set<string>;
	};
};

/**
 * Look up an installed + enabled plugin by id. Returns null when the plugin
 * isn't installed, isn't enabled, or the host shape isn't what we expect.
 * Centralises the runtime shape check every integration would otherwise
 * duplicate.
 */
function getInstalledPlugin<T>(app: App, pluginId: string): T | null {
	const host = (app as unknown as PluginsHost).plugins;
	if (!host) return null;
	if (host.enabledPlugins && !host.enabledPlugins.has(pluginId)) return null;
	const plugin = host.getPlugin?.(pluginId) ?? (host.plugins && host.plugins[pluginId]) ?? null;
	return (plugin as T | null) ?? null;
}

/**
 * Parallel-chunked iteration over markdown files, short-circuiting when the
 * handler returns `true`. Mirrors the helper in mcp-tools.ts; kept separate
 * here so extensions don't cross-import private helpers from the main tool
 * module.
 */
async function forEachMarkdownChunked(
	app: App,
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

function resolveCanvasFile(app: App, path: string): TFile | null {
	const f = app.vault.getFileByPath(path);
	if (!f || f.extension !== "canvas") return null;
	return f;
}

// ── Canvas ──────────────────────────────────────────

export function registerCanvasTools(app: App, push: ToolPusher): void {
	push(
		defineTool({
			name: "vault_canvas_read",
			tier: "extensions",
			title: "Read canvas",
			description:
				"Read a .canvas file and return its JSON structure: nodes (text/file/link/group) and edges. Works without any target plugin — `.canvas` is Obsidian's native format.",
			inputSchema: {
				path: z.string().describe("Canvas file path from vault root (.canvas extension)"),
			},

			handler: async (args) => {
				const path = args.path as string;
				const f = resolveCanvasFile(app, path);
				if (!f) return error("Canvas file not found (must end in .canvas).");
				const raw = await app.vault.read(f);
				try {
					const parsed = JSON.parse(raw);
					return text(JSON.stringify(parsed, null, 2));
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					return error(`Canvas JSON parse failed: ${msg}`);
				}
			},
		}),
	);

	push(
		defineTool({
			name: "vault_canvas_modify",
			tier: "extensions",
			title: "Modify canvas",
			description:
				"Apply changes to a .canvas file. Supports adding or removing nodes and edges. The `changes` payload is a JSON object with optional `addNodes`, `removeNodeIds`, `addEdges`, `removeEdgeIds` arrays.",
			inputSchema: {
				path: z.string().describe("Canvas file path from vault root"),
				changes: z
					.string()
					.describe(
						"JSON: { addNodes?: CanvasNode[]; removeNodeIds?: string[]; addEdges?: CanvasEdge[]; removeEdgeIds?: string[] }",
					),
			},

			handler: async (args) => {
				const path = args.path as string;
				const changesRaw = args.changes as string;
				const f = resolveCanvasFile(app, path);
				if (!f) return error("Canvas file not found (must end in .canvas).");

				let changes: {
					addNodes?: Array<Record<string, unknown>>;
					removeNodeIds?: string[];
					addEdges?: Array<Record<string, unknown>>;
					removeEdgeIds?: string[];
				};
				try {
					changes = JSON.parse(changesRaw);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					return error(`Invalid JSON in 'changes': ${msg}`);
				}

				const raw = await app.vault.read(f);
				let doc: {
					nodes?: Array<Record<string, unknown>>;
					edges?: Array<Record<string, unknown>>;
				};
				try {
					doc = JSON.parse(raw);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					return error(`Existing canvas JSON parse failed: ${msg}`);
				}

				doc.nodes ??= [];
				doc.edges ??= [];

				const removeNodeIds = new Set(changes.removeNodeIds ?? []);
				if (removeNodeIds.size > 0) {
					doc.nodes = doc.nodes.filter((n) => !removeNodeIds.has(n.id as string));
					// Cascade: drop edges touching removed nodes
					doc.edges = doc.edges.filter(
						(e) =>
							!removeNodeIds.has(e.fromNode as string) &&
							!removeNodeIds.has(e.toNode as string),
					);
				}
				const removeEdgeIds = new Set(changes.removeEdgeIds ?? []);
				if (removeEdgeIds.size > 0) {
					doc.edges = doc.edges.filter((e) => !removeEdgeIds.has(e.id as string));
				}
				if (changes.addNodes) doc.nodes.push(...changes.addNodes);
				if (changes.addEdges) doc.edges.push(...changes.addEdges);

				await app.vault.modify(f, JSON.stringify(doc, null, 2));
				const summary = [
					changes.addNodes?.length ? `+${changes.addNodes.length} nodes` : null,
					removeNodeIds.size ? `-${removeNodeIds.size} nodes` : null,
					changes.addEdges?.length ? `+${changes.addEdges.length} edges` : null,
					removeEdgeIds.size ? `-${removeEdgeIds.size} edges` : null,
				]
					.filter(Boolean)
					.join(", ");
				return text(`Modified ${f.path} (${summary || "no-op"}).`);
			},
		}),
	);
}

// ── Dataview ────────────────────────────────────────

interface DataviewQueryResult {
	successful: boolean;
	value?: unknown;
	error?: string;
}

interface DataviewPlugin {
	api?: {
		query?: (source: string) => Promise<DataviewQueryResult> | DataviewQueryResult;
	};
}

/** Recognise an installed+enabled Dataview. Narrow runtime shape check. */
function getDataview(app: App): DataviewPlugin | null {
	const plugin = getInstalledPlugin<DataviewPlugin>(app, "dataview");
	if (!plugin?.api || typeof plugin.api.query !== "function") return null;
	return plugin;
}

export function registerDataviewTools(app: App, push: ToolPusher): void {
	if (!getDataview(app)) return;
	push(
		defineTool({
			name: "vault_dataview_query",
			tier: "extensions",
			title: "Dataview query",
			description:
				"Run a Dataview Query Language (DQL) query against the vault. Requires the Dataview plugin to be installed and enabled. Returns the serialized result.",
			inputSchema: {
				query: z
					.string()
					.describe("Full DQL source (e.g. 'TABLE rating FROM #book SORT rating DESC')"),
			},

			handler: async (args) => {
				const query = args.query as string;
				const dv = getDataview(app);
				if (!dv?.api?.query) return error("Dataview is not available.");
				try {
					const result = await dv.api.query(query);
					if (!result.successful) {
						return error(`Dataview query error: ${result.error ?? "(no message)"}`);
					}
					return text(JSON.stringify(result.value ?? null, null, 2));
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					return error(`Dataview threw: ${msg}`);
				}
			},
		}),
	);
}

// ── Tasks ───────────────────────────────────────────

interface TasksApi {
	executeToggleTaskDoneCommand?: (line: string, path: string) => string;
}

interface TasksPlugin {
	apiV1?: TasksApi;
}

function getTasks(app: App): TasksPlugin | null {
	return getInstalledPlugin<TasksPlugin>(app, "obsidian-tasks-plugin");
}

interface TaskEntry {
	path: string;
	line: number;
	rawLine: string;
	status: "open" | "done";
	text: string;
	due?: string;
	scheduled?: string;
	start?: string;
	priority?: "highest" | "high" | "medium" | "low" | "lowest";
	tags: string[];
}

function parseTaskLine(rawLine: string): Omit<TaskEntry, "path" | "line"> | null {
	const m = /^\s*-\s*\[( |x|X)\]\s+(.*)$/.exec(rawLine);
	if (!m) return null;
	const status: "open" | "done" = m[1].toLowerCase() === "x" ? "done" : "open";
	const body = m[2];

	const due = /(?:📅|@due\()\s*(\d{4}-\d{2}-\d{2})\)?/.exec(body)?.[1];
	const scheduled = /(?:⏳|@scheduled\()\s*(\d{4}-\d{2}-\d{2})\)?/.exec(body)?.[1];
	const start = /(?:🛫|@start\()\s*(\d{4}-\d{2}-\d{2})\)?/.exec(body)?.[1];
	let priority: TaskEntry["priority"];
	if (body.includes("🔺")) priority = "highest";
	else if (body.includes("⏫")) priority = "high";
	else if (body.includes("🔼")) priority = "medium";
	else if (body.includes("🔽")) priority = "low";
	else if (body.includes("⏬")) priority = "lowest";

	const tags = [...body.matchAll(/#([\w/-]+)/g)].map((t) => `#${t[1]}`);

	// Strip trailing tokens from display text
	const text = body
		.replace(/(?:📅|⏳|🛫|📆)\s*\d{4}-\d{2}-\d{2}/g, "")
		.replace(/\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC}/gu, "")
		.trim();

	return { rawLine, status, text, due, scheduled, start, priority, tags };
}

export function registerTasksTools(app: App, push: ToolPusher): void {
	if (!getTasks(app)) return;

	push(
		defineTool({
			name: "vault_tasks_query",
			tier: "extensions",
			title: "Query tasks",
			description:
				"Scan markdown files for Tasks-format checklist items and filter by status / due date / priority / tag. Requires the Tasks plugin to be installed and enabled.",
			inputSchema: {
				status: z
					.enum(["open", "done", "any"])
					.optional()
					.describe("Filter by status (default: open)"),
				tag: z.string().optional().describe("Filter by a #tag (case-sensitive)"),
				dueOnOrBefore: z
					.string()
					.optional()
					.describe("ISO date (YYYY-MM-DD). Keep only tasks due on or before this date."),
				priorityAtLeast: z
					.enum(["lowest", "low", "medium", "high", "highest"])
					.optional()
					.describe("Keep only tasks with this priority or higher"),
				folder: z.string().optional().describe("Restrict scan to a folder prefix"),
				limit: z.number().optional().describe("Max results (default 100)"),
			},

			handler: async (args) => {
				const wantStatus = (args.status as "open" | "done" | "any" | undefined) ?? "open";
				const tagFilter = args.tag as string | undefined;
				const dueLimit = args.dueOnOrBefore as string | undefined;
				const folder = args.folder as string | undefined;
				const limit = (args.limit as number | undefined) ?? 100;
				const priorityOrder = ["lowest", "low", "medium", "high", "highest"] as const;
				const minPriority = args.priorityAtLeast as TaskEntry["priority"] | undefined;
				const minIdx = minPriority ? priorityOrder.indexOf(minPriority) : -1;

				const files = app.vault
					.getMarkdownFiles()
					.filter((f) => !folder || f.path.startsWith(folder + "/") || f.path === folder);

				const results: TaskEntry[] = [];
				await forEachMarkdownChunked(
					app,
					(file, content) => {
						const lines = content.split("\n");
						for (let i = 0; i < lines.length; i++) {
							const parsed = parseTaskLine(lines[i]);
							if (!parsed) continue;
							if (wantStatus !== "any" && parsed.status !== wantStatus) continue;
							if (tagFilter && !parsed.tags.includes(tagFilter)) continue;
							if (dueLimit && parsed.due && parsed.due > dueLimit) continue;
							if (dueLimit && !parsed.due) continue;
							if (minIdx >= 0) {
								const pIdx = parsed.priority
									? priorityOrder.indexOf(parsed.priority)
									: -1;
								if (pIdx < minIdx) continue;
							}
							results.push({ ...parsed, path: file.path, line: i + 1 });
							if (results.length >= limit) return true;
						}
					},
					files,
				);

				if (results.length === 0) return text("(no matching tasks)");
				const body = results
					.map((r) => {
						const meta: string[] = [];
						if (r.due) meta.push(`due ${r.due}`);
						if (r.scheduled) meta.push(`scheduled ${r.scheduled}`);
						if (r.priority) meta.push(r.priority);
						if (r.tags.length) meta.push(r.tags.join(" "));
						const metaStr = meta.length ? ` [${meta.join(", ")}]` : "";
						return `${r.path}:${r.line}  [${r.status === "done" ? "x" : " "}] ${r.text}${metaStr}`;
					})
					.join("\n");
				return text(body);
			},
		}),
	);

	push(
		defineTool({
			name: "vault_tasks_toggle",
			tier: "extensions",
			title: "Toggle task",
			description:
				"Toggle a checklist item between done and open at a specific file:line. Delegates to the Tasks plugin's apiV1.executeToggleTaskDoneCommand so it applies the plugin's full done-handling (recurring tasks, done-date, etc).",
			inputSchema: {
				path: z.string().describe("File path from vault root"),
				line: z.number().describe("1-based line number of the task"),
			},

			handler: async (args) => {
				const path = args.path as string;
				const line = args.line as number;
				const plugin = getTasks(app);
				if (!plugin?.apiV1?.executeToggleTaskDoneCommand)
					return error("Tasks plugin is not available.");
				const f = app.vault.getFileByPath(path);
				if (!f) return error(`File not found: ${path}`);
				const content = await app.vault.read(f);
				const lines = content.split("\n");
				const targetIdx = line - 1;
				if (targetIdx < 0 || targetIdx >= lines.length)
					return error(`Line ${line} is out of range (1-${lines.length}).`);
				const originalLine = lines[targetIdx];
				if (!/^\s*-\s*\[.\]/.test(originalLine))
					return error(`Line ${line} is not a checklist item.`);
				try {
					const updated = plugin.apiV1.executeToggleTaskDoneCommand(originalLine, path);
					if (typeof updated !== "string")
						return error("Tasks plugin returned an unexpected value.");
					if (updated === originalLine) return text(`No change at ${path}:${line}.`);
					// Tasks may return multi-line output when splitting recurring tasks.
					const newBlock = updated.replace(/\n$/, "");
					const newLines = [
						...lines.slice(0, targetIdx),
						...newBlock.split("\n"),
						...lines.slice(targetIdx + 1),
					];
					await app.vault.modify(f, newLines.join("\n"));
					return text(`Toggled ${path}:${line}.`);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					return error(`Tasks plugin threw: ${msg}`);
				}
			},
		}),
	);
}

// ── Templater ───────────────────────────────────────

interface TemplaterApi {
	templater?: {
		create_new_note_from_template?: (
			template: string | { path: string },
			folder?: string | { path: string },
			filename?: string,
			openNewNote?: boolean,
		) => Promise<TFile | undefined>;
	};
}

function getTemplater(app: App): TemplaterApi | null {
	const plugin = getInstalledPlugin<TemplaterApi>(app, "templater-obsidian");
	if (!plugin?.templater || typeof plugin.templater.create_new_note_from_template !== "function")
		return null;
	return plugin;
}

export function registerTemplaterTools(app: App, push: ToolPusher): void {
	if (!getTemplater(app)) return;
	push(
		defineTool({
			name: "vault_templater_create",
			tier: "extensions",
			title: "Create from Templater template",
			description:
				"Create a new note from a Templater template. Requires the Templater plugin. The template path is resolved by Templater itself (it respects the plugin's configured templates folder).",
			inputSchema: {
				template: z.string().describe("Template path (e.g. 'Templates/daily.md')"),
				folder: z.string().optional().describe("Destination folder (default: vault root)"),
				filename: z.string().optional().describe("Output filename without extension"),
			},

			handler: async (args) => {
				const plugin = getTemplater(app);
				if (!plugin?.templater?.create_new_note_from_template)
					return error("Templater plugin is not available.");
				const template = args.template as string;
				const folder = args.folder as string | undefined;
				const filename = args.filename as string | undefined;
				try {
					const created = await plugin.templater.create_new_note_from_template(
						template,
						folder,
						filename,
						false,
					);
					if (!created) return error("Templater returned no file (template not found?).");
					return text(`Created ${created.path}`);
				} catch (e: unknown) {
					const msg = e instanceof Error ? e.message : String(e);
					return error(`Templater threw: ${msg}`);
				}
			},
		}),
	);
}

// ── Periodic Notes ──────────────────────────────────

type Periodicity = "daily" | "weekly" | "monthly" | "quarterly" | "yearly";

interface PeriodicNotesPlugin {
	instance?: {
		settings?: Record<Periodicity, unknown>;
	};
}

function getPeriodicNotes(app: App): PeriodicNotesPlugin | null {
	return getInstalledPlugin<PeriodicNotesPlugin>(app, "periodic-notes");
}

/**
 * Access Periodic Notes. The plugin's public API historically lives as a
 * global `window.app.plugins.plugins["periodic-notes"]` but its helper
 * functions are re-exported from `obsidian-daily-notes-interface` via the
 * plugin. Rather than hard-binding to an internal API, we compute the note
 * path from the plugin's stored settings (folder + format) and either open
 * the file or create it via the vault API.
 */
export function registerPeriodicNotesTools(app: App, push: ToolPusher): void {
	if (!getPeriodicNotes(app)) return;

	push(
		defineTool({
			name: "vault_periodic_note",
			tier: "extensions",
			title: "Periodic note access",
			description:
				"Locate (and optionally create) a periodic note — daily/weekly/monthly/quarterly/yearly. Requires the Periodic Notes plugin. Returns the file path; if `create` is true and the note doesn't exist, an empty file is created in the plugin-configured folder.",
			inputSchema: {
				periodicity: z
					.enum(["daily", "weekly", "monthly", "quarterly", "yearly"])
					.describe("Which periodic note to resolve"),
				date: z.string().optional().describe("ISO date (YYYY-MM-DD). Defaults to today."),
				create: z.boolean().optional().describe("Create if missing (default false)"),
			},

			handler: async (args) => {
				const plugin = getPeriodicNotes(app);
				if (!plugin?.instance?.settings)
					return error("Periodic Notes plugin is not available.");
				const periodicity = args.periodicity as Periodicity;
				const dateArg = args.date as string | undefined;
				const create = (args.create as boolean | undefined) ?? false;

				const settings = plugin.instance.settings[periodicity] as
					| { enabled?: boolean; folder?: string; format?: string; template?: string }
					| undefined;
				if (!settings || settings.enabled === false)
					return error(`Periodic Notes: ${periodicity} is not enabled.`);

				const date = dateArg ? new Date(dateArg + "T00:00:00") : new Date();
				if (isNaN(date.getTime())) return error(`Invalid date: ${dateArg}`);

				const filename = formatDateByPattern(
					date,
					settings.format || defaultFormat(periodicity),
				);
				const folder = (settings.folder || "").replace(/^\/+|\/+$/g, "");
				const path = folder ? `${folder}/${filename}.md` : `${filename}.md`;

				const existing = app.vault.getFileByPath(path);
				if (existing) return text(`Exists: ${path}`);
				if (!create) return error(`Not found: ${path}`);

				// Seed with template if Periodic Notes has one configured.
				let seed = "";
				if (settings.template) {
					const tmplFile = app.vault.getFileByPath(settings.template);
					if (tmplFile) {
						seed = await app.vault.read(tmplFile);
					}
				}
				await app.vault.create(path, seed);
				return text(`Created ${path}`);
			},
		}),
	);
}

function pad(n: number): string {
	return n.toString().padStart(2, "0");
}

function defaultFormat(p: Periodicity): string {
	switch (p) {
		case "daily":
			return "YYYY-MM-DD";
		case "weekly":
			return "gggg-[W]ww";
		case "monthly":
			return "YYYY-MM";
		case "quarterly":
			return "YYYY-[Q]Q";
		case "yearly":
			return "YYYY";
	}
}

/** Minimal moment.js-like date formatter — supports the tokens Periodic Notes uses. */
function formatDateByPattern(date: Date, pattern: string): string {
	const y = date.getFullYear();
	const m = date.getMonth() + 1;
	const d = date.getDate();
	const w = getIsoWeek(date);
	const q = Math.floor((m - 1) / 3) + 1;
	return pattern.replace(/\[([^\]]+)\]|YYYY|gggg|MM|DD|ww|Q/g, (match, literal) => {
		if (literal) return literal;
		switch (match) {
			case "YYYY":
			case "gggg":
				return String(y);
			case "MM":
				return pad(m);
			case "DD":
				return pad(d);
			case "ww":
				return pad(w);
			case "Q":
				return String(q);
			default:
				return match;
		}
	});
}

function getIsoWeek(date: Date): number {
	const target = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
	const dayNr = (target.getUTCDay() + 6) % 7;
	target.setUTCDate(target.getUTCDate() - dayNr + 3);
	const firstThursday = new Date(Date.UTC(target.getUTCFullYear(), 0, 4));
	const diff = (target.getTime() - firstThursday.getTime()) / 86400000;
	return 1 + Math.round((diff - 3 + ((firstThursday.getUTCDay() + 6) % 7)) / 7);
}

// ── Discovery / introspection ───────────────────────

export function registerExtensionsIntrospection(app: App, push: ToolPusher): void {
	push(
		defineTool({
			name: "plugin_extensions_list",
			tier: "extensions",
			title: "List enabled extensions",
			description:
				"Report which plugin integrations the MCP server has registered tools for (Canvas, Dataview, Tasks, Templater, Periodic Notes). Useful when an agent is unsure whether a target plugin is available.",
			inputSchema: {},

			handler: async () => {
				const lines: string[] = [];
				lines.push(`canvas: always (native format)`);
				lines.push(`dataview: ${getDataview(app) ? "enabled" : "not available"}`);
				lines.push(`tasks: ${getTasks(app) ? "enabled" : "not available"}`);
				lines.push(`templater: ${getTemplater(app) ? "enabled" : "not available"}`);
				lines.push(
					`periodic-notes: ${getPeriodicNotes(app) ? "enabled" : "not available"}`,
				);
				return text(lines.join("\n"));
			},
		}),
	);
}

/** Register every plugin-integration tool whose target plugin is loaded. */
export function registerExtensionTools(app: App, push: ToolPusher): void {
	registerCanvasTools(app, push);
	registerDataviewTools(app, push);
	registerTasksTools(app, push);
	registerTemplaterTools(app, push);
	registerPeriodicNotesTools(app, push);
	registerExtensionsIntrospection(app, push);
}
