/**
 * Typed accessors for Obsidian APIs that aren't part of the public typings.
 * Centralising the `as unknown as` casts keeps the risk surface in one file —
 * if Obsidian changes one of these shapes, only this module needs an update.
 *
 * Each helper returns `undefined` (or null) when the underlying field is
 * missing, so callers must always handle the absent case rather than assuming
 * the shape is present.
 */

import type { App, Menu, MenuItem, WorkspaceLeaf } from "obsidian";

/** The plugin host exposed on `app.plugins` (Obsidian doesn't type this). */
interface PluginsHost {
	plugins?: Record<string, unknown>;
	getPlugin?: (id: string) => unknown;
	enabledPlugins?: Set<string>;
}

/** Get the plugin-host object on `app`, or undefined if Obsidian hasn't wired one. */
export function getPluginsHost(app: App): PluginsHost | undefined {
	return (app as unknown as { plugins?: PluginsHost }).plugins;
}

/** Look up a loaded plugin by id from the plugin host's `plugins` map. */
export function getLoadedPlugin<T = unknown>(app: App, id: string): T | undefined {
	const host = getPluginsHost(app);
	return host?.plugins?.[id] as T | undefined;
}

/** Trigger Obsidian's leaf-header refresh if the leaf supports it. */
export function refreshLeafHeader(leaf: WorkspaceLeaf): void {
	(leaf as unknown as { updateHeader?: () => void }).updateHeader?.();
}

/** Open a submenu on a context-menu item if the host build supports it; otherwise return null. */
export function tryOpenSubmenu(item: MenuItem): Menu | null {
	const fn = (item as unknown as { setSubmenu?: () => Menu }).setSubmenu;
	return fn ? (fn.call(item) ?? null) : null;
}
