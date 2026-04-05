import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import type AgentSandboxPlugin from "./main";

export type TerminalThemeMode = "obsidian" | "dark" | "light";
export type DockerMode = "wsl" | "local";

export interface AgentSandboxSettings {
	dockerMode: DockerMode;
	dockerComposeFilePath: string;
	wslDistroName: string;
	vaultWriteDir: string;
	ttydPort: number;
	ttydUsername: string;
	ttydPassword: string;
	autoStartContainer: boolean;
	autoStopContainer: boolean;
	terminalTheme: TerminalThemeMode;
}

export type TerminalSettings = Pick<
	AgentSandboxSettings,
	"ttydPort" | "ttydUsername" | "ttydPassword" | "terminalTheme"
>;

export const DEFAULT_SETTINGS: AgentSandboxSettings = {
	dockerMode: "wsl",
	dockerComposeFilePath: "",
	wslDistroName: "Ubuntu",
	vaultWriteDir: "claude-workspace",
	ttydPort: 7681,
	ttydUsername: "user",
	ttydPassword: "",
	autoStartContainer: false,
	autoStopContainer: false,
	terminalTheme: "obsidian",
};

export class AgentSandboxSettingTab extends PluginSettingTab {
	plugin: AgentSandboxPlugin;

	constructor(app: App, plugin: AgentSandboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		// ── Container ──────────────────────────────────────────

		new Setting(containerEl).setName("Container").setHeading();

		new Setting(containerEl)
			.setName("Docker mode")
			.setDesc(
				"How Docker is accessed. WSL runs commands via wsl.exe. " +
					"Local runs docker compose directly on the host.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("wsl", "WSL (Windows)")
					.addOption("local", "Local (Linux / Mac / Windows)")
					.setValue(this.plugin.settings.dockerMode)
					.onChange(async (value) => {
						this.plugin.settings.dockerMode = value as DockerMode;
						this.plugin.saveSettings();
						this.display();
					}),
			);

		const isWsl = this.plugin.settings.dockerMode === "wsl";

		new Setting(containerEl)
			.setName("Docker Compose path")
			.setDesc(
				isWsl
					? "Absolute WSL path to the directory containing docker-compose.yml."
					: "Absolute path to the directory containing docker-compose.yml.",
			)
			.addText((text) =>
				text
					.setPlaceholder(
						isWsl
							? "/home/user/obsidian-agent-sandbox/docker"
							: "/opt/obsidian-agent-sandbox/docker",
					)
					.setValue(this.plugin.settings.dockerComposeFilePath)
					.onChange(async (value) => {
						this.plugin.settings.dockerComposeFilePath = value;
						this.plugin.saveSettings();
					}),
			);

		if (isWsl) {
			new Setting(containerEl)
				.setName("WSL distribution")
				.setDesc("The WSL distribution used for running Docker commands.")
				.addText((text) =>
					text.setValue(this.plugin.settings.wslDistroName).onChange(async (value) => {
						this.plugin.settings.wslDistroName = value;
						this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Vault write directory")
			.setDesc(
				"Folder inside the vault where the container can write. " +
					"The rest of the vault is mounted read-only. Created automatically on start.",
			)
			.addText((text) =>
				text
					.setPlaceholder("claude-workspace")
					.setValue(this.plugin.settings.vaultWriteDir)
					.onChange(async (value) => {
						this.plugin.settings.vaultWriteDir = value;
						this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Auto-start on load")
			.setDesc("Start the container when the plugin loads.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStartContainer).onChange(async (value) => {
					this.plugin.settings.autoStartContainer = value;
					this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Auto-stop on unload")
			.setDesc("Stop the container when the plugin is disabled.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStopContainer).onChange(async (value) => {
					this.plugin.settings.autoStopContainer = value;
					this.plugin.saveSettings();
				}),
			);

		// ── Connection ─────────────────────────────────────────

		new Setting(containerEl).setName("Connection").setHeading();

		new Setting(containerEl)
			.setName("Port")
			.setDesc("The port ttyd listens on inside the container (default: 7681).")
			.addText((text) =>
				text.setValue(String(this.plugin.settings.ttydPort)).onChange(async (value) => {
					const port = parseInt(value, 10);
					if (!isNaN(port) && port > 0 && port <= 65535) {
						this.plugin.settings.ttydPort = port;
						this.plugin.saveSettings();
					}
				}),
			);

		new Setting(containerEl)
			.setName("Username")
			.setDesc("Username for ttyd authentication. Leave password empty to disable auth.")
			.addText((text) =>
				text.setValue(this.plugin.settings.ttydUsername).onChange(async (value) => {
					this.plugin.settings.ttydUsername = value;
					this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Password")
			.setDesc("Password for ttyd authentication. Stored in plaintext in the vault.")
			.addText((text) => {
				text.inputEl.type = "password";
				text.setValue(this.plugin.settings.ttydPassword).onChange(async (value) => {
					this.plugin.settings.ttydPassword = value;
					this.plugin.saveSettings();
				});
			});

		// ── Appearance ─────────────────────────────────────────

		new Setting(containerEl).setName("Appearance").setHeading();

		new Setting(containerEl)
			.setName("Terminal theme")
			.setDesc("Follow Obsidian's current theme, or force dark or light.")
			.addDropdown((dropdown) =>
				dropdown
					.addOption("obsidian", "Follow Obsidian theme")
					.addOption("dark", "Dark")
					.addOption("light", "Light")
					.setValue(this.plugin.settings.terminalTheme)
					.onChange(async (value) => {
						this.plugin.settings.terminalTheme = value as TerminalThemeMode;
						this.plugin.saveSettings();
					}),
			);
	}
}
