/**
 * Templater plugin integration for agent-driven file creation.
 *
 * Templater's built-in folder-template hook calls
 * `append_template_to_active_file`, which fails when there is no active editor
 * — exactly the situation when MCP tools create files programmatically. We
 * sidestep that path by calling Templater's editor-free
 * `write_template_to_file` directly, and by suppressing the create hook around
 * our writes so its "no active editor" notice doesn't fire.
 *
 * This module talks to a third-party plugin via untyped fields, so the shape
 * we depend on lives here as a single contract.
 */

import type { App, TFile } from "obsidian";
import { logger } from "./logger";
import { getInstalledPlugin } from "./obsidian-internals";
import { isPathWithinDir } from "./validation";

interface TemplaterPlugin {
	settings?: {
		enable_folder_templates?: boolean;
		trigger_on_file_creation?: boolean;
		folder_templates?: Array<{ folder?: string; template?: string }>;
	};
	templater?: {
		write_template_to_file: (templateFile: TFile, file: TFile) => Promise<void>;
		// Templater exposes `parse_template` (renders a template string against a
		// running config) on the same object. Used to pre-resolve the rendered
		// body so review modals can show what will actually be written.
		parse_template?: (
			config: { target_file: TFile; run_mode: number; active_file?: TFile | null },
			template_content: string,
		) => Promise<string>;
	};
}

/**
 * Resolve which folder template would apply to a freshly-created file at
 * `targetPath`. Returns the template TFile or null. Decoupled from
 * applyTemplaterFolderTemplate so callers can render a preview without
 * actually creating the file.
 */
export function findTemplaterFolderTemplate(app: App, targetPath: string): TFile | null {
	const tp = getTemplaterPlugin(app);
	if (!tp?.settings?.enable_folder_templates) return null;
	const folderTemplates = tp.settings.folder_templates ?? [];
	const slash = targetPath.lastIndexOf("/");
	const dir = slash >= 0 ? targetPath.slice(0, slash) : "";
	let best: { template: string; len: number } | null = null;
	for (const ft of folderTemplates) {
		if (!ft.folder || !ft.template) continue;
		const folder = ft.folder === "/" ? "" : ft.folder.replace(/\/$/, "");
		const matches = folder === "" || isPathWithinDir(dir, folder);
		if (!matches) continue;
		const len = folder.length;
		if (!best || len > best.len) best = { template: ft.template, len };
	}
	if (!best) return null;
	return app.vault.getFileByPath(best.template);
}

/**
 * Read the raw body of the matching folder template, without rendering. The
 * review modal shows this verbatim — Templater placeholders like `<% tp.date.now() %>`
 * remain visible. Rendering before user approval would require creating the
 * target file, defeating the review gate.
 */
export async function previewTemplaterFolderTemplate(
	app: App,
	targetPath: string,
): Promise<string | null> {
	const tplFile = findTemplaterFolderTemplate(app, targetPath);
	if (!tplFile) return null;
	try {
		return await app.vault.cachedRead(tplFile);
	} catch {
		return null;
	}
}

function getTemplaterPlugin(app: App): TemplaterPlugin | null {
	return getInstalledPlugin<TemplaterPlugin>(app, "templater-obsidian");
}

/**
 * Apply the matching Templater folder template to a freshly created file.
 *
 * Returns the template's vault path on success, or null if no template
 * matched (or Templater isn't installed/enabled).
 */
export async function applyTemplaterFolderTemplate(app: App, file: TFile): Promise<string | null> {
	const tp = getTemplaterPlugin(app);
	if (!tp?.templater || !tp.settings?.enable_folder_templates) return null;
	const folderTemplates = tp.settings.folder_templates ?? [];
	const dir = file.parent?.path ?? "";
	// Longest-prefix wins, matching Templater's own resolution.
	let best: { folder: string; template: string; len: number } | null = null;
	for (const ft of folderTemplates) {
		if (!ft.folder || !ft.template) continue;
		const folder = ft.folder === "/" ? "" : ft.folder.replace(/\/$/, "");
		const matches = folder === "" || isPathWithinDir(dir, folder);
		if (!matches) continue;
		const len = folder.length;
		if (!best || len > best.len) best = { folder: ft.folder, template: ft.template, len };
	}
	if (!best) return null;
	const tplFile = app.vault.getFileByPath(best.template);
	if (!tplFile) return null;
	try {
		await tp.templater.write_template_to_file(tplFile, file);
		return tplFile.path;
	} catch (e) {
		logger.error("templater", "folder-template application failed", e);
		return null;
	}
}

/**
 * Run `fn` with Templater's create-hook setting flipped off, restoring the
 * prior value afterwards. Without this, our `vault.create` calls would
 * trigger Templater's "no active editor" notice; we apply templates ourselves
 * via `applyTemplaterFolderTemplate`, so the hook is pure noise.
 *
 * Refcounted so concurrent `vault_create` calls compose safely: we capture
 * the original value on the first entry, force-disable the hook for the whole
 * critical section, and restore only when the last in-flight call exits. A
 * naive save/restore pair would let the second concurrent call snapshot the
 * already-disabled `false` and "restore" that on its way out, permanently
 * disabling the hook.
 */
let templaterSuppressDepth = 0;
let templaterSuppressPrev: boolean | undefined;

/**
 * Reset the suppression counter on plugin load. The depth/prev state lives at
 * module scope and survives across Obsidian's plugin enable/disable cycles
 * (modules are cached). Without this, a plugin unload that races a mid-flight
 * vault_create_with_template leaves `trigger_on_file_creation = false` on
 * Templater's settings until next Obsidian restart — the user's hook is
 * permanently disabled. main.ts calls this on every onload, parallel to
 * resetTerminalConnectionLog().
 */
export function resetTemplaterSuppression(): void {
	templaterSuppressDepth = 0;
	templaterSuppressPrev = undefined;
}

export async function withTemplaterHookSuppressed<T>(app: App, fn: () => Promise<T>): Promise<T> {
	const tp = getTemplaterPlugin(app);
	if (!tp?.settings) return fn();
	if (templaterSuppressDepth === 0) {
		templaterSuppressPrev = tp.settings.trigger_on_file_creation;
	}
	templaterSuppressDepth++;
	tp.settings.trigger_on_file_creation = false;
	try {
		return await fn();
	} finally {
		templaterSuppressDepth--;
		if (templaterSuppressDepth === 0) {
			tp.settings.trigger_on_file_creation = templaterSuppressPrev;
			templaterSuppressPrev = undefined;
		}
	}
}
