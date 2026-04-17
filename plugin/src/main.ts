import type { WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter, Menu, Modal, Notice, Plugin, debounce } from "obsidian";
import { type AgentSandboxSettings, DEFAULT_SETTINGS, AgentSandboxSettingTab } from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { FirewallStatusBar, StatusBarManager } from "./status-bar";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";
import { isValidWriteDir } from "./validation";
import { ObsidianMcpServer, generateToken } from "./mcp-server";
import type { PermissionTier } from "./mcp-tools";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const TOOLTIP_STOPPED = "Container is not running\nClick for options";
const HEALTH_POLL_INTERVAL = 30_000;

export default class AgentSandboxPlugin extends Plugin {
	settings: AgentSandboxSettings = { ...DEFAULT_SETTINGS };
	private docker!: DockerManager;
	private statusBar!: StatusBarManager;
	private firewallBar!: FirewallStatusBar;
	private statusBarEl: HTMLElement | null = null;
	private statusBarClickHandler: ((evt: MouseEvent) => void) | null = null;
	private healthPollId: number | null = null;
	private mcpServer: ObsidianMcpServer | null = null;

	private debouncedSaveSettings = debounce(
		async () => {
			await this.saveData(this.settings);
		},
		500,
		true,
	);

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AgentSandboxSettingTab(this.app, this));

		this.docker = new DockerManager(() => ({
			dockerMode: this.settings.dockerMode,
			composePath: this.settings.dockerComposeFilePath,
			wslDistro: this.settings.wslDistroName,
			vaultPath:
				this.app.vault.adapter instanceof FileSystemAdapter
					? this.app.vault.adapter.getBasePath()
					: undefined,
			writeDir: this.settings.vaultWriteDir,
			memoryFileName: this.settings.memoryFileName,
			ttydPort: this.settings.ttydPort,
			ttydBindAddress: this.settings.ttydBindAddress,
			allowedPrivateHosts: this.settings.allowedPrivateHosts,
			containerMemory: this.settings.containerMemory,
			containerCpus: this.settings.containerCpus,
			sudoPassword: this.settings.sudoPassword,
			mcpToken: this.settings.mcpEnabled ? this.settings.mcpToken : undefined,
			mcpPort: this.settings.mcpEnabled ? this.settings.mcpPort : undefined,
		}));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(this.statusBarEl);
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.statusBarClickHandler = (evt) => void this.showStatusMenu(evt);
		this.statusBarEl.addEventListener("click", this.statusBarClickHandler);

		const fwBarEl = this.addStatusBarItem();
		this.firewallBar = new FirewallStatusBar(fwBarEl, () => this.toggleFirewall());

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			const view = new TerminalView(leaf, () => ({
				ttydPort: this.settings.ttydPort,
				terminalTheme: this.settings.terminalTheme,
				terminalFont: this.settings.terminalFont,
			}));
			view.onRenameSession = async () => {
				const oldName = (view.getState().sessionName as string) ?? "";
				const newName = await this.promptSessionName("Rename Session", oldName);
				if (!newName || newName === oldName) return;
				if (oldName) {
					try {
						await this.docker.renameSession(oldName, newName);
					} catch {
						new Notice("Failed to rename tmux session.");
						return;
					}
				}
				await leaf.setViewState({
					type: VIEW_TYPE_TERMINAL,
					state: { sessionName: newName },
				});
			};
			return view;
		});

		// Hydrate the status bar from real container state without
		// blocking vault load. If Docker/WSL is unavailable (e.g.
		// WSL2 not started after a PC restart), the fast-fail probe
		// (5s timeout) surfaces an error Notice instead of hanging
		// for 30s. Auto-start is folded in so it only fires after
		// the probe confirms Docker is reachable.
		this.app.workspace.onLayoutReady(() => {
			void this.backgroundStartup();
		});

		this.addRibbonIcon("box", "Open Sandbox Terminal", () => {
			if (this.statusBar.getState() !== "running") {
				new Notice("Container is not running. Start it first.");
				return;
			}
			this.activateTerminalView();
		});

		this.addCommand({
			id: "open-claude-terminal",
			name: "Open Sandbox Terminal",
			callback: () => {
				this.activateTerminalView();
			},
		});

		this.addCommand({
			id: "sandbox-start-container",
			name: "Sandbox: Start Container",
			callback: () => this.startContainer(),
		});

		this.addCommand({
			id: "sandbox-stop-container",
			name: "Sandbox: Stop Container",
			callback: () => this.stopContainer(),
		});

		this.addCommand({
			id: "sandbox-container-status",
			name: "Sandbox: Container Status",
			callback: () => this.containerStatus(),
		});

		this.addCommand({
			id: "sandbox-restart-container",
			name: "Sandbox: Restart Container",
			callback: () => this.restartContainer(),
		});

		this.addCommand({
			id: "sandbox-toggle-firewall",
			name: "Sandbox: Toggle Firewall",
			callback: () => this.toggleFirewall(),
		});

		this.addCommand({
			id: "open-session",
			name: "Open Sandbox Session...",
			callback: async () => {
				const name = await this.promptSessionName("New Session");
				if (name) this.activateTerminalView(name);
			},
		});

		this.addCommand({
			id: "open-browser",
			name: "Open Sandbox in Browser",
			callback: () => {
				window.open(`http://localhost:${this.settings.ttydPort}`);
			},
		});

		this.addCommand({
			id: "sandbox-toggle-mcp",
			name: "Sandbox: Toggle MCP Server",
			callback: () => this.toggleMcpServer(),
		});

		if (this.settings.mcpEnabled) {
			void this.startMcpServer();
		}

		// Stop container on app quit (onunload only fires on plugin disable, not app exit)
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				if (this.settings.autoStopContainer) {
					tasks.add(async () => {
						if (this.docker.isBusy()) {
							this.docker.stopDetached();
							return;
						}
						await Promise.race([
							this.docker.stop().catch(() => {}),
							new Promise((r) => setTimeout(r, 5000)),
						]);
					});
				}
			}),
		);
	}

	onunload() {
		this.stopHealthPoll();
		void this.mcpServer?.stop();
		void this.saveData(this.settings);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		this.firewallBar.destroy();
		if (this.statusBarEl && this.statusBarClickHandler) {
			this.statusBarEl.removeEventListener("click", this.statusBarClickHandler);
		}

		// Always stop container when plugin is disabled
		this.docker.stopDetached();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.mcpToken) {
			this.settings.mcpToken = generateToken();
			await this.saveData(this.settings);
		}
	}

	saveSettings() {
		this.debouncedSaveSettings();
	}

	async activateTerminalView(sessionName?: string): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
			state: sessionName ? { sessionName } : {},
		});
		this.app.workspace.revealLeaf(leaf);
	}

	// ── Container actions ──────────────────────────────────

	private async startContainer(): Promise<void> {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: async () => {
				await this.ensureWriteDir();
				return this.docker.start();
			},
			postState: "running",
			successMsg: "Sandbox container started.",
			failurePrefix: "Failed to start container",
		});
		if (ok) {
			await this.applyFirewallAfterStart();
			this.startHealthPoll();
		}
	}

	private async stopContainer(): Promise<void> {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		await this.runDockerCommand({
			action: () => this.docker.stop(),
			postState: "stopped",
			successMsg: "Sandbox container stopped.",
			failurePrefix: "Failed to stop container",
		});
		this.firewallBar.setState("hidden");
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.stopHealthPoll();
	}

	private async restartContainer(): Promise<void> {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: () => this.docker.restart(),
			postState: "running",
			successMsg: "Sandbox container restarted.",
			failurePrefix: "Failed to restart container",
		});
		if (ok) {
			await this.applyFirewallAfterStart();
			this.startHealthPoll();
		}
	}

	private async applyFirewallAfterStart(): Promise<void> {
		if (this.settings.autoEnableFirewall) {
			try {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
			} catch (error: unknown) {
				this.firewallBar.setState("disabled");
				new Notice(
					`Auto-enable firewall failed: ${toErrorMessage(error)}. You can enable it manually from the status bar.`,
				);
			}
		} else {
			await this.refreshFirewallStatus();
		}
		this.updateTooltip();
	}

	// ── Firewall ───────────────────────────────────────────

	private async toggleFirewall(): Promise<void> {
		if (this.firewallBar.getState() === "hidden") {
			new Notice("Container is not running. Start it first.");
			return;
		}
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		try {
			if (this.firewallBar.getState() === "enabled") {
				await this.docker.disableFirewall();
				this.firewallBar.setState("disabled");
				new Notice("Firewall disabled.");
			} else {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
				new Notice("Firewall enabled.");
			}
			this.updateTooltip();
		} catch (error: unknown) {
			new Notice(`Firewall toggle failed: ${toErrorMessage(error)}`);
		}
	}

	private async refreshFirewallStatus(): Promise<void> {
		try {
			const fwOn = await this.docker.firewallStatus();
			this.firewallBar.setState(fwOn ? "enabled" : "disabled");
		} catch {
			this.firewallBar.setState("hidden");
		}
	}

	// ── MCP server ────────────────────────────────────────

	private getEnabledTiers(): Set<PermissionTier> {
		const tiers = new Set<PermissionTier>();
		if (this.settings.mcpTierRead) tiers.add("read");
		if (this.settings.mcpTierWriteScoped) tiers.add("writeScoped");
		if (this.settings.mcpTierWriteVault) tiers.add("writeVault");
		if (this.settings.mcpTierNavigate) tiers.add("navigate");
		if (this.settings.mcpTierManage) tiers.add("manage");
		return tiers;
	}

	private async startMcpServer(): Promise<void> {
		if (this.mcpServer?.isRunning()) return;
		try {
			this.mcpServer = new ObsidianMcpServer(this.app, {
				port: this.settings.mcpPort,
				token: this.settings.mcpToken,
				enabledTiers: this.getEnabledTiers(),
				getWriteDir: () => this.settings.vaultWriteDir,
			});
			await this.mcpServer.start();
		} catch (error: unknown) {
			new Notice(`MCP server failed to start: ${toErrorMessage(error)}`);
		}
	}

	private async stopMcpServer(): Promise<void> {
		if (!this.mcpServer) return;
		await this.mcpServer.stop();
		this.mcpServer = null;
	}

	private async toggleMcpServer(): Promise<void> {
		if (this.mcpServer?.isRunning()) {
			await this.stopMcpServer();
			this.settings.mcpEnabled = false;
			this.saveSettings();
			new Notice("MCP server stopped.");
		} else {
			this.settings.mcpEnabled = true;
			this.saveSettings();
			await this.startMcpServer();
			if (this.mcpServer?.isRunning()) {
				new Notice(`MCP server listening on port ${this.settings.mcpPort}.`);
			}
		}
	}

	// ── Status bar menu ────────────────────────────────────

	private async showStatusMenu(evt: MouseEvent): Promise<void> {
		const menu = new Menu();
		const busy = this.docker.isBusy();
		const running = this.statusBar.getState() === "running";

		menu.addItem((item) =>
			item
				.setTitle("Start Container")
				.setIcon("play")
				.setDisabled(busy)
				.onClick(() => this.startContainer()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Stop Container")
				.setIcon("square")
				.setDisabled(busy || !running)
				.onClick(() => this.stopContainer()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Restart Container")
				.setIcon("refresh-cw")
				.setDisabled(busy || !running)
				.onClick(() => this.restartContainer()),
		);
		menu.addSeparator();

		const fwEnabled = this.firewallBar.getState() === "enabled";
		menu.addItem((item) =>
			item
				.setTitle(fwEnabled ? "Disable Firewall" : "Enable Firewall")
				.setIcon("shield")
				.setDisabled(busy || !running)
				.onClick(() => this.toggleFirewall()),
		);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("New Terminal")
				.setIcon("terminal")
				.setDisabled(!running)
				.onClick(() => this.activateTerminalView()),
		);
		menu.addItem((item) =>
			item
				.setTitle("New Session...")
				.setIcon("plus")
				.setDisabled(!running)
				.onClick(async () => {
					const name = await this.promptSessionName("New Session");
					if (name) this.activateTerminalView(name);
				}),
		);

		if (running) {
			const sessions = await this.docker.listSessions();
			for (const name of sessions) {
				menu.addItem((item) =>
					item
						.setTitle(`Attach: ${name}`)
						.setIcon("arrow-right")
						.onClick(() => this.activateTerminalView(name)),
				);
			}
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Open in Browser")
				.setIcon("external-link")
				.setDisabled(!running)
				.onClick(() => window.open(`http://localhost:${this.settings.ttydPort}`)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Check Status")
				.setIcon("activity")
				.onClick(() => this.containerStatus()),
		);

		menu.showAtMouseEvent(evt);
	}

	// ── Tooltip ────────────────────────────────────────────

	private updateTooltip(): void {
		const fwState = this.firewallBar.getState();
		const fwLabel =
			fwState === "enabled" ? "enabled" : fwState === "disabled" ? "disabled" : "n/a";
		const lines = [
			"Container: running",
			`Port: ${this.settings.ttydPort}`,
			`Firewall: ${fwLabel}`,
			"",
			"Click for options",
		];
		this.statusBar.setDetails(lines.join("\n"));
	}

	// ── Background startup ────────────────────────────

	private async backgroundStartup(): Promise<void> {
		this.statusBar.setState("checking");
		this.statusBar.setDetails("Checking Docker availability...");

		// Step 1: Wake WSL if needed (fast-fail 5s)
		try {
			await this.docker.ensureWslReady();
		} catch (error: unknown) {
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`WSL error: ${msg}\nClick for options`);
			new Notice(`Sandbox: ${msg}`);
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			return;
		}

		// Step 2: Quick status probe (5s timeout instead of 30s)
		try {
			const output = await this.docker.probeStatus();
			const isRunning = DockerManager.parseIsRunning(output);
			if (!isRunning) {
				this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			}
			await this.syncStatusBar(isRunning);

			// Step 3: Auto-start if configured and not already running
			if (this.settings.autoStartContainer && !isRunning) {
				await this.startContainer();
			}

			this.startHealthPoll();
		} catch (error: unknown) {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`Docker error: ${msg}\nClick for options`);
			new Notice(`Sandbox: ${msg}`);
		}
	}

	// ── Health poll ───────────────────────────────────

	private startHealthPoll(): void {
		this.stopHealthPoll();
		this.healthPollId = this.registerInterval(
			window.setInterval(() => void this.healthCheck(), HEALTH_POLL_INTERVAL),
		);
	}

	private stopHealthPoll(): void {
		if (this.healthPollId != null) {
			window.clearInterval(this.healthPollId);
			this.healthPollId = null;
		}
	}

	private async healthCheck(): Promise<void> {
		if (this.docker.isBusy()) return;
		try {
			const output = await this.docker.probeStatus();
			const isRunning = DockerManager.parseIsRunning(output);
			await this.syncStatusBar(isRunning);
		} catch (error: unknown) {
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`Docker error: ${msg}\nClick for options`);
			this.stopHealthPoll();
		}
	}

	// ── Session prompt ─────────────────────────────────────

	private promptSessionName(title: string, defaultValue = ""): Promise<string | null> {
		return new Promise((resolve) => {
			let resolved = false;
			const modal = new Modal(this.app);
			modal.titleEl.setText(title);
			const input = modal.contentEl.createEl("input", {
				type: "text",
				placeholder: "e.g. work, research, debug",
				value: defaultValue,
			});
			input.style.width = "100%";
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const val = input.value.trim();
					resolved = true;
					modal.close();
					resolve(val || null);
				}
				if (e.key === "Escape") {
					resolved = true;
					modal.close();
					resolve(null);
				}
			});
			modal.onClose = () => {
				if (!resolved) resolve(null);
			};
			modal.open();
			input.focus();
		});
	}

	// ── Helpers ────────────────────────────────────────────

	private async ensureWriteDir(): Promise<void> {
		const dir = this.settings.vaultWriteDir;
		if (!dir) return;
		if (!isValidWriteDir(dir)) {
			throw new Error("Invalid vault write directory.");
		}
		try {
			if (!(await this.app.vault.adapter.exists(dir))) {
				await this.app.vault.createFolder(dir);
			}
		} catch {
			/* folder may already exist from concurrent start */
		}
	}

	private async runDockerCommand(opts: {
		preState?: ContainerState;
		action: () => Promise<string>;
		postState: ContainerState;
		successMsg: string;
		failurePrefix: string;
	}): Promise<boolean> {
		try {
			if (opts.preState) {
				this.statusBar.setState(opts.preState);
				this.statusBar.setDetails("Container is starting up...");
			}
			await opts.action();
			this.statusBar.setState(opts.postState);
			new Notice(opts.successMsg);
			return true;
		} catch (error: unknown) {
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`Container error: ${msg}\nClick for options`);
			new Notice(`${opts.failurePrefix}: ${msg}`);
			return false;
		}
	}

	private async containerStatus(): Promise<void> {
		try {
			const output = await this.docker.status();
			const isRunning = DockerManager.parseIsRunning(output);
			await this.syncStatusBar(isRunning);
			new Notice(isRunning ? "Container is running" : "Container is stopped");
			this.startHealthPoll();
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to get status: ${toErrorMessage(error)}`);
		}
	}

	/**
	 * Update the status bar + firewall indicator + tooltip from a known
	 * container state. Shared by the onLayoutReady hydration path and
	 * the explicit "Check Status" command so both produce identical UI.
	 */
	private async syncStatusBar(isRunning: boolean): Promise<void> {
		this.statusBar.setState(isRunning ? "running" : "stopped");
		if (isRunning) {
			await this.refreshFirewallStatus();
			this.updateTooltip();
		} else {
			this.firewallBar.setState("hidden");
			this.statusBar.setDetails(TOOLTIP_STOPPED);
		}
	}
}
