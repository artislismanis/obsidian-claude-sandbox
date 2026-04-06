import type { WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter, Menu, Notice, Plugin, debounce } from "obsidian";
import { type AgentSandboxSettings, DEFAULT_SETTINGS, AgentSandboxSettingTab } from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { FirewallStatusBar, StatusBarManager } from "./status-bar";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";
import { isValidWriteDir } from "./validation";
import { WORKSPACE_README } from "./workspace-readme";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

const TOOLTIP_STOPPED = "Container is not running\nClick for options";

export default class AgentSandboxPlugin extends Plugin {
	settings: AgentSandboxSettings = { ...DEFAULT_SETTINGS };
	private docker!: DockerManager;
	private statusBar!: StatusBarManager;
	private firewallBar!: FirewallStatusBar;
	private statusBarEl: HTMLElement | null = null;
	private statusBarClickHandler: ((evt: MouseEvent) => void) | null = null;

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
			ttydPort: this.settings.ttydPort,
			ttydBindAddress: this.settings.ttydBindAddress,
			ttydUsername: this.settings.ttydUsername,
			ttydPassword: this.settings.ttydPassword,
			allowedPrivateHosts: this.settings.allowedPrivateHosts,
			containerMemory: this.settings.containerMemory,
			containerCpus: this.settings.containerCpus,
		}));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(this.statusBarEl);
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.statusBarClickHandler = (evt) => this.showStatusMenu(evt);
		this.statusBarEl.addEventListener("click", this.statusBarClickHandler);

		const fwBarEl = this.addStatusBarItem();
		this.firewallBar = new FirewallStatusBar(fwBarEl, () => this.toggleFirewall());

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			return new TerminalView(leaf, () => ({
				ttydPort: this.settings.ttydPort,
				ttydUsername: this.settings.ttydUsername,
				ttydPassword: this.settings.ttydPassword,
				terminalTheme: this.settings.terminalTheme,
				terminalFont: this.settings.terminalFont,
			}));
		});

		// Clear terminal tabs persisted from previous session (must wait
		// for layout restore to complete, otherwise leaves aren't there yet)
		this.app.workspace.onLayoutReady(() => {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		});

		this.addRibbonIcon("box", "Open Sandbox Terminal", () => {
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

		// Stop container on app quit (onunload only fires on plugin disable, not app exit)
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				if (this.settings.autoStopContainer) {
					tasks.add(async () => {
						this.docker.stopDetached();
					});
				}
			}),
		);

		if (this.settings.autoStartContainer) {
			void this.startContainer();
		}
	}

	onunload() {
		void this.saveData(this.settings);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		this.firewallBar.destroy();
		if (this.statusBarEl && this.statusBarClickHandler) {
			this.statusBarEl.removeEventListener("click", this.statusBarClickHandler);
		}

		if (this.settings.autoStopContainer) {
			this.docker.stopDetached();
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	saveSettings() {
		this.debouncedSaveSettings();
	}

	async activateTerminalView(): Promise<void> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
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
		if (ok) await this.applyFirewallAfterStart();
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
		if (ok) await this.applyFirewallAfterStart();
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
			this.firewallBar.setState("disabled");
		}
	}

	// ── Status bar menu ────────────────────────────────────

	private showStatusMenu(evt: MouseEvent): void {
		const menu = new Menu();
		const busy = this.docker.isBusy();

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
				.setDisabled(busy)
				.onClick(() => this.stopContainer()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Restart Container")
				.setIcon("refresh-cw")
				.setDisabled(busy)
				.onClick(() => this.restartContainer()),
		);
		menu.addSeparator();

		const fwEnabled = this.firewallBar.getState() === "enabled";
		menu.addItem((item) =>
			item
				.setTitle(fwEnabled ? "Disable Firewall" : "Enable Firewall")
				.setIcon("shield")
				.setDisabled(busy)
				.onClick(() => this.toggleFirewall()),
		);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Open Terminal")
				.setIcon("terminal")
				.onClick(() => this.activateTerminalView()),
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
		try {
			const readmePath = `${dir}/README.md`;
			if (!(await this.app.vault.adapter.exists(readmePath))) {
				await this.app.vault.adapter.write(readmePath, WORKSPACE_README);
			}
		} catch {
			/* README may already exist */
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
			this.statusBar.setState(isRunning ? "running" : "stopped");

			if (isRunning) {
				await this.refreshFirewallStatus();
				this.updateTooltip();
			} else {
				this.firewallBar.setState("hidden");
				this.statusBar.setDetails(TOOLTIP_STOPPED);
			}

			const friendly = isRunning ? "Container is running" : "Container is stopped";
			new Notice(friendly);
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to get status: ${toErrorMessage(error)}`);
		}
	}
}
