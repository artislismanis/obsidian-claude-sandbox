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
import { TFile as TFileClass, moment } from "obsidian";
import { z } from "zod/v4";
import type { McpToolDef, PermissionTier, ReviewFn } from "./mcp-tools";
import { defineTool, text, error, gateVaultWrite, forEachMarkdownChunked } from "./mcp-tools";
import { logger, errMsg } from "./logger";
import { getInstalledPlugin } from "./obsidian-internals";
import { isPathWithinDir, isRealPathWithinBase } from "./validation";
import { getVaultBasePath, getVaultFullPath } from "./obsidian-internals";

/**
 * True when `vaultPath` is contained inside the vault directory. Mirrors the
 * mcp-tools.ts isVaultPathSafe helper (which is not exported). Used to block
 * traversal in user-controlled `format` strings that the moment formatter
 * could otherwise use to construct `../escape/foo.md`.
 */
function isVaultPathSafe(app: App, vaultPath: string): boolean {
	const base = getVaultBasePath(app);
	const full = getVaultFullPath(app, vaultPath);
	if (base === null || full === null) return true;
	return isRealPathWithinBase(base, full);
}

type ToolPusher = (tool: McpToolDef) => void;

export interface WriteGate {
	getWriteDir: () => string;
	enabledTiers: ReadonlySet<PermissionTier>;
	review: ReviewFn | undefined;
}

function resolveCanvasFile(app: App, path: string): TFile | null {
	const f = app.vault.getFileByPath(path);
	if (!f || f.extension !== "canvas") return null;
	return f;
}

/** Parse JSON with a label-prefixed error message; on success returns the value. */
function parseJsonLabelled<T = unknown>(
	raw: string,
	label: string,
): { ok: true; value: T } | { ok: false; error: string } {
	try {
		return { ok: true, value: JSON.parse(raw) as T };
	} catch (e: unknown) {
		return { ok: false, error: `${label}: ${errMsg(e)}` };
	}
}

// ── Canvas ──────────────────────────────────────────

// Canvas nodes / edges keep extra keys passthrough (Obsidian's canvas
// renderer carries plugin-private fields), but the *required* fields for
// a renderable node/edge are checked here. Without them the renderer
// either silently drops the node or shows a corrupt canvas. An empty
// object would have passed the previous `z.record(...)` schema; that's
// the case this guard closes.
const CanvasNodeSchema = z
	.object({
		id: z.string().min(1),
		type: z.string().min(1),
		x: z.number().optional(),
		y: z.number().optional(),
		width: z.number().optional(),
		height: z.number().optional(),
	})
	.catchall(z.unknown());
const CanvasEdgeSchema = z
	.object({
		id: z.string().min(1),
		fromNode: z.string().min(1),
		toNode: z.string().min(1),
	})
	.catchall(z.unknown());
const CanvasChangesSchema = z.object({
	addNodes: z.array(CanvasNodeSchema).optional(),
	removeNodeIds: z.array(z.string()).optional(),
	addEdges: z.array(CanvasEdgeSchema).optional(),
	removeEdgeIds: z.array(z.string()).optional(),
});
const CanvasDocSchema = z.object({
	nodes: z.array(CanvasNodeSchema).optional(),
	edges: z.array(CanvasEdgeSchema).optional(),
});

export function registerCanvasTools(app: App, push: ToolPusher, gate: WriteGate): void {
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

			handler: async ({ path }) => {
				const f = resolveCanvasFile(app, path);
				if (!f) return error("Canvas file not found (must end in .canvas).");
				const raw = await app.vault.cachedRead(f);
				const parsed = parseJsonLabelled(raw, "Canvas JSON parse failed");
				if (!parsed.ok) return error(parsed.error);
				return text(JSON.stringify(parsed.value, null, 2));
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

			handler: async ({ path, changes: changesRaw }) => {
				const f = resolveCanvasFile(app, path);
				if (!f) return error("Canvas file not found (must end in .canvas).");

				const parsedChanges = parseJsonLabelled(changesRaw, "Invalid JSON in 'changes'");
				if (!parsedChanges.ok) return error(parsedChanges.error);
				const validatedChanges = CanvasChangesSchema.safeParse(parsedChanges.value);
				if (!validatedChanges.success) {
					return error(`'changes' has invalid shape: ${validatedChanges.error.message}`);
				}
				const changes = validatedChanges.data;

				const raw = await app.vault.read(f);
				const parsedDoc = parseJsonLabelled(raw, "Existing canvas JSON parse failed");
				if (!parsedDoc.ok) return error(parsedDoc.error);
				const validatedDoc = CanvasDocSchema.safeParse(parsedDoc.value);
				if (!validatedDoc.success) {
					return error(`Canvas file has invalid shape: ${validatedDoc.error.message}`);
				}
				const doc = {
					nodes: validatedDoc.data.nodes ?? [],
					edges: validatedDoc.data.edges ?? [],
				};

				const stringId = (v: unknown): string | null => (typeof v === "string" ? v : null);

				const removeNodeIds = new Set(changes.removeNodeIds ?? []);
				if (removeNodeIds.size > 0) {
					doc.nodes = doc.nodes.filter((n) => {
						const id = stringId(n.id);
						return id === null || !removeNodeIds.has(id);
					});
					// Cascade: drop edges touching removed nodes
					doc.edges = doc.edges.filter((e) => {
						const from = stringId(e.fromNode);
						const to = stringId(e.toNode);
						if (from !== null && removeNodeIds.has(from)) return false;
						if (to !== null && removeNodeIds.has(to)) return false;
						return true;
					});
				}
				const removeEdgeIds = new Set(changes.removeEdgeIds ?? []);
				if (removeEdgeIds.size > 0) {
					doc.edges = doc.edges.filter((e) => {
						const id = stringId(e.id);
						return id === null || !removeEdgeIds.has(id);
					});
				}
				if (changes.addNodes) doc.nodes.push(...changes.addNodes);
				if (changes.addEdges) doc.edges.push(...changes.addEdges);

				const updated = JSON.stringify(doc, null, 2);
				const summary = [
					changes.addNodes?.length ? `+${changes.addNodes.length} nodes` : null,
					removeNodeIds.size ? `-${removeNodeIds.size} nodes` : null,
					changes.addEdges?.length ? `+${changes.addEdges.length} edges` : null,
					removeEdgeIds.size ? `-${removeEdgeIds.size} edges` : null,
				]
					.filter(Boolean)
					.join(", ");
				return gateVaultWrite({
					destPath: f.path,
					operation: "modify",
					description: `Modify canvas ${f.path} (${summary || "no-op"})`,
					writeDir: gate.getWriteDir(),
					enabledTiers: gate.enabledTiers,
					review: gate.review,
					oldContent: raw,
					newContent: updated,
					apply: () => app.vault.modify(f, updated),
					successMsg: `Modified ${f.path} (${summary || "no-op"}).`,
				});
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

			handler: async ({ query }) => {
				const dv = getDataview(app);
				if (!dv?.api?.query) return error("Dataview is not available.");
				try {
					const result = await dv.api.query(query);
					if (!result.successful) {
						return error(`Dataview query error: ${result.error ?? "(no message)"}`);
					}
					return text(JSON.stringify(result.value ?? null, null, 2));
				} catch (e: unknown) {
					const msg = errMsg(e);
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

const PRIORITY_EMOJI: Record<NonNullable<TaskEntry["priority"]>, string> = {
	highest: "🔺",
	high: "⏫",
	medium: "🔼",
	low: "🔽",
	lowest: "⏬",
};
const DATE_EMOJI = ["📅", "⏳", "🛫", "📆"] as const;
const PRIORITY_STRIP_RE = new RegExp(Object.values(PRIORITY_EMOJI).join("|"), "gu");
const DATE_STRIP_RE = new RegExp(`(?:${DATE_EMOJI.join("|")})\\s*\\d{4}-\\d{2}-\\d{2}`, "gu");

const DATE_FIELDS: { key: "due" | "scheduled" | "start"; re: RegExp }[] = (
	[
		["due", "📅"],
		["scheduled", "⏳"],
		["start", "🛫"],
	] as const
).map(([key, emoji]) => ({
	key,
	re: new RegExp(`(?:${emoji}|@${key}\\()\\s*(\\d{4}-\\d{2}-\\d{2})\\)?`),
}));

function parseTaskLine(rawLine: string): Omit<TaskEntry, "path" | "line"> | null {
	// Strip trailing CR (CRLF files) so the body and downstream regex captures
	// don't include the carriage return. Also accept zero whitespace after `]`
	// so empty checklist items (`- [ ]`) without a body still parse.
	const line = rawLine.replace(/\r$/, "");
	const m = /^\s*-\s*\[( |x|X)\]\s*(.*)$/.exec(line);
	if (!m) return null;
	const status: "open" | "done" = m[1].toLowerCase() === "x" ? "done" : "open";
	const body = m[2];

	const dates: Partial<Record<"due" | "scheduled" | "start", string>> = {};
	for (const { key, re } of DATE_FIELDS) {
		const v = re.exec(body)?.[1];
		if (v) dates[key] = v;
	}

	const priorityEntry = (
		Object.entries(PRIORITY_EMOJI) as [NonNullable<TaskEntry["priority"]>, string][]
	).find(([, emoji]) => body.includes(emoji));
	const priority: TaskEntry["priority"] = priorityEntry?.[0];

	const tags = [...body.matchAll(/#([\w/-]+)/g)].map((t) => `#${t[1]}`);

	const text = body.replace(DATE_STRIP_RE, "").replace(PRIORITY_STRIP_RE, "").trim();

	return { rawLine, status, text, ...dates, priority, tags };
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

			handler: async ({
				status: wantStatus = "open",
				tag: tagFilter,
				dueOnOrBefore: dueLimit,
				folder,
				limit = 100,
				priorityAtLeast: minPriority,
			}) => {
				const priorityOrder = ["lowest", "low", "medium", "high", "highest"] as const;
				const minIdx = minPriority ? priorityOrder.indexOf(minPriority) : -1;

				const files = app.vault
					.getMarkdownFiles()
					.filter((f) => !folder || isPathWithinDir(f.path, folder));

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

			handler: async ({ path, line }) => {
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
					const msg = errMsg(e);
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
			template: TFile | string | { path: string },
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

export function registerTemplaterTools(app: App, push: ToolPusher, gate: WriteGate): void {
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

			handler: async ({ template: templatePath, folder, filename }) => {
				const plugin = getTemplater(app);
				if (!plugin?.templater?.create_new_note_from_template)
					return error("Templater plugin is not available.");
				// Templater's API treats a string `template` arg inconsistently across
				// versions — in current builds it writes the string as literal content
				// instead of resolving it as a template file. Resolve to a TFile ourselves.
				const templateFile = app.vault.getAbstractFileByPath(templatePath);
				if (!templateFile || !(templateFile instanceof TFileClass))
					return error(
						`Template not found at '${templatePath}'. Pass a vault-relative path to a markdown template file.`,
					);
				// Reject path-traversal in user-supplied folder/filename — otherwise
				// Templater can write outside the gated destPath we compute below.
				if (folder !== undefined && (folder.includes("..") || folder.includes("\\"))) {
					return error("'folder' may not contain '..' or backslashes.");
				}
				if (filename !== undefined && /[/\\]|\.\./.test(filename)) {
					return error("'filename' may not contain slashes or '..'.");
				}
				// Predict Templater's destination path so we can gate before it writes.
				// Templater itself provides no pre-flight API; replicate its naming:
				// `<folder>/<filename>.md`, falling back to the template's basename and
				// vault root when either is omitted.
				const destFolder = (folder ?? "").replace(/^\/+|\/+$/g, "");
				const destName = filename ?? (templateFile as TFile).basename;
				const destPath = destFolder ? `${destFolder}/${destName}.md` : `${destName}.md`;
				return gateVaultWrite({
					destPath,
					operation: "create",
					description: `Create ${destPath} from template ${templatePath}`,
					writeDir: gate.getWriteDir(),
					enabledTiers: gate.enabledTiers,
					review: gate.review,
					apply: async () => {
						const created = await plugin.templater!.create_new_note_from_template!(
							templateFile,
							folder,
							filename,
							false,
						);
						if (!created) throw new Error("Templater returned no file.");
						// Templater templates can call `tp.file.move(...)` from inside
						// the script section to relocate the file AFTER creation,
						// which would silently escape the destPath we gated on above.
						// Post-validate the actual path: if Templater moved the file
						// somewhere we wouldn't have allowed, delete the file and
						// fail. This trades a small UX cost (templates that
						// legitimately use tp.file.move stop working through this
						// tool) for the guarantee that no template can write outside
						// the gated scope.
						if (created.path !== destPath) {
							try {
								await app.vault.trash(created, true);
							} catch {
								/* fall through and surface the error anyway */
							}
							throw new Error(
								`Template relocated the file from '${destPath}' to '${created.path}' (likely via tp.file.move). Refusing to escape the gated path.`,
							);
						}
					},
					successMsg: `Created ${destPath}`,
				});
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
export function registerPeriodicNotesTools(app: App, push: ToolPusher, gate: WriteGate): void {
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

			handler: async ({ periodicity, date: dateArg, create = false }) => {
				const plugin = getPeriodicNotes(app);
				if (!plugin) return error("Periodic Notes plugin is not installed or enabled.");
				const raw = plugin as Record<string, unknown>;
				const settings =
					(raw.instance as Record<string, unknown> | undefined)?.settings ??
					(raw.settings as Record<string, unknown> | undefined);
				if (!settings) {
					logger.error(
						"Extensions",
						"periodic-notes: found plugin but no settings. Top-level keys:",
						Object.keys(raw),
					);
					return error(
						"Periodic Notes plugin found but settings structure is unexpected. Check DevTools for details.",
					);
				}

				const periodicSettings = (settings as Record<string, unknown>)[periodicity] as
					| { enabled?: boolean; folder?: string; format?: string; template?: string }
					| undefined;
				if (!periodicSettings || periodicSettings.enabled === false)
					return error(`Periodic Notes: ${periodicity} is not enabled.`);

				// Parse via moment in strict mode so weekly/quarterly tokens that depend on
				// the input date don't shift across local-TZ DST boundaries (which
				// `new Date(dateArg + "T00:00:00")` does in non-UTC locales).
				// Trim the input — moment strict mode treats " 2024-01-01" as invalid.
				const m = dateArg ? moment(dateArg.trim(), "YYYY-MM-DD", true) : moment();
				if (!m.isValid()) return error(`Invalid date: ${dateArg}`);

				const filename = m.format(periodicSettings.format || defaultFormat(periodicity));
				const folder = (periodicSettings.folder || "").replace(/^\/+|\/+$/g, "");
				const path = folder ? `${folder}/${filename}.md` : `${filename}.md`;

				// The format string is plugin-controlled but moment passes
				// through any non-token characters verbatim — including `/` and
				// `..`. Reject paths whose realpath escapes the vault before we
				// touch the filesystem.
				if (!isVaultPathSafe(app, path)) {
					return error(
						`Periodic note path '${path}' resolves outside the vault. Check the Periodic Notes format setting for path-traversal characters.`,
					);
				}

				const existing = app.vault.getFileByPath(path);
				if (existing) return text(`Exists: ${path}`);
				if (!create) return error(`Not found: ${path}`);

				// Use Templater's API if available — it processes tp.* variables.
				// Falls back to raw template content if Templater isn't installed.
				const templater = getTemplater(app);
				const tmplPath = periodicSettings.template;
				const tmplFile = tmplPath ? app.vault.getFileByPath(tmplPath) : null;

				if (templater?.templater?.create_new_note_from_template && tmplFile) {
					const folderParts = path.split("/");
					const noteName = folderParts.pop()!.replace(/\.md$/, "");
					const noteFolder = folderParts.join("/") || "/";
					// Read the raw template so the review modal shows the seed content
					// the user is approving. Templater will additionally process tp.*
					// tokens at apply time — that's a known difference noted in the
					// description.
					const rawSeed = await app.vault.cachedRead(tmplFile);
					return gateVaultWrite({
						destPath: path,
						operation: "create",
						description: `Create periodic note ${path} (via Templater — tp.* tokens applied at write time)`,
						writeDir: gate.getWriteDir(),
						enabledTiers: gate.enabledTiers,
						review: gate.review,
						newContent: rawSeed,
						apply: async () => {
							await templater.templater!.create_new_note_from_template!(
								tmplFile,
								noteFolder,
								noteName,
								false,
							);
							// Mirror vault_templater_create's post-validate: a template
							// that calls `tp.file.move(...)` from its script section can
							// relocate the file outside the gated destPath. Detect the
							// mismatch, trash the escaped file, and surface an error so
							// no template can side-channel writes past the review gate.
							const created = app.vault.getFileByPath(path);
							if (!created) {
								const actual = app.vault
									.getMarkdownFiles()
									.find((f) => f.basename === noteName);
								if (actual) {
									try {
										await app.vault.trash(actual, true);
									} catch {
										/* surface the relocation error anyway */
									}
									throw new Error(
										`Template relocated the periodic note from '${path}' to '${actual.path}' (likely via tp.file.move). Refusing to escape the gated path.`,
									);
								}
								throw new Error(`Templater did not produce a file at '${path}'.`);
							}
						},
						successMsg: `Created ${path} (Templater processed)`,
					});
				}

				let seed = "";
				if (tmplFile) {
					seed = await app.vault.read(tmplFile);
				}
				return gateVaultWrite({
					destPath: path,
					operation: "create",
					description: `Create periodic note ${path}`,
					writeDir: gate.getWriteDir(),
					enabledTiers: gate.enabledTiers,
					review: gate.review,
					newContent: seed,
					apply: () => app.vault.create(path, seed),
					successMsg: `Created ${path}`,
				});
			},
		}),
	);
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
export function registerExtensionTools(
	app: App,
	push: ToolPusher,
	getWriteDir: () => string,
	enabledTiers: ReadonlySet<PermissionTier>,
	review: ReviewFn | undefined,
): void {
	const gate: WriteGate = { getWriteDir, enabledTiers, review };
	registerCanvasTools(app, push, gate);
	registerDataviewTools(app, push);
	registerTasksTools(app, push);
	registerTemplaterTools(app, push, gate);
	registerPeriodicNotesTools(app, push, gate);
	registerExtensionsIntrospection(app, push);
}
