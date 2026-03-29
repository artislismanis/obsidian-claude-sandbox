import { Plugin } from "obsidian";

export default class PkmClaudeTerminalPlugin extends Plugin {
	async onload() {
		console.log("Loading PKM Claude Terminal plugin");
	}

	async onunload() {
		console.log("Unloading PKM Claude Terminal plugin");
	}
}
