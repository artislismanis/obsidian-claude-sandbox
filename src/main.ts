import type { WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter, Notice, Plugin, debounce } from "obsidian";
import {
	type PkmClaudeTerminalSettings,
	DEFAULT_SETTINGS,
	PkmClaudeTerminalSettingTab,
} from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { StatusBarManager } from "./status-bar";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default class PkmClaudeTerminalPlugin extends Plugin {
	settings: PkmClaudeTerminalSettings = { ...DEFAULT_SETTINGS };
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
		this.addSettingTab(new PkmClaudeTerminalSettingTab(this.app, this));

		this.docker = new DockerManager(() => ({
			composePath: this.settings.dockerComposeFilePath,
			wslDistro: this.settings.wslDistroName,
			vaultPath:
				this.app.vault.adapter instanceof FileSystemAdapter
					? this.app.vault.adapter.getBasePath()
					: undefined,
		}));

		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(statusBarEl);

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			return new TerminalView(leaf, () => ({
				ttydPort: this.settings.ttydPort,
				ttydUsername: this.settings.ttydUsername,
				ttydPassword: this.settings.ttydPassword,
			}));
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

		const startContainer = () =>
			this.runDockerCommand({
				preState: "starting",
				action: () => this.docker.start(),
				postState: "running",
				successMsg: "PKM container started.",
				failurePrefix: "Failed to start container",
			});

		this.addCommand({
			id: "pkm-start-container",
			name: "PKM: Start Container",
			callback: startContainer,
		});

		this.addCommand({
			id: "pkm-stop-container",
			name: "PKM: Stop Container",
			callback: () =>
				this.runDockerCommand({
					action: () => this.docker.stop(),
					postState: "stopped",
					successMsg: "PKM container stopped.",
					failurePrefix: "Failed to stop container",
				}),
		});

		this.addCommand({
			id: "pkm-container-status",
			name: "PKM: Container Status",
			callback: () => this.containerStatus(),
		});

		this.addCommand({
			id: "pkm-restart-container",
			name: "PKM: Restart Container",
			callback: () =>
				this.runDockerCommand({
					preState: "starting",
					action: () => this.docker.restart(),
					postState: "running",
					successMsg: "PKM container restarted.",
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
		const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);

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
