import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import type AgentSandboxPlugin from "./main";
import { isValidBindAddress, isValidCpus, isValidMemory, isValidPrivateHosts } from "./validation";

export type TerminalThemeMode = "obsidian" | "dark" | "light";
export type DockerMode = "wsl" | "local";

export interface AgentSandboxSettings {
	dockerMode: DockerMode;
	dockerComposeFilePath: string;
	wslDistroName: string;
	vaultWriteDir: string;
	memoryFileName: string;
	ttydPort: number;
	ttydBindAddress: string;
	autoStartContainer: boolean;
	autoStopContainer: boolean;
	terminalTheme: TerminalThemeMode;
	terminalFont: string;
	allowedPrivateHosts: string;
	containerMemory: string;
	containerCpus: string;
	autoEnableFirewall: boolean;
	sudoPassword: string;
}

export type TerminalSettings = Pick<
	AgentSandboxSettings,
	"ttydPort" | "terminalTheme" | "terminalFont"
>;

export const DEFAULT_SETTINGS: AgentSandboxSettings = {
	dockerMode: "wsl",
	dockerComposeFilePath: "",
	wslDistroName: "Ubuntu",
	vaultWriteDir: "agent-workspace",
	memoryFileName: "memory.json",
	ttydPort: 7681,
	ttydBindAddress: "127.0.0.1",
	autoStartContainer: false,
	autoStopContainer: false,
	terminalTheme: "obsidian",
	terminalFont: "",
	allowedPrivateHosts: "",
	containerMemory: "8G",
	containerCpus: "4",
	autoEnableFirewall: false,
	sudoPassword: "",
};

type TabId = "general" | "terminal" | "advanced";

export class AgentSandboxSettingTab extends PluginSettingTab {
	plugin: AgentSandboxPlugin;
	private activeTab: TabId = "general";

	constructor(app: App, plugin: AgentSandboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("sandbox-settings");

		const warning = containerEl.createDiv({ cls: "sandbox-settings-warning" });
		warning.createSpan({ cls: "sandbox-settings-warning-icon", text: "⚠" });
		warning.createSpan({
			text: "Most settings require a container restart to take effect.",
		});

		this.renderTabs(containerEl);

		const contentEl = containerEl.createDiv({ cls: "sandbox-settings-content" });

		switch (this.activeTab) {
			case "general":
				this.renderGeneral(contentEl);
				break;
			case "terminal":
				this.renderTerminal(contentEl);
				break;
			case "advanced":
				this.renderAdvanced(contentEl);
				break;
		}
	}

	private renderTabs(containerEl: HTMLElement): void {
		const tabBar = containerEl.createDiv({ cls: "sandbox-settings-tabs" });
		const tabs: { id: TabId; label: string }[] = [
			{ id: "general", label: "General" },
			{ id: "terminal", label: "Terminal" },
			{ id: "advanced", label: "Advanced" },
		];
		for (const tab of tabs) {
			const btn = tabBar.createEl("button", {
				text: tab.label,
				cls: "sandbox-settings-tab",
			});
			if (tab.id === this.activeTab) {
				btn.addClass("is-active");
			}
			btn.addEventListener("click", () => {
				this.activeTab = tab.id;
				this.display();
			});
		}
	}

	private renderGeneral(el: HTMLElement): void {
		new Setting(el)
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

		new Setting(el)
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
							? "/home/user/obsidian-agent-sandbox/container"
							: "/opt/obsidian-agent-sandbox/container",
					)
					.setValue(this.plugin.settings.dockerComposeFilePath)
					.onChange(async (value) => {
						this.plugin.settings.dockerComposeFilePath = value;
						this.plugin.saveSettings();
					}),
			);

		if (isWsl) {
			new Setting(el)
				.setName("WSL distribution")
				.setDesc("The WSL distribution used for running Docker commands.")
				.addText((text) =>
					text.setValue(this.plugin.settings.wslDistroName).onChange(async (value) => {
						this.plugin.settings.wslDistroName = value;
						this.plugin.saveSettings();
					}),
				);
		}

		new Setting(el)
			.setName("Vault write directory")
			.setDesc(
				"Folder inside the vault where the container can write. " +
					"The rest of the vault is mounted read-only. Created automatically on start.",
			)
			.addText((text) =>
				text
					.setPlaceholder("agent-workspace")
					.setValue(this.plugin.settings.vaultWriteDir)
					.onChange(async (value) => {
						this.plugin.settings.vaultWriteDir = value;
						this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName("Memory file name")
			.setDesc(
				"Filename for the memory MCP server, stored in the vault's .oas/ directory " +
					"(independent of the write directory). Claude uses this to persist memory across sessions.",
			)
			.addText((text) =>
				text
					.setPlaceholder("memory.json")
					.setValue(this.plugin.settings.memoryFileName)
					.onChange(async (value) => {
						this.plugin.settings.memoryFileName = value;
						this.plugin.saveSettings();
					}),
			);

		new Setting(el)
			.setName("Auto-start on load")
			.setDesc(
				"Start the container when the plugin loads. If the container is " +
					"already running from a previous session, this is a fast no-op — " +
					"compose reuses it.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStartContainer).onChange(async (value) => {
					this.plugin.settings.autoStartContainer = value;
					this.plugin.saveSettings();
				}),
			);

		new Setting(el)
			.setName("Auto-stop on exit")
			.setDesc(
				"Off (default): keep the container running between Obsidian sessions " +
					"so the next open is instant and any background work continues. " +
					"On: stop the container on Obsidian exit to free memory and CPU; " +
					"next open starts it fresh.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoStopContainer).onChange(async (value) => {
					this.plugin.settings.autoStopContainer = value;
					this.plugin.saveSettings();
				}),
			);
	}

	private renderTerminal(el: HTMLElement): void {
		new Setting(el)
			.setName("Port")
			.setDesc("The host port mapped to ttyd inside the container (default: 7681).")
			.addText((text) => {
				text.setValue(String(this.plugin.settings.ttydPort)).onChange(async (value) => {
					const port = parseInt(value, 10);
					if (!isNaN(port) && port > 0 && port <= 65535) {
						this.plugin.settings.ttydPort = port;
						this.plugin.saveSettings();
						text.inputEl.removeClass("sandbox-input-error");
					} else {
						text.inputEl.addClass("sandbox-input-error");
					}
				});
			});

		new Setting(el)
			.setName("Bind address")
			.setDesc(
				"IP address ttyd binds to on the host. Default 127.0.0.1 (localhost only). " +
					"Set to 0.0.0.0 to allow network access.",
			)
			.addText((text) => {
				text.setPlaceholder("127.0.0.1")
					.setValue(this.plugin.settings.ttydBindAddress)
					.onChange(async (value) => {
						if (isValidBindAddress(value)) {
							this.plugin.settings.ttydBindAddress = value;
							this.plugin.saveSettings();
							text.inputEl.removeClass("sandbox-input-error");
						} else {
							text.inputEl.addClass("sandbox-input-error");
						}
					});
			});

		new Setting(el).setName("Appearance").setHeading();

		new Setting(el)
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

		new Setting(el)
			.setName("Terminal font")
			.setDesc(
				"Custom font family for the terminal. Leave empty for automatic fallback " +
					"(Obsidian theme font, then Cascadia Code, Consolas, Menlo, DejaVu Sans Mono).",
			)
			.addText((text) =>
				text
					.setPlaceholder("e.g. Fira Code, JetBrains Mono")
					.setValue(this.plugin.settings.terminalFont)
					.onChange(async (value) => {
						this.plugin.settings.terminalFont = value;
						this.plugin.saveSettings();
					}),
			);
	}

	private renderAdvanced(el: HTMLElement): void {
		new Setting(el).setName("Resource limits").setHeading();

		new Setting(el)
			.setName("Memory limit")
			.setDesc(
				"Maximum memory for the container (e.g. 4G, 8G, 16G). " +
					"On WSL2, also check .wslconfig memory allocation.",
			)
			.addText((text) => {
				text.setPlaceholder("8G")
					.setValue(this.plugin.settings.containerMemory)
					.onChange(async (value) => {
						if (isValidMemory(value)) {
							this.plugin.settings.containerMemory = value;
							this.plugin.saveSettings();
							text.inputEl.removeClass("sandbox-input-error");
						} else {
							text.inputEl.addClass("sandbox-input-error");
						}
					});
			});

		new Setting(el)
			.setName("CPU limit")
			.setDesc("Maximum CPU cores for the container.")
			.addText((text) => {
				text.setPlaceholder("4")
					.setValue(this.plugin.settings.containerCpus)
					.onChange(async (value) => {
						if (isValidCpus(value)) {
							this.plugin.settings.containerCpus = value;
							this.plugin.saveSettings();
							text.inputEl.removeClass("sandbox-input-error");
						} else {
							text.inputEl.addClass("sandbox-input-error");
						}
					});
			});

		new Setting(el).setName("Security").setHeading();

		new Setting(el)
			.setName("Auto-enable firewall on start")
			.setDesc(
				"Automatically enable the outbound firewall when the container starts. " +
					"Restricts traffic to Anthropic, npm, GitHub, PyPI, and configured private hosts.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.autoEnableFirewall).onChange(async (value) => {
					this.plugin.settings.autoEnableFirewall = value;
					this.plugin.saveSettings();
				}),
			);

		new Setting(el)
			.setName("Allowed private hosts")
			.setDesc(
				"Comma-separated IPs or CIDRs allowed through the firewall. " +
					"Use for local services like NAS, API servers, etc. " +
					"The Docker gateway is always allowed.",
			)
			.addText((text) => {
				text.setPlaceholder("e.g. 192.168.1.100, 10.0.0.0/8")
					.setValue(this.plugin.settings.allowedPrivateHosts)
					.onChange(async (value) => {
						if (isValidPrivateHosts(value)) {
							this.plugin.settings.allowedPrivateHosts = value;
							this.plugin.saveSettings();
							text.inputEl.removeClass("sandbox-input-error");
						} else {
							text.inputEl.addClass("sandbox-input-error");
						}
					});
			});

		new Setting(el)
			.setName("Sudo password")
			.setDesc(
				"Password for the narrow apt-get/apt sudo inside the container. " +
					"Used by humans during interactive sessions to test-install tools. " +
					"Leave blank to fall through to the value in container/.env " +
					"(default: 'sandbox'). Set to an empty string in .env to disable sudo entirely. " +
					"This is a human-intent gate, not a security boundary — see README > Development.",
			)
			.addText((text) =>
				text
					.setPlaceholder("(use container/.env value)")
					.setValue(this.plugin.settings.sudoPassword)
					.onChange(async (value) => {
						this.plugin.settings.sudoPassword = value;
						this.plugin.saveSettings();
					}),
			);
	}
}
