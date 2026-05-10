/**
 * Session-related modal UIs — the Quick-Switcher-style picker over open
 * terminal tabs and the manual "Clean up empty sessions" modal. Extracted
 * from main.ts to keep the plugin entry focused on wiring.
 */

import type { App } from "obsidian";
import { Modal, Notice } from "obsidian";
import type { TerminalView } from "./terminal-view";
import { VIEW_TYPE_TERMINAL } from "./view-types";
import { logger } from "./logger";

/** Opens a modal listing currently-open sandbox terminal tabs with a filter. */
export function showSessionPicker(app: App): void {
	if (app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL).length === 0) {
		new Notice("No open sandbox terminals.");
		return;
	}
	const modal = new Modal(app);
	modal.titleEl.setText("Switch to Sandbox session");
	const input = modal.contentEl.createEl("input", {
		type: "text",
		cls: "sandbox-modal-filter",
	});
	input.placeholder = "Filter sessions…";
	const list = modal.contentEl.createEl("div", { cls: "sandbox-modal-list" });

	const render = (filter: string) => {
		list.empty();
		const needle = filter.toLowerCase().trim();
		// Re-query per render so tabs closed while the modal is open drop out.
		for (const leaf of app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view as TerminalView;
			const name = view.getSessionName() ?? "(unnamed)";
			const label = `Session: ${name}`;
			if (needle && !label.toLowerCase().includes(needle)) continue;
			const row = list.createEl("div", { cls: "sandbox-modal-row-clickable" });
			row.setText(label);
			row.addEventListener("click", () => {
				modal.close();
				// Revalidate — leaf may have closed between render and click.
				if (!app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL).includes(leaf)) {
					new Notice("That session has closed.");
					return;
				}
				app.workspace.setActiveLeaf(leaf, { focus: true });
				void app.workspace.revealLeaf(leaf);
			});
		}
	};
	render("");
	input.addEventListener("input", () => render(input.value));
	modal.open();
	input.focus();
}

export interface SessionCleanupApi {
	listEmptySessions: () => Promise<string[]>;
	killSession: (name: string) => Promise<void>;
}

/**
 * Opens the "Clean up empty sessions" modal if the container is running
 * and there are candidates. Kills only the user-checked names.
 */
export async function showSessionCleanup(
	app: App,
	api: SessionCleanupApi,
	isContainerRunning: () => boolean,
): Promise<void> {
	if (!isContainerRunning()) {
		new Notice("Sandbox container is not running.");
		return;
	}
	const candidates = await api.listEmptySessions();
	if (candidates.length === 0) {
		new Notice("No empty tmux sessions to clean up.");
		return;
	}
	const modal = new Modal(app);
	modal.titleEl.setText("Clean up empty sessions");
	modal.contentEl.createEl("p", {
		text: `${candidates.length} session(s) have no attached clients. Kill the selected ones?`,
	});
	const selected = new Set(candidates);
	const list = modal.contentEl.createEl("ul", { cls: "sandbox-modal-check-list" });
	for (const name of candidates) {
		const row = list.createEl("li", { cls: "sandbox-modal-check-row" });
		const cb = row.createEl("input", { type: "checkbox" });
		cb.checked = true;
		cb.addEventListener("change", () => {
			if (cb.checked) selected.add(name);
			else selected.delete(name);
		});
		row.createEl("span", { text: name });
	}
	modal.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
		div.createEl("button", { text: "Cancel", cls: "mod-muted" }, (btn) => {
			btn.addEventListener("click", () => modal.close());
		});
		div.createEl("button", { text: "Kill selected", cls: "mod-cta" }, (btn) => {
			btn.addEventListener("click", async () => {
				modal.close();
				const toKill = [...selected];
				const results = await Promise.allSettled(toKill.map((n) => api.killSession(n)));
				let killed = 0;
				results.forEach((r, i) => {
					if (r.status === "fulfilled") {
						killed++;
					} else {
						logger.warn(
							"sessions",
							`failed to kill tmux session '${toKill[i]}':`,
							r.reason,
						);
					}
				});
				new Notice(`Killed ${killed}/${toKill.length} session(s).`);
			});
		});
	});
	modal.open();
}
