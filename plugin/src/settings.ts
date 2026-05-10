import type { App } from "obsidian";
import { PluginSettingTab, Setting } from "obsidian";
import { confirmModal } from "./modals";
import type AgentSandboxPlugin from "./main";
import { setLogLevel, errMsg } from "./logger";
import type { PermissionTier } from "./mcp-tools";
import {
	ALWAYS_ON_TIERS,
	GATED_TIERS as PERMISSION_GATED_TIERS,
	vaultWriteTiers,
} from "./permission-tiers";
import type { TierDef, VaultWriteMode } from "./permission-tiers";
import {
	isValidBindAddress,
	isValidCpus,
	isValidDomainList,
	isValidMemory,
	isValidMemoryFileName,
	isValidPathPrefixList,
	isValidPrivateHosts,
	isValidWriteDir,
} from "./validation";
import { existsSync } from "fs";
import { join } from "path";

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
	terminalFontSize: number;
	terminalScrollback: number;
	clipboardAutoCopy: boolean;
	allowedPrivateHosts: string;
	additionalFirewallDomains: string;
	containerMemory: string;
	containerCpus: string;
	autoEnableFirewall: boolean;
	sudoPassword: string;
	mcpEnabled: boolean;
	mcpPort: number;
	mcpBindAddress: string;
	mcpToken: string;
	mcpVaultWrites: VaultWriteMode;
	mcpTierNavigate: boolean;
	mcpTierManage: boolean;
	mcpTierExtensions: boolean;
	mcpPathAllowlist: string;
	mcpPathBlocklist: string;
	agentOutputNotify: "new" | "new_or_modified" | "off";
	logLevel: "debug" | "info" | "warn" | "error";
	mcpToolTimeout: number;
	mcpReviewTimeout: number;
}

/**
 * Gated MCP tiers — user must opt in because each escalates beyond the
 * filesystem access Claude already has (RO vault, RW workspace). The "read"
 * and "writeScoped" tiers are not listed: they're always enabled when MCP is
 * on because disabling them wouldn't deny access, only remove convenience.
 *
 * Sourced from permission-tiers.ts (no Obsidian deps), with `settingKey`
 * narrowed to `keyof AgentSandboxSettings` for type-safe indexing.
 */
export const GATED_TIERS: readonly TierDef<keyof AgentSandboxSettings>[] =
	PERMISSION_GATED_TIERS as readonly TierDef<keyof AgentSandboxSettings>[];

export function enabledTiersFromSettings(settings: AgentSandboxSettings): Set<PermissionTier> {
	const tiers = new Set<PermissionTier>(ALWAYS_ON_TIERS);
	for (const def of GATED_TIERS) {
		if (settings[def.settingKey]) tiers.add(def.tier);
	}
	for (const tier of vaultWriteTiers(settings.mcpVaultWrites)) tiers.add(tier);
	return tiers;
}

export type TerminalSettings = Pick<
	AgentSandboxSettings,
	| "ttydPort"
	| "terminalTheme"
	| "terminalFont"
	| "terminalFontSize"
	| "terminalScrollback"
	| "clipboardAutoCopy"
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
	terminalFontSize: 14,
	terminalScrollback: 10000,
	clipboardAutoCopy: true,
	allowedPrivateHosts: "",
	additionalFirewallDomains: "",
	containerMemory: "8G",
	containerCpus: "4",
	autoEnableFirewall: false,
	sudoPassword: "sandbox",
	mcpEnabled: true,
	mcpPort: 28080,
	// Default 0.0.0.0 because the container reaches the host MCP server via
	// `host.docker.internal`, which resolves to a non-loopback host IP. Users
	// who only invoke MCP from host-side tools can lock this down to 127.0.0.1.
	mcpBindAddress: "0.0.0.0",
	mcpToken: "",
	mcpVaultWrites: "none",
	mcpTierNavigate: false,
	mcpTierManage: false,
	mcpTierExtensions: false,
	mcpPathAllowlist: "",
	mcpPathBlocklist: "",
	agentOutputNotify: "new",
	logLevel: "info",
	mcpToolTimeout: 10,
	mcpReviewTimeout: 180,
};

type TabId = "general" | "terminal" | "advanced" | "mcp";

export class AgentSandboxSettingTab extends PluginSettingTab {
	plugin: AgentSandboxPlugin;
	private activeTab: TabId = "general";
	private restartNeeded = false;

	constructor(app: App, plugin: AgentSandboxPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	hide(): void {
		if (!this.restartNeeded) return;
		this.restartNeeded = false;
		if (!this.plugin.isContainerRunning()) return;
		void confirmModal(this.app, {
			title: "Restart Container?",
			message:
				"You changed settings that require a container restart. Restart now? This will stop all active terminal sessions.",
			ctaLabel: "Restart",
			cancelLabel: "Later",
		}).then((ok) => {
			if (ok) void this.plugin.restartContainer();
		});
	}

	private markRestart(): void {
		this.restartNeeded = true;
	}

	/**
	 * Add a numeric Setting whose input parses as int and validates against
	 * [min, max]. Invalid input shows the error class and is dropped (not saved).
	 */
	private addNumberSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			min: number;
			max: number;
			placeholder?: string;
			requiresRestart?: boolean;
			narrow?: boolean;
			onChange?: () => void;
		},
	): void {
		new Setting(el)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText((text) => {
				if (opts.placeholder) text.setPlaceholder(opts.placeholder);
				text.setValue(String(this.plugin.settings[opts.key])).onChange(async (value) => {
					const n = parseInt(value, 10);
					if (!isNaN(n) && n >= opts.min && n <= opts.max) {
						(this.plugin.settings[opts.key] as number) = n;
						this.plugin.saveSettings();
						if (opts.requiresRestart) this.markRestart();
						text.inputEl.removeClass("sandbox-input-error");
						opts.onChange?.();
					} else {
						text.inputEl.addClass("sandbox-input-error");
					}
				});
				if (opts.narrow) text.inputEl.addClass("sandbox-settings-narrow-input");
			});
	}

	/** Add a boolean Setting backed by a toggle. */
	private addToggleSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			requiresRestart?: boolean;
			onChange?: (value: boolean) => void | Promise<void>;
		},
	): void {
		new Setting(el)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings[opts.key] as boolean)
					.onChange(async (value) => {
						(this.plugin.settings[opts.key] as boolean) = value;
						this.plugin.saveSettings();
						if (opts.requiresRestart) this.markRestart();
						await opts.onChange?.(value);
					}),
			);
	}

	/** Add a plain text Setting that saves on every change with no validation. */
	private addPlainTextSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			placeholder?: string;
			requiresRestart?: boolean;
		},
	): void {
		new Setting(el)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText((text) => {
				if (opts.placeholder) text.setPlaceholder(opts.placeholder);
				text.setValue(String(this.plugin.settings[opts.key])).onChange(async (value) => {
					(this.plugin.settings[opts.key] as string) = value;
					this.plugin.saveSettings();
					if (opts.requiresRestart) this.markRestart();
				});
			});
	}

	/**
	 * Add a text Setting whose input is validated by a string validator. Invalid
	 * input shows the error class and is dropped (not saved).
	 */
	private addValidatedTextSetting(
		el: HTMLElement,
		opts: {
			name: string;
			desc: string;
			key: keyof AgentSandboxSettings;
			validator: (value: string) => boolean;
			placeholder?: string;
			requiresRestart?: boolean;
			onChange?: () => void;
		},
	): void {
		new Setting(el)
			.setName(opts.name)
			.setDesc(opts.desc)
			.addText((text) => {
				if (opts.placeholder) text.setPlaceholder(opts.placeholder);
				text.setValue(String(this.plugin.settings[opts.key])).onChange(async (value) => {
					if (opts.validator(value)) {
						(this.plugin.settings[opts.key] as string) = value;
						this.plugin.saveSettings();
						if (opts.requiresRestart) this.markRestart();
						text.inputEl.removeClass("sandbox-input-error");
						opts.onChange?.();
					} else {
						text.inputEl.addClass("sandbox-input-error");
					}
				});
			});
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();
		containerEl.addClass("sandbox-settings");

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
			case "mcp":
				this.renderMcp(contentEl);
				break;
		}
	}

	private renderTabs(containerEl: HTMLElement): void {
		const tabBar = containerEl.createDiv({ cls: "sandbox-settings-tabs" });
		const tabs: { id: TabId; label: string }[] = [
			{ id: "general", label: "General" },
			{ id: "terminal", label: "Terminal" },
			{ id: "advanced", label: "Advanced" },
			{ id: "mcp", label: "MCP" },
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

		const composeDesc = isWsl
			? "Absolute WSL path to the directory containing docker-compose.yml. Requires restart."
			: "Absolute path to the directory containing docker-compose.yml. Requires restart.";

		const composeSetting = new Setting(el).setName("Docker Compose path").setDesc(composeDesc);

		if (
			!isWsl &&
			this.plugin.settings.dockerComposeFilePath &&
			!existsSync(join(this.plugin.settings.dockerComposeFilePath, "docker-compose.yml"))
		) {
			composeSetting.descEl.createEl("br");
			composeSetting.descEl.createEl("strong", {
				text: "docker-compose.yml not found at this path.",
				cls: "sandbox-settings-warning-text",
			});
		}

		composeSetting.addText((text) =>
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
					this.markRestart();
				}),
		);

		if (isWsl) {
			this.addPlainTextSetting(el, {
				name: "WSL distribution",
				desc: "The WSL distribution used for running Docker commands. Requires restart.",
				key: "wslDistroName",
				requiresRestart: true,
			});
		}

		this.addValidatedTextSetting(el, {
			name: "Vault write directory",
			desc:
				"Folder inside the vault where the container can write. " +
				"The rest of the vault is mounted read-only. Created automatically on start. " +
				"Requires restart.",
			key: "vaultWriteDir",
			validator: isValidWriteDir,
			placeholder: "agent-workspace",
			requiresRestart: true,
		});

		this.addValidatedTextSetting(el, {
			name: "Memory file name",
			desc:
				"Filename for the memory MCP server, stored in the vault's .oas/ directory " +
				"(independent of the write directory). Requires restart.",
			key: "memoryFileName",
			validator: isValidMemoryFileName,
			placeholder: "memory.json",
			requiresRestart: true,
		});

		this.addToggleSetting(el, {
			name: "Auto-start on load",
			desc:
				"Start the container when the plugin loads. If the container is " +
				"already running from a previous session, this is a fast no-op — compose reuses it.",
			key: "autoStartContainer",
		});

		this.addToggleSetting(el, {
			name: "Auto-stop on exit",
			desc:
				"Off (default): keep the container running between Obsidian sessions " +
				"so the next open is instant and any background work continues. " +
				"On: stop the container on Obsidian exit to free memory and CPU; next open starts it fresh.",
			key: "autoStopContainer",
		});

		new Setting(el)
			.setName("Notify on agent output")
			.setDesc(
				"Show a non-intrusive Notice when the agent writes files under the vault write directory. 'New' only fires on file creation; 'New or modified' also fires on edits (noisier during long edit sessions).",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("new", "New files only (default)")
					.addOption("new_or_modified", "New or modified files")
					.addOption("off", "Off")
					.setValue(this.plugin.settings.agentOutputNotify)
					.onChange(async (value) => {
						this.plugin.settings.agentOutputNotify = value as
							| "new"
							| "new_or_modified"
							| "off";
						this.plugin.saveSettings();
					}),
			);
	}

	private renderTerminal(el: HTMLElement): void {
		this.addNumberSetting(el, {
			name: "Port",
			desc: "The host port mapped to ttyd inside the container (default: 7681). Requires restart.",
			key: "ttydPort",
			min: 1,
			max: 65535,
			requiresRestart: true,
		});

		const bindDesc =
			this.plugin.settings.ttydBindAddress === "0.0.0.0"
				? "Warning: 0.0.0.0 exposes ttyd to your network without authentication. " +
					"Anyone on your network can access the terminal. Requires restart."
				: "IP address ttyd binds to on the host. Default 127.0.0.1 (localhost only). " +
					"Requires restart.";

		this.addValidatedTextSetting(el, {
			name: "Bind address",
			desc: bindDesc,
			key: "ttydBindAddress",
			validator: isValidBindAddress,
			placeholder: "127.0.0.1",
			requiresRestart: true,
			onChange: () => this.display(),
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

		this.addPlainTextSetting(el, {
			name: "Terminal font",
			desc:
				"Custom font family for the terminal. Leave empty for automatic fallback " +
				"(Obsidian theme font, then Cascadia Code, Consolas, Menlo, DejaVu Sans Mono).",
			key: "terminalFont",
			placeholder: "e.g. Fira Code, JetBrains Mono",
		});

		this.addNumberSetting(el, {
			name: "Font size",
			desc: "Terminal font size in pixels (8–32).",
			key: "terminalFontSize",
			min: 8,
			max: 32,
			placeholder: "14",
		});

		this.addNumberSetting(el, {
			name: "Scrollback",
			desc: "Number of lines of terminal history to keep (100–100,000).",
			key: "terminalScrollback",
			min: 100,
			max: 100000,
			placeholder: "10000",
		});

		this.addToggleSetting(el, {
			name: "Auto-copy on selection",
			desc: "Copy selected terminal text to the clipboard automatically. Disable if selecting text for reading surprises you by overwriting the clipboard.",
			key: "clipboardAutoCopy",
		});
	}

	private renderMcp(el: HTMLElement): void {
		new Setting(el).setName("Server").setHeading();

		this.addToggleSetting(el, {
			name: "Enable MCP server",
			desc:
				"Run an MCP server that exposes vault tools to Claude Code inside the container. " +
				"The server starts automatically with the plugin when enabled.",
			key: "mcpEnabled",
			onChange: (v) => this.plugin.applyMcpEnabled(v),
		});

		this.addNumberSetting(el, {
			name: "MCP port",
			desc: "Port for the MCP Streamable HTTP endpoint. Requires container restart for the new port to be passed in.",
			key: "mcpPort",
			min: 1,
			max: 65535,
			placeholder: "28080",
			requiresRestart: true,
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		const mcpBindDesc =
			this.plugin.settings.mcpBindAddress === "0.0.0.0"
				? "Warning: 0.0.0.0 (default) exposes MCP to your network. Bearer-token auth is the only line of defense. This default is required so the sandbox container can reach the host via host.docker.internal — narrow to 127.0.0.1 if you only use MCP from host-side tools."
				: "IP the MCP HTTP server binds to. 127.0.0.1 hides MCP from the network and from the container. Use the container's docker-bridge gateway IP if you want container access without exposing to LAN. Requires MCP restart.";

		this.addValidatedTextSetting(el, {
			name: "MCP bind address",
			desc: mcpBindDesc,
			key: "mcpBindAddress",
			validator: isValidBindAddress,
			placeholder: "127.0.0.1",
			onChange: () => {
				void this.plugin.restartMcpIfRunning();
				this.display();
			},
		});

		new Setting(el)
			.setName("Auth token")
			.setDesc(
				"Bearer token for MCP authentication. Auto-generated and passed to the container. " +
					"Regenerating requires a container restart so the container picks up the new token.",
			)
			.addText((text) => {
				text.setValue(this.plugin.settings.mcpToken).setDisabled(true);
				text.inputEl.addClass("sandbox-settings-code-input");
			})
			.addButton((btn) =>
				btn.setButtonText("Regenerate").onClick(async () => {
					const { generateToken } = await import("./mcp-server");
					this.plugin.settings.mcpToken = generateToken();
					this.plugin.saveSettings();
					this.markRestart();
					await this.plugin.restartMcpIfRunning();
					this.display();
				}),
			);

		new Setting(el).setName("Always enabled").setHeading();

		const alwaysBox = el.createDiv({
			cls: "setting-item-description sandbox-settings-section-margin",
		});
		alwaysBox.createEl("p", {
			text: "These MCP tools are always available when MCP is enabled. They don't grant access beyond what Claude already has via the filesystem (RO vault, RW workspace) — they just offer a more ergonomic interface via Obsidian's metadata.",
		});
		// Don't burn the writeDir value into the blurb — the MCP server reads it
		// live (via getWriteDir), but the settings UI only re-renders on full
		// tab re-render, so a stale snapshot would confuse users. Refer the
		// reader to the "Vault write directory" setting instead.
		const list = alwaysBox.createEl("ul", { cls: "sandbox-settings-info-list" });
		list.createEl("li", {
			text: "Read — search, read files, query metadata, tags, links, backlinks, frontmatter.",
		});
		list.createEl("li", {
			text: "Write (scoped) — create and modify files within the configured vault write directory only (see General settings).",
		});

		new Setting(el).setName("Escalations").setHeading();

		const escDesc = el.createDiv({
			cls: "setting-item-description sandbox-settings-section-margin",
		});
		escDesc.setText(
			"These tiers grant Claude capabilities beyond its filesystem access. Enable only what you need.",
		);

		new Setting(el)
			.setName("Vault-wide writes")
			.setDesc(
				"Writes outside the scoped write directory. None: scoped only. Reviewed: each change prompts a diff approval. Full: unrestricted, no review.",
			)
			.addDropdown((dd) =>
				dd
					.addOption("none", "None")
					.addOption("reviewed", "Reviewed")
					.addOption("full", "Full (no review)")
					.setValue(this.plugin.settings.mcpVaultWrites)
					.onChange(async (value) => {
						this.plugin.settings.mcpVaultWrites = value as VaultWriteMode;
						this.plugin.saveSettings();
						void this.plugin.restartMcpIfRunning();
					}),
			);

		for (const tier of GATED_TIERS) {
			this.addToggleSetting(el, {
				name: tier.name,
				desc: tier.desc,
				key: tier.settingKey,
				onChange: () => this.plugin.restartMcpIfRunning(),
			});
		}

		new Setting(el).setName("Path restrictions").setHeading();

		this.addValidatedTextSetting(el, {
			name: "Allowed paths",
			desc: "Comma-separated folder prefixes. If set, only these paths are accessible. Empty = all paths.",
			key: "mcpPathAllowlist",
			validator: isValidPathPrefixList,
			placeholder: "notes/,projects/",
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		this.addValidatedTextSetting(el, {
			name: "Blocked paths",
			desc: "Comma-separated folder prefixes. These paths are always denied, even if allowed above.",
			key: "mcpPathBlocklist",
			validator: isValidPathPrefixList,
			placeholder: "private/,secrets/",
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		new Setting(el).setName("Timeouts").setHeading();

		this.addNumberSetting(el, {
			name: "Tool timeout (seconds)",
			desc: "Max time for a normal MCP tool call to complete before failing.",
			key: "mcpToolTimeout",
			min: 1,
			max: 300,
			placeholder: "10",
			narrow: true,
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});

		this.addNumberSetting(el, {
			name: "Review timeout (seconds)",
			desc: "How long you have to approve or reject a write in the review modal before it times out.",
			key: "mcpReviewTimeout",
			min: 1,
			max: 600,
			placeholder: "180",
			narrow: true,
			onChange: () => void this.plugin.restartMcpIfRunning(),
		});
	}

	private renderAdvanced(el: HTMLElement): void {
		new Setting(el).setName("Diagnostics").setHeading();

		new Setting(el)
			.setName("Log level")
			.setDesc(
				"Controls verbosity of plugin logs in the developer console (Ctrl+Shift+I). " +
					"Debug shows MCP tool calls, session lifecycle, and WebSocket events.",
			)
			.addDropdown((dropdown) =>
				dropdown
					.addOption("debug", "Debug")
					.addOption("info", "Info")
					.addOption("warn", "Warn")
					.addOption("error", "Error")
					.setValue(this.plugin.settings.logLevel)
					.onChange(async (value) => {
						this.plugin.settings.logLevel = value as AgentSandboxSettings["logLevel"];
						this.plugin.saveSettings();
						setLogLevel(this.plugin.settings.logLevel);
					}),
			);

		new Setting(el).setName("Resource limits").setHeading();

		this.addValidatedTextSetting(el, {
			name: "Memory limit",
			desc:
				"Maximum memory for the container (e.g. 4G, 8G, 16G). " +
				"On WSL2, also check .wslconfig memory allocation. Requires restart.",
			key: "containerMemory",
			validator: isValidMemory,
			placeholder: "8G",
			requiresRestart: true,
		});

		this.addValidatedTextSetting(el, {
			name: "CPU limit",
			desc: "Maximum CPU cores for the container. Requires restart.",
			key: "containerCpus",
			validator: isValidCpus,
			placeholder: "4",
			requiresRestart: true,
		});

		new Setting(el).setName("Security").setHeading();

		this.addToggleSetting(el, {
			name: "Auto-enable firewall on start",
			desc:
				"Automatically enable the outbound firewall when the container starts. " +
				"Restricts traffic to Anthropic, npm, GitHub, PyPI, and configured private hosts.",
			key: "autoEnableFirewall",
		});

		this.addValidatedTextSetting(el, {
			name: "Allowed private hosts",
			desc:
				"Comma-separated IPs or CIDRs allowed through the firewall. " +
				"Use for local services like NAS, API servers, etc. " +
				"The Docker gateway is always allowed. Requires restart.",
			key: "allowedPrivateHosts",
			validator: isValidPrivateHosts,
			placeholder: "e.g. 192.168.1.100, 10.0.0.0/8",
			requiresRestart: true,
		});

		this.addValidatedTextSetting(el, {
			name: "Additional firewall domains",
			desc:
				"Comma-separated domains to add to the firewall allowlist (e.g. api.atlassian.com, slack.com). " +
				"Adds to — never overrides — the built-in baseline. For host-managed rules Claude cannot see, " +
				"edit container/firewall-extras.txt instead. Requires restart.",
			key: "additionalFirewallDomains",
			validator: isValidDomainList,
			placeholder: "e.g. api.atlassian.com, slack.com",
			requiresRestart: true,
		});

		const sourcesBox = el.createDiv({ cls: "setting-item sandbox-settings-sources" });
		const sourcesHeader = sourcesBox.createDiv({ cls: "sandbox-settings-sources-header" });
		sourcesHeader.createEl("div", {
			text: "Effective allowlist",
			cls: "setting-item-name",
		});
		const refreshBtn = sourcesHeader.createEl("button", { text: "Refresh" });
		const sourcesOutput = sourcesBox.createEl("pre", {
			cls: "sandbox-settings-sources-output",
		});
		sourcesOutput.setText(
			"(Click Refresh to fetch the effective firewall allowlist from the container.)",
		);
		refreshBtn.addEventListener("click", async () => {
			sourcesOutput.setText("Fetching…");
			try {
				const output = await this.plugin.firewallSources();
				sourcesOutput.setText(output.trim() || "(empty)");
			} catch (e: unknown) {
				const msg = errMsg(e);
				sourcesOutput.setText(`Error: ${msg}\n\nIs the container running?`);
			}
		});

		this.addPlainTextSetting(el, {
			name: "Sudo password",
			desc:
				"Password for the narrow apt-get/apt sudo inside the container. " +
				"Used by humans during interactive sessions to test-install tools. " +
				"Matches the default in container/.env.example. Requires restart.",
			key: "sudoPassword",
			placeholder: "(use container/.env value)",
			requiresRestart: true,
		});
	}
}
