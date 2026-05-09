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
import { getLoadedPlugin } from "./obsidian-internals";
import { isPathWithinDir } from "./validation";

interface TemplaterPlugin {
	settings?: {
		enable_folder_templates?: boolean;
		trigger_on_file_creation?: boolean;
		folder_templates?: Array<{ folder?: string; template?: string }>;
	};
	templater?: {
		write_template_to_file: (templateFile: TFile, file: TFile) => Promise<void>;
	};
}

function getTemplaterPlugin(app: App): TemplaterPlugin | undefined {
	return getLoadedPlugin<TemplaterPlugin>(app, "templater-obsidian");
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
 */
export async function withTemplaterHookSuppressed<T>(app: App, fn: () => Promise<T>): Promise<T> {
	const tp = getTemplaterPlugin(app);
	if (!tp?.settings) return fn();
	const prev = tp.settings.trigger_on_file_creation;
	tp.settings.trigger_on_file_creation = false;
	try {
		return await fn();
	} finally {
		tp.settings.trigger_on_file_creation = prev;
	}
}
