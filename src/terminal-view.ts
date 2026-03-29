import { ItemView, WorkspaceLeaf } from "obsidian";

export const VIEW_TYPE_TERMINAL = "pkm-claude-terminal-view";

export interface TerminalViewSettings {
	ttydPort: number;
	ttydUser: string;
	ttydPassword: string;
}

export class TerminalView extends ItemView {
	private settings: TerminalViewSettings;
	private iframe: HTMLIFrameElement | null = null;
	private destroyed = false;
	private connecting = false;

	constructor(leaf: WorkspaceLeaf, settings: TerminalViewSettings) {
		super(leaf);
		this.settings = settings;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return "Claude Terminal";
	}

	getIcon(): string {
		return "terminal";
	}

	async onOpen(): Promise<void> {
		this.destroyed = false;
		await this.connect();
	}

	async onClose(): Promise<void> {
		this.destroyed = true;
		this.iframe = null;
		this.contentEl.empty();
	}

	private async connect(): Promise<void> {
		if (this.connecting) return;
		this.connecting = true;

		try {
			const container = this.contentEl;
			container.empty();
			container.addClass("pkm-terminal-container");

			const loading = container.createDiv({ cls: "pkm-terminal-loading" });
			loading.setText("Connecting to terminal...");

			const baseUrl = `http://localhost:${this.settings.ttydPort}`;
			const connected = await this.pollTtyd(baseUrl, 30, 1000);

			if (this.destroyed) return;

			loading.remove();

			if (connected) {
				this.createIframe(container);
			} else {
				this.showError(container);
			}
		} finally {
			this.connecting = false;
		}
	}

	private async pollTtyd(
		url: string,
		maxRetries: number,
		delayMs: number
	): Promise<boolean> {
		for (let i = 0; i < maxRetries; i++) {
			if (this.destroyed) return false;
			const controller = new AbortController();
			const timeoutId = setTimeout(() => controller.abort(), 5000);
			try {
				const response = await fetch(url, {
					signal: controller.signal,
				});
				if (response.ok || response.status === 401) {
					return true;
				}
			} catch {
				// Connection not ready yet
			} finally {
				clearTimeout(timeoutId);
			}
			if (this.destroyed) return false;
			if (i < maxRetries - 1) {
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}
		return false;
	}

	private createIframe(container: HTMLElement): void {
		const user = encodeURIComponent(this.settings.ttydUser);
		const password = encodeURIComponent(this.settings.ttydPassword);
		const url = `http://${user}:${password}@localhost:${this.settings.ttydPort}`;

		this.iframe = container.createEl("iframe", {
			cls: "pkm-terminal-iframe",
			attr: {
				src: url,
			},
		});
	}

	private showError(container: HTMLElement): void {
		const errorDiv = container.createDiv({ cls: "pkm-terminal-error" });
		errorDiv.createEl("p", {
			text: "Failed to connect to the terminal. Ensure the container is running and ttyd is available.",
		});
		const retryBtn = errorDiv.createEl("button", { text: "Retry" });
		retryBtn.addEventListener("click", () => {
			this.connect();
		});
	}
}
