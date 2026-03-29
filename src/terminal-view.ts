import type { WorkspaceLeaf } from "obsidian";
import { ItemView } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";

export const VIEW_TYPE_TERMINAL = "pkm-claude-terminal-view";

export interface TerminalViewSettings {
	ttydPort: number;
	ttydUser: string;
	ttydPassword: string;
}

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 1000;
const FETCH_TIMEOUT_MS = 5000;

// ttyd binary protocol: server sends raw bytes (number prefix),
// client sends text-prefixed binary frames (string prefix)
const TTYD_OUTPUT = 0;
const TTYD_INPUT = "0";
const TTYD_RESIZE = "1";

const textEncoder = new TextEncoder();

export class TerminalView extends ItemView {
	private settings: TerminalViewSettings;
	private generation = 0;
	private connecting = false;
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeRafId: number | null = null;

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
		this.generation++;
		await this.connect();
	}

	async onClose(): Promise<void> {
		this.generation++;
		this.dispose();
	}

	private async connect(): Promise<void> {
		if (this.connecting) return;
		this.connecting = true;
		const gen = this.generation;

		try {
			const container = this.contentEl;
			container.empty();

			const loading = container.createDiv({ cls: "pkm-terminal-loading" });
			loading.setText("Connecting to terminal...");

			let connected = false;

			for (let i = 0; i < MAX_RETRIES; i++) {
				if (gen !== this.generation) return;

				const controller = new AbortController();
				const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

				try {
					const resp = await fetch(`http://localhost:${this.settings.ttydPort}`, {
						signal: controller.signal,
					});
					if (resp.ok || resp.status === 401) {
						connected = true;
						break;
					}
				} catch {
					// Not ready yet
				} finally {
					clearTimeout(timeout);
				}

				if (gen !== this.generation) return;

				await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
			}

			if (gen !== this.generation) return;

			container.empty();

			if (connected) {
				await this.initTerminal(container, gen);
			} else {
				this.showError(
					container,
					"Could not connect to ttyd. Make sure the container is running.",
				);
			}
		} finally {
			this.connecting = false;
		}
	}

	private showError(container: HTMLElement, message: string): void {
		const errorDiv = container.createDiv({ cls: "pkm-terminal-error" });
		const msgEl = errorDiv.createEl("p");
		msgEl.setText(message);

		const retryBtn = errorDiv.createEl("button");
		retryBtn.setText("Retry");
		retryBtn.addEventListener("click", () => {
			this.connect();
		});
	}

	private async getAuthToken(): Promise<string> {
		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
		try {
			const resp = await fetch(`http://localhost:${this.settings.ttydPort}/token`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					username: this.settings.ttydUser,
					password: this.settings.ttydPassword,
				}),
				signal: controller.signal,
			});
			if (!resp.ok) throw new Error("Authentication failed");
			const data = (await resp.json()) as { token?: string };
			if (typeof data.token !== "string") {
				throw new Error("Invalid token response");
			}
			return data.token;
		} finally {
			clearTimeout(timeout);
		}
	}

	private async initTerminal(container: HTMLElement, gen: number): Promise<void> {
		const wrapper = container.createDiv({ cls: "pkm-terminal-container" });

		const styles = getComputedStyle(document.body);
		const fontFamily = styles.getPropertyValue("--font-monospace").trim() || "monospace";
		const theme = {
			background: styles.getPropertyValue("--background-primary").trim() || "#1e1e1e",
			foreground: styles.getPropertyValue("--text-normal").trim() || "#d4d4d4",
			cursor: styles.getPropertyValue("--text-accent").trim() || "#f0f0f0",
			selectionBackground: styles.getPropertyValue("--text-selection").trim() || "#264f78",
		};

		const term = new Terminal({
			cursorBlink: true,
			fontSize: 14,
			fontFamily,
			theme,
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(wrapper);
		try {
			fitAddon.fit();
		} catch {
			/* container may not be visible yet */
		}

		this.term = term;
		this.fitAddon = fitAddon;

		let wsUrl = `ws://localhost:${this.settings.ttydPort}/ws`;
		try {
			const token = await this.getAuthToken();
			wsUrl += `?token=${token}`;
		} catch {
			// ttyd may not require auth — connect without token
		}

		if (gen !== this.generation) return;

		const ws = new WebSocket(wsUrl);
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		ws.onmessage = (event) => {
			const data = new Uint8Array(event.data as ArrayBuffer);
			if (data[0] === TTYD_OUTPUT) {
				term.write(data.subarray(1));
			}
		};

		ws.onclose = () => {
			if (gen === this.generation) {
				term.write("\r\n\x1b[31m[Connection closed]\x1b[0m\r\n");
			}
		};

		ws.onerror = () => {
			if (gen === this.generation) {
				term.write("\r\n\x1b[31m[Connection error]\x1b[0m\r\n");
			}
		};

		term.onData((input) => {
			if (ws.readyState === WebSocket.OPEN) {
				ws.send(textEncoder.encode(TTYD_INPUT + input));
			}
		});

		term.onResize(({ cols, rows }) => {
			if (ws.readyState === WebSocket.OPEN) {
				const msg = TTYD_RESIZE + JSON.stringify({ columns: cols, rows: rows });
				ws.send(textEncoder.encode(msg));
			}
		});

		this.resizeObserver = new ResizeObserver(() => {
			if (this.resizeRafId != null) return;
			this.resizeRafId = requestAnimationFrame(() => {
				this.resizeRafId = null;
				if (this.fitAddon) {
					try {
						this.fitAddon.fit();
					} catch {
						/* pane not visible */
					}
				}
			});
		});
		this.resizeObserver.observe(wrapper);
	}

	private dispose(): void {
		if (this.resizeRafId != null) {
			cancelAnimationFrame(this.resizeRafId);
			this.resizeRafId = null;
		}
		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}
		if (this.resizeObserver) {
			this.resizeObserver.disconnect();
			this.resizeObserver = null;
		}
		if (this.fitAddon) {
			this.fitAddon.dispose();
			this.fitAddon = null;
		}
		if (this.term) {
			this.term.dispose();
			this.term = null;
		}
		this.contentEl.empty();
	}
}
