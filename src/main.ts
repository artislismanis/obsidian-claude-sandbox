import { Plugin, debounce } from "obsidian";
import {
	type PkmClaudeTerminalSettings,
	DEFAULT_SETTINGS,
	PkmClaudeTerminalSettingTab,
} from "./settings";

export default class PkmClaudeTerminalPlugin extends Plugin {
	settings: PkmClaudeTerminalSettings = { ...DEFAULT_SETTINGS };

	private debouncedSaveSettings = debounce(
		async () => {
			await this.saveData(this.settings);
		},
		500,
		true
	);

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new PkmClaudeTerminalSettingTab(this.app, this));
	}

	onunload() {
		// Flush any pending debounced save
		this.debouncedSaveSettings();
	}

	async loadSettings() {
		this.settings = Object.assign(
			{},
			DEFAULT_SETTINGS,
			await this.loadData()
		);
	}

	saveSettings() {
		this.debouncedSaveSettings();
	}
}
