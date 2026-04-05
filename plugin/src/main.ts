import type { WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter, Notice, Plugin, debounce } from "obsidian";
import { type AgentSandboxSettings, DEFAULT_SETTINGS, AgentSandboxSettingTab } from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { StatusBarManager } from "./status-bar";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default class AgentSandboxPlugin extends Plugin {
	settings: AgentSandboxSettings = { ...DEFAULT_SETTINGS };
	private docker!: DockerManager;
	private statusBar!: StatusBarManager;

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
			ttydUsername: this.settings.ttydUsername,
			ttydPassword: this.settings.ttydPassword,
		}));

		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(statusBarEl);

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			return new TerminalView(leaf, () => ({
				ttydPort: this.settings.ttydPort,
				ttydUsername: this.settings.ttydUsername,
				ttydPassword: this.settings.ttydPassword,
				terminalTheme: this.settings.terminalTheme,
			}));
		});

		this.addRibbonIcon("terminal", "Open Sandbox Terminal", () => {
			this.activateTerminalView();
		});

		this.addCommand({
			id: "open-claude-terminal",
			name: "Open Sandbox Terminal",
			callback: () => {
				this.activateTerminalView();
			},
		});

		const startContainer = () =>
			this.runDockerCommand({
				preState: "starting",
				action: async () => {
					await this.ensureWriteDir();
					return this.docker.start();
				},
				postState: "running",
				successMsg: "Sandbox container started.",
				failurePrefix: "Failed to start container",
			});

		this.addCommand({
			id: "sandbox-start-container",
			name: "Sandbox: Start Container",
			callback: startContainer,
		});

		this.addCommand({
			id: "sandbox-stop-container",
			name: "Sandbox: Stop Container",
			callback: () =>
				this.runDockerCommand({
					action: () => this.docker.stop(),
					postState: "stopped",
					successMsg: "Sandbox container stopped.",
					failurePrefix: "Failed to stop container",
				}),
		});

		this.addCommand({
			id: "sandbox-container-status",
			name: "Sandbox: Container Status",
			callback: () => this.containerStatus(),
		});

		this.addCommand({
			id: "sandbox-restart-container",
			name: "Sandbox: Restart Container",
			callback: () =>
				this.runDockerCommand({
					preState: "starting",
					action: () => this.docker.restart(),
					postState: "running",
					successMsg: "Sandbox container restarted.",
					failurePrefix: "Failed to restart container",
				}),
		});

		if (this.settings.autoStartContainer) {
			void startContainer();
		}
	}

	onunload() {
		this.debouncedSaveSettings();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);

		if (this.settings.autoStopContainer) {
			this.docker.stop().catch(() => {});
		}
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	saveSettings() {
		this.debouncedSaveSettings();
	}

	async activateTerminalView(): Promise<void> {
		const existingLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);

		let leaf: WorkspaceLeaf;
		if (existingLeaves.length > 0) {
			// Open as a tab next to existing terminals
			this.app.workspace.setActiveLeaf(existingLeaves[0], { focus: false });
			leaf = this.app.workspace.getLeaf("tab");
		} else {
			// First terminal: split to the bottom
			leaf = this.app.workspace.getLeaf("split", "horizontal");
		}

		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);
	}

	private async ensureWriteDir(): Promise<void> {
		const dir = this.settings.vaultWriteDir;
		if (!dir) return;
		if (!(await this.app.vault.adapter.exists(dir))) {
			await this.app.vault.createFolder(dir);
		}
	}

	private async runDockerCommand(opts: {
		preState?: ContainerState;
		action: () => Promise<string>;
		postState: ContainerState;
		successMsg: string;
		failurePrefix: string;
	}): Promise<void> {
		try {
			if (opts.preState) this.statusBar.setState(opts.preState);
			await opts.action();
			this.statusBar.setState(opts.postState);
			new Notice(opts.successMsg);
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`${opts.failurePrefix}: ${toErrorMessage(error)}`);
		}
	}

	private async containerStatus(): Promise<void> {
		try {
			const output = await this.docker.status();
			this.statusBar.setState(DockerManager.parseIsRunning(output) ? "running" : "stopped");
			new Notice(`Container status:\n${output || "No containers found."}`);
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to get status: ${toErrorMessage(error)}`);
		}
	}
}
