import { Notice, Plugin } from "obsidian";
import { DockerManager } from "./docker";
import { StatusBarManager } from "./status-bar";

interface PkmClaudeTerminalSettings {
	composePath: string;
	wslDistro: string;
	autoStart: boolean;
	autoStop: boolean;
}

const DEFAULT_SETTINGS: PkmClaudeTerminalSettings = {
	composePath: "~/pkm-claude-terminal",
	wslDistro: "Ubuntu",
	autoStart: false,
	autoStop: false,
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export default class PkmClaudeTerminalPlugin extends Plugin {
	private docker!: DockerManager;
	private statusBar!: StatusBarManager;
	private settings: PkmClaudeTerminalSettings = DEFAULT_SETTINGS;

	async onload() {
		this.docker = new DockerManager({
			composePath: this.settings.composePath,
			wslDistro: this.settings.wslDistro,
		});

		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(statusBarEl);

		this.addCommand({
			id: "pkm-start-container",
			name: "PKM: Start Container",
			callback: () => this.startContainer(),
		});

		this.addCommand({
			id: "pkm-stop-container",
			name: "PKM: Stop Container",
			callback: () => this.stopContainer(),
		});

		this.addCommand({
			id: "pkm-container-status",
			name: "PKM: Container Status",
			callback: () => this.containerStatus(),
		});

		this.addCommand({
			id: "pkm-restart-container",
			name: "PKM: Restart Container",
			callback: () => this.restartContainer(),
		});

		if (this.settings.autoStart) {
			void this.startContainer();
		}
	}

	async onunload() {
		if (this.settings.autoStop) {
			try {
				await this.docker.stop();
			} catch {
				// Best effort on unload
			}
		}
	}

	private async startContainer(): Promise<void> {
		try {
			this.statusBar.setState("starting");
			await this.docker.start();
			this.statusBar.setState("running");
			new Notice("PKM container started.");
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to start container: ${toErrorMessage(error)}`);
		}
	}

	private async stopContainer(): Promise<void> {
		try {
			await this.docker.stop();
			this.statusBar.setState("stopped");
			new Notice("PKM container stopped.");
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to stop container: ${toErrorMessage(error)}`);
		}
	}

	private async containerStatus(): Promise<void> {
		try {
			const output = await this.docker.status();
			this.statusBar.setState(
				DockerManager.parseIsRunning(output) ? "running" : "stopped"
			);
			new Notice(`Container status:\n${output || "No containers found."}`);
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to get status: ${toErrorMessage(error)}`);
		}
	}

	private async restartContainer(): Promise<void> {
		try {
			this.statusBar.setState("starting");
			await this.docker.restart();
			this.statusBar.setState("running");
			new Notice("PKM container restarted.");
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to restart container: ${toErrorMessage(error)}`);
		}
	}
}
