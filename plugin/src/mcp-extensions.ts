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

type ToolPusher = (tool: McpToolDef) => void;

function text(str: string): { content: Array<{ type: "text"; text: string }> } {
	return { content: [{ type: "text", text: str }] };
}

function error(msg: string): {
	content: Array<{ type: "text"; text: string }>;
	isError: true;
} {
	return { content: [{ type: "text", text: msg }], isError: true };
}

function resolveCanvasFile(app: App, path: string): TFile | null {
	const f = app.vault.getFileByPath(path);
	if (!f || f.extension !== "canvas") return null;
	return f;
}

// ── Canvas ──────────────────────────────────────────

export function registerCanvasTools(app: App, push: ToolPusher): void {
	push({
		name: "vault_canvas_read",
		tier: "extensions",
		config: {
			title: "Read canvas",
			description:
				"Read a .canvas file and return its JSON structure: nodes (text/file/link/group) and edges. Works without any target plugin — `.canvas` is Obsidian's native format.",
			inputSchema: {
				path: z.string().describe("Canvas file path from vault root (.canvas extension)"),
			},
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
	});

	push({
		name: "vault_canvas_modify",
		tier: "extensions",
		config: {
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
	});
}

/** Register every plugin-integration tool whose target plugin is loaded. */
export function registerExtensionTools(app: App, push: ToolPusher): void {
	registerCanvasTools(app, push);
}
