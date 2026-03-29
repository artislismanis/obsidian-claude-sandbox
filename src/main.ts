import { Plugin, WorkspaceLeaf } from "obsidian";
import {
	TerminalView,
	type TerminalViewSettings,
	VIEW_TYPE_TERMINAL,
} from "./terminal-view";

const DEFAULT_TERMINAL_SETTINGS: TerminalViewSettings = {
	ttydPort: 7681,
	ttydUser: "user",
	ttydPassword: "",
};

export default class PkmClaudeTerminalPlugin extends Plugin {
	settings: TerminalViewSettings = DEFAULT_TERMINAL_SETTINGS;

	async onload() {
		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			return new TerminalView(leaf, this.settings);
		});

		this.addRibbonIcon("terminal", "Open Claude Terminal", () => {
			this.activateTerminalView();
		});

		this.addCommand({
			id: "open-claude-terminal",
			name: "Open Claude Terminal",
			callback: () => {
				this.activateTerminalView();
			},
		});
	}

	onunload() {
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
	}

	async activateTerminalView(): Promise<void> {
		const existing =
			this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);

		if (existing.length > 0) {
			this.app.workspace.revealLeaf(existing[0]);
			return;
		}

		const leaf = this.app.workspace.getRightLeaf(false);
		if (leaf) {
			await leaf.setViewState({
				type: VIEW_TYPE_TERMINAL,
				active: true,
			});
			this.app.workspace.revealLeaf(leaf);
		}
	}
}
