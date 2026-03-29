import { App, PluginSettingTab, Setting } from "obsidian";
import type PkmClaudeTerminalPlugin from "./main";

export interface PkmClaudeTerminalSettings {
	dockerComposeFilePath: string;
	wslDistroName: string;
	ttydPort: number;
	ttydUsername: string;
	ttydPassword: string;
	autoStartContainer: boolean;
	autoStopContainer: boolean;
}

export const DEFAULT_SETTINGS: PkmClaudeTerminalSettings = {
	dockerComposeFilePath: "",
	wslDistroName: "Ubuntu",
	ttydPort: 7681,
	ttydUsername: "user",
	ttydPassword: "",
	autoStartContainer: false,
	autoStopContainer: false,
};

export class PkmClaudeTerminalSettingTab extends PluginSettingTab {
	plugin: PkmClaudeTerminalPlugin;

	constructor(app: App, plugin: PkmClaudeTerminalPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		new Setting(containerEl)
			.setName("Docker Compose file path")
			.setDesc(
				"Absolute WSL path to the docker-compose.yml file (e.g. /home/user/claude-terminal/docker-compose.yml)."
			)
			.addText((text) =>
				text
					.setPlaceholder("/path/to/docker-compose.yml")
					.setValue(this.plugin.settings.dockerComposeFilePath)
					.onChange(async (value) => {
						this.plugin.settings.dockerComposeFilePath = value;
						this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("WSL distro name")
			.setDesc(
				"The name of the WSL distribution to use for running Docker commands."
			)
			.addText((text) =>
				text
					.setValue(this.plugin.settings.wslDistroName)
					.onChange(async (value) => {
						this.plugin.settings.wslDistroName = value;
						this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("ttyd port")
			.setDesc(
				"The port on which ttyd exposes the terminal (default: 7681)."
			)
			.addText((text) =>
				text
					.setValue(String(this.plugin.settings.ttydPort))
					.onChange(async (value) => {
						const port = parseInt(value, 10);
						if (!isNaN(port) && port > 0 && port <= 65535) {
							this.plugin.settings.ttydPort = port;
							this.plugin.saveSettings();
						}
					})
			);

		new Setting(containerEl)
			.setName("ttyd username")
			.setDesc("Username for ttyd basic authentication.")
			.addText((text) =>
				text
					.setValue(this.plugin.settings.ttydUsername)
					.onChange(async (value) => {
						this.plugin.settings.ttydUsername = value;
						this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("ttyd password")
			.setDesc("Password for ttyd basic authentication. Stored in plaintext in the vault.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.ttydPassword).onChange(
					async (value) => {
						this.plugin.settings.ttydPassword = value;
						this.plugin.saveSettings();
					}
				);
			});

		new Setting(containerEl)
			.setName("Auto-start container on plugin load")
			.setDesc(
				"Automatically start the Docker container when the plugin is loaded."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoStartContainer)
					.onChange(async (value) => {
						this.plugin.settings.autoStartContainer = value;
						this.plugin.saveSettings();
					})
			);

		new Setting(containerEl)
			.setName("Auto-stop container on plugin unload")
			.setDesc(
				"Automatically stop the Docker container when the plugin is unloaded."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.autoStopContainer)
					.onChange(async (value) => {
						this.plugin.settings.autoStopContainer = value;
						this.plugin.saveSettings();
					})
			);
	}
}
