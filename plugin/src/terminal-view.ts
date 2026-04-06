import type { WorkspaceLeaf } from "obsidian";
import { ItemView } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalSettings, TerminalThemeMode } from "./settings";
import { pollUntilReady, fetchAuthToken, buildWsUrl } from "./ttyd-client";

export const VIEW_TYPE_TERMINAL = "agent-sandbox-terminal-view";

const MAX_RETRIES = 30;
const RETRY_DELAY_MS = 1000;

// ttyd protocol command characters (ASCII, same value for server and client)
const CMD_OUTPUT = "0";
const CMD_SET_WINDOW_TITLE = "1";
const CMD_SET_PREFERENCES = "2";
const CMD_INPUT = "0";
const CMD_RESIZE = "1";

const textEncoder = new TextEncoder();

let nextInstanceId = 1;

export class TerminalView extends ItemView {
	private getSettings: () => TerminalSettings;
	private instanceId: number;
	private generation = 0;
	private connecting = false;
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeRafId: number | null = null;
	private termDisposables: { dispose(): void }[] = [];

	constructor(leaf: WorkspaceLeaf, getSettings: () => TerminalSettings) {
		super(leaf);
		this.getSettings = getSettings;
		this.instanceId = nextInstanceId++;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		return `Sandbox Terminal ${this.instanceId}`;
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

	onResize(): void {
		this.scheduleFit();
	}

	private scheduleFit(): void {
		if (this.resizeRafId != null) {
			cancelAnimationFrame(this.resizeRafId);
		}
		// Delay fit to let Obsidian finish layout transitions
		this.resizeRafId = requestAnimationFrame(() => {
			this.resizeRafId = null;
			if (!this.fitAddon || !this.term) return;
			const el = this.contentEl.querySelector(".sandbox-terminal-container");
			if (!el || el.clientWidth < 10 || el.clientHeight < 10) return;
			try {
				this.fitAddon.fit();
			} catch {
				/* pane not visible */
			}
		});
	}

	private async connect(): Promise<void> {
		if (this.connecting) return;
		this.connecting = true;
		const gen = this.generation;

		try {
			const container = this.contentEl;
			container.empty();

			const loading = container.createDiv({ cls: "sandbox-terminal-loading" });
			loading.setText("Connecting to terminal...");

			const settings = this.getSettings();
			const connected = await pollUntilReady(
				settings.ttydPort,
				MAX_RETRIES,
				RETRY_DELAY_MS,
				() => gen !== this.generation,
			);

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
		this.dispose();
		container.empty();
		const errorDiv = container.createDiv({ cls: "sandbox-terminal-error" });
		errorDiv.createEl("p").setText(message);
		const retryBtn = errorDiv.createEl("button");
		retryBtn.setText("Retry");
		retryBtn.addEventListener("click", () => {
			void this.connect();
		});
	}

	private buildTheme(
		mode: TerminalThemeMode,
		userFont?: string,
	): {
		fontFamily: string;
		theme: {
			background: string;
			foreground: string;
			cursor: string;
			selectionBackground: string;
		};
	} {
		const styles = getComputedStyle(document.body);
		const obsidianFont = styles.getPropertyValue("--font-monospace").trim();
		const fontFamily = [
			userFont?.trim(),
			obsidianFont,
			"Cascadia Code",
			"Cascadia Mono",
			"Consolas",
			"Menlo",
			"DejaVu Sans Mono",
			"monospace",
		]
			.filter(Boolean)
			.join(", ");

		if (mode === "dark") {
			return {
				fontFamily,
				theme: {
					background: "#1e1e1e",
					foreground: "#d4d4d4",
					cursor: "#f0f0f0",
					selectionBackground: "#264f78",
				},
			};
		}

		if (mode === "light") {
			return {
				fontFamily,
				theme: {
					background: "#ffffff",
					foreground: "#383a42",
					cursor: "#526eff",
					selectionBackground: "#add6ff",
				},
			};
		}

		// "obsidian" — follow current Obsidian theme
		return {
			fontFamily,
			theme: {
				background: styles.getPropertyValue("--background-primary").trim() || "#1e1e1e",
				foreground: styles.getPropertyValue("--text-normal").trim() || "#d4d4d4",
				cursor: styles.getPropertyValue("--text-accent").trim() || "#f0f0f0",
				selectionBackground:
					styles.getPropertyValue("--text-selection").trim() || "#264f78",
			},
		};
	}

	private async initTerminal(container: HTMLElement, gen: number): Promise<void> {
		const wrapper = container.createDiv({ cls: "sandbox-terminal-container" });

		const settings = this.getSettings();
		const { fontFamily, theme } = this.buildTheme(
			settings.terminalTheme,
			settings.terminalFont,
		);

		const term = new Terminal({
			cursorBlink: true,
			fontSize: 14,
			fontFamily,
			theme,
			rightClickSelectsWord: true,
		});

		const fitAddon = new FitAddon();
		term.loadAddon(fitAddon);
		term.open(wrapper);
		try {
			fitAddon.fit();
		} catch {
			/* container may not be visible yet */
		}

		// Clipboard: auto-copy on selection, Ctrl+Shift+V to paste
		this.termDisposables.push(
			term.onSelectionChange(() => {
				const selection = term.getSelection();
				if (selection) {
					navigator.clipboard.writeText(selection).catch(() => {});
				}
			}),
		);

		term.attachCustomKeyEventHandler((event) => {
			if (event.ctrlKey && event.shiftKey && event.key === "V" && event.type === "keydown") {
				navigator.clipboard.readText().then(
					(text) => term.paste(text),
					() => {},
				);
				return false;
			}
			return true;
		});

		this.term = term;
		this.fitAddon = fitAddon;

		let token: string | undefined;
		if (settings.ttydPassword) {
			token = await fetchAuthToken(
				settings.ttydPort,
				settings.ttydUsername,
				settings.ttydPassword,
			);
		}

		if (gen !== this.generation) return;

		const wsUrl = buildWsUrl(settings.ttydPort);
		const ws = new WebSocket(wsUrl, ["tty"]);
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		ws.onopen = () => {
			const msg = JSON.stringify({
				AuthToken: token ?? "",
				columns: term.cols,
				rows: term.rows,
			});
			ws.send(textEncoder.encode(msg));
			term.focus();
		};

		ws.onmessage = (event) => {
			const rawData = event.data as ArrayBuffer;
			const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);

			switch (cmd) {
				case CMD_OUTPUT:
					term.write(new Uint8Array(rawData, 1));
					break;
				case CMD_SET_WINDOW_TITLE:
					// Could set document title; ignored for Obsidian
					break;
				case CMD_SET_PREFERENCES:
					// Server preferences; ignored
					break;
			}
		};

		ws.onclose = () => {
			if (gen === this.generation) {
				this.showError(container, "Connection closed. The container may have stopped.");
			}
		};

		ws.onerror = () => {
			// onclose always fires after onerror, so error handling is done there
		};

		this.termDisposables.push(
			term.onData((input) => {
				if (ws.readyState === WebSocket.OPEN) {
					const payload = new Uint8Array(input.length * 3 + 1);
					payload[0] = CMD_INPUT.charCodeAt(0);
					const { written } = textEncoder.encodeInto(input, payload.subarray(1));
					ws.send(payload.subarray(0, (written ?? 0) + 1));
				}
			}),
		);

		this.termDisposables.push(
			term.onResize(({ cols, rows }) => {
				if (ws.readyState === WebSocket.OPEN) {
					const msg = CMD_RESIZE + JSON.stringify({ columns: cols, rows: rows });
					ws.send(textEncoder.encode(msg));
				}
			}),
		);

		this.resizeObserver = new ResizeObserver(() => {
			this.scheduleFit();
		});
		this.resizeObserver.observe(wrapper);
	}

	private dispose(): void {
		for (const d of this.termDisposables) d.dispose();
		this.termDisposables = [];
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
