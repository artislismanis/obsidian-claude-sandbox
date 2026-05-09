import type { Menu, ViewStateResult, WorkspaceLeaf } from "obsidian";
import { ItemView, Scope } from "obsidian";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import type { TerminalSettings, TerminalThemeMode } from "./settings";
import { logger } from "./logger";
import { refreshLeafHeader } from "./obsidian-internals";
import { pollUntilReady, buildWsUrl, exponentialBackoff } from "./ttyd-client";

import { VIEW_TYPE_TERMINAL } from "./view-types";
export { VIEW_TYPE_TERMINAL };

const MAX_RETRIES = 15;

// Auto-reconnect on abnormal close: a few quick attempts before surfacing an
// error. Container is almost always still running; the WebSocket just dropped.
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000];

// ttyd protocol command characters. Server↔client share ASCII values by direction:
// server-to-client and client-to-server use disjoint meanings for the same chars.
// ttyd server-to-client commands. Only OUTPUT is consumed; TITLE ('1') and
// PREFERENCES ('2') are ignored.
const SERVER_MSG = { OUTPUT: "0" } as const;
const CLIENT_MSG = { INPUT: "0", RESIZE: "1" } as const;

const textEncoder = new TextEncoder();

let nextInstanceId = 1;

// WebSocket close-code → human label. Helps interpret container-side drops.
const CLOSE_CODE_NAMES: Record<number, string> = {
	1000: "normal",
	1001: "going-away",
	1002: "protocol-error",
	1003: "unsupported-data",
	1005: "no-status",
	1006: "abnormal-no-close-frame",
	1007: "invalid-payload",
	1008: "policy-violation",
	1009: "message-too-big",
	1011: "internal-error",
	1012: "service-restart",
	1013: "try-again-later",
	1015: "tls-handshake",
};

function closeCodeName(code: number): string {
	return CLOSE_CODE_NAMES[code] ?? `code-${code}`;
}

export interface TerminalConnectionEvent {
	at: number;
	instanceId: number;
	gen: number;
	kind: "open" | "close" | "error" | "reconnect";
	code?: number;
	codeName?: string;
	reason?: string;
	durationMs?: number;
	rxBytes?: number;
	txBytes?: number;
	rxMsgs?: number;
	idleMsBeforeClose?: number;
	attempt?: number;
}

// Process-wide ring buffer of recent connection events. Surfaced via the
// "Sandbox: Copy terminal connection log" command for postmortem of drops.
const CONNECTION_LOG_MAX = 200;
const connectionLog: TerminalConnectionEvent[] = [];

function pushConnectionEvent(ev: TerminalConnectionEvent): void {
	connectionLog.push(ev);
	if (connectionLog.length > CONNECTION_LOG_MAX) {
		connectionLog.splice(0, connectionLog.length - CONNECTION_LOG_MAX);
	}
}

export function getTerminalConnectionLog(): TerminalConnectionEvent[] {
	return connectionLog.slice();
}

export type ActivityPrefix = "working" | "awaiting_input" | null;

const PREFIX_SYMBOL: Record<Exclude<ActivityPrefix, null>, string> = {
	working: "\u2699 ", // ⚙
	awaiting_input: "\u2753 ", // ❓
};

export class TerminalView extends ItemView {
	private getSettings: () => TerminalSettings;
	private instanceId: number;
	private generation = 0;
	private connecting = false;
	private sessionName: string | null = null;
	private activityPrefix: ActivityPrefix = null;
	private term: Terminal | null = null;
	private fitAddon: FitAddon | null = null;
	private ws: WebSocket | null = null;
	private resizeObserver: ResizeObserver | null = null;
	private resizeRafId: number | null = null;
	private termDisposables: { dispose(): void }[] = [];
	private wsDisposables: { dispose(): void }[] = [];

	// Lifecycle stats — reset per WS attach. Used for close diagnostics.
	private wsConnectStartedAt = 0;
	private wsOpenedAt = 0;
	private wsLastRxAt = 0;
	private wsRxBytes = 0;
	private wsTxBytes = 0;
	private wsRxMsgs = 0;
	private reconnectAttempt = 0;
	private reconnectTimer: number | null = null;
	private statusBanner: HTMLDivElement | null = null;

	onRenameSession: (() => void) | null = null;
	private initialPrompt: string | null = null;

	constructor(leaf: WorkspaceLeaf, getSettings: () => TerminalSettings) {
		super(leaf);
		this.getSettings = getSettings;
		this.instanceId = nextInstanceId++;
	}

	getViewType(): string {
		return VIEW_TYPE_TERMINAL;
	}

	getDisplayText(): string {
		const base = this.sessionName
			? `Session: ${this.sessionName}`
			: `Sandbox Terminal ${this.instanceId}`;
		const prefix = this.activityPrefix ? PREFIX_SYMBOL[this.activityPrefix] : "";
		return prefix + base;
	}

	getSessionName(): string | null {
		return this.sessionName;
	}

	/**
	 * Queue an initial prompt to run once the terminal connects. Passed to
	 * `claude` as a command-line argument so it works whether or not Claude
	 * Code is already auto-started by session.sh. Single-use: cleared after
	 * injection so reconnects don't replay it.
	 */
	queueInitialPrompt(prompt: string): void {
		this.initialPrompt = prompt;
	}

	setActivityPrefix(prefix: ActivityPrefix): void {
		if (this.activityPrefix === prefix) return;
		this.activityPrefix = prefix;
		// Ask Obsidian to re-read the display text for this tab.
		this.app.workspace.requestSaveLayout();
		refreshLeafHeader(this.leaf);
	}

	getIcon(): string {
		return "terminal";
	}

	getState(): Record<string, unknown> {
		return { sessionName: this.sessionName };
	}

	async setState(state: unknown, result: ViewStateResult): Promise<void> {
		if (state && typeof state === "object" && "sessionName" in state) {
			const name = (state as { sessionName?: string }).sessionName;
			this.sessionName = typeof name === "string" ? name : null;
		}
		await super.setState(state, result);
	}

	onPaneMenu(menu: Menu, source: string): void {
		super.onPaneMenu(menu, source);
		if (source === "tab-header" && this.sessionName) {
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle("Rename Session")
					.setIcon("pencil")
					.onClick(() => {
						this.onRenameSession?.();
					}),
			);
			menu.addItem((item) =>
				item
					.setTitle("Detach Session")
					.setIcon("log-out")
					.onClick(() => {
						this.leaf.detach();
					}),
			);
		}
	}

	async onOpen(): Promise<void> {
		this.generation++;

		// Obsidian's Scope system intercepts Escape for "navigate back" before
		// the DOM event reaches xterm.js. Register a Scope handler that blocks
		// Obsidian's navigation and manually sends the ESC byte (0x1b) over the
		// WebSocket. This is equivalent to what xterm.js does internally — it
		// translates Escape into the same 0x1b byte via onData → WebSocket.
		this.scope = new Scope(this.app.scope);
		this.scope.register([], "Escape", () => {
			if (this.ws && this.ws.readyState === WebSocket.OPEN) {
				const payload = new Uint8Array(2);
				payload[0] = CLIENT_MSG.INPUT.charCodeAt(0);
				payload[1] = 0x1b;
				this.ws.send(payload);
			}
			return false;
		});

		void this.connect();
	}

	async onClose(): Promise<void> {
		this.generation++;
		this.dispose();
	}

	onResize(): void {
		this.scheduleFit();
		if (this.term && this.app.workspace.activeLeaf === this.leaf) {
			this.term.focus();
		}
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
		logger.info("Terminal", `Connecting (gen ${gen})`);

		try {
			const container = this.contentEl;
			container.empty();

			const loading = container.createDiv({ cls: "sandbox-terminal-loading" });
			loading.setText("Connecting to terminal...");

			const settings = this.getSettings();
			const connected = await pollUntilReady(
				settings.ttydPort,
				MAX_RETRIES,
				exponentialBackoff,
				() => gen !== this.generation,
				(attempt, waitMs) => {
					if (gen !== this.generation) return;
					loading.setText(
						`Connecting to terminal… (attempt ${attempt + 2}/${MAX_RETRIES}, retry in ${Math.round(waitMs / 100) / 10}s)`,
					);
				},
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
			fontSize: settings.terminalFontSize,
			fontFamily,
			theme,
			scrollback: settings.terminalScrollback,
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

		// Clipboard: auto-copy on selection (opt-out via setting), Ctrl+Shift+V to paste
		this.termDisposables.push(
			term.onSelectionChange(() => {
				if (!this.getSettings().clipboardAutoCopy) return;
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

		// Forward xterm I/O to the *current* websocket via this.ws so a reconnect
		// (which swaps this.ws) keeps working without re-registering listeners.
		this.termDisposables.push(
			term.onData((input) => {
				const ws = this.ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					const payload = new Uint8Array(input.length * 3 + 1);
					payload[0] = CLIENT_MSG.INPUT.charCodeAt(0);
					const { written } = textEncoder.encodeInto(input, payload.subarray(1));
					this.wsTxBytes += (written ?? 0) + 1;
					ws.send(payload.subarray(0, (written ?? 0) + 1));
				}
			}),
		);

		this.termDisposables.push(
			term.onResize(({ cols, rows }) => {
				const ws = this.ws;
				if (ws && ws.readyState === WebSocket.OPEN) {
					const msg = CLIENT_MSG.RESIZE + JSON.stringify({ columns: cols, rows: rows });
					const bytes = textEncoder.encode(msg);
					this.wsTxBytes += bytes.length;
					ws.send(bytes);
				}
			}),
		);

		this.resizeObserver = new ResizeObserver(() => {
			this.scheduleFit();
		});
		this.resizeObserver.observe(wrapper);

		this.attachWebSocket(container, gen, /*isReconnect*/ false);
	}

	private attachWebSocket(container: HTMLElement, gen: number, isReconnect: boolean): void {
		const term = this.term;
		if (!term) return;

		// Tear down any prior socket listeners so close handlers don't fire twice.
		for (const d of this.wsDisposables) d.dispose();
		this.wsDisposables = [];
		if (this.ws) {
			try {
				this.ws.close();
			} catch {
				/* already closing */
			}
		}

		const settings = this.getSettings();
		const wsUrl = buildWsUrl(settings.ttydPort);
		const ws = new WebSocket(wsUrl, ["tty"]);
		ws.binaryType = "arraybuffer";
		this.ws = ws;

		this.wsConnectStartedAt = Date.now();
		this.wsOpenedAt = 0;
		this.wsLastRxAt = 0;
		this.wsRxBytes = 0;
		this.wsTxBytes = 0;
		this.wsRxMsgs = 0;

		logger.info(
			"Terminal",
			`WebSocket connecting to ${wsUrl} (gen ${gen}, instance ${this.instanceId}${isReconnect ? `, reconnect attempt ${this.reconnectAttempt}` : ""})`,
		);

		const onOpen = () => {
			this.wsOpenedAt = Date.now();
			const connectMs = this.wsOpenedAt - this.wsConnectStartedAt;
			logger.info(
				"Terminal",
				`WebSocket open (gen ${gen}, instance ${this.instanceId}, connect ${connectMs}ms${isReconnect ? `, reconnect ${this.reconnectAttempt}` : ""})`,
			);
			pushConnectionEvent({
				at: this.wsOpenedAt,
				instanceId: this.instanceId,
				gen,
				kind: "open",
				durationMs: connectMs,
				attempt: isReconnect ? this.reconnectAttempt : 0,
			});
			this.reconnectAttempt = 0;
			this.clearStatusBanner();

			const msg = JSON.stringify({ columns: term.cols, rows: term.rows });
			const handshake = textEncoder.encode(msg);
			this.wsTxBytes += handshake.length;
			ws.send(handshake);
			term.focus();

			if (isReconnect) {
				// Tell user that the WS reconnected; tmux/bash already preserves
				// shell state on the container side so no command replay is needed.
				term.writeln("");
				term.writeln("\x1b[33m[agent-sandbox] terminal reconnected\x1b[0m");
				return;
			}

			// Inject `session <name>` command to attach to a tmux session.
			// The 300ms delay gives bash time to render the prompt.
			if (this.sessionName) {
				const cmd = `session ${this.sessionName}\n`;
				setTimeout(() => {
					if (ws.readyState === WebSocket.OPEN && gen === this.generation) {
						const payload = new Uint8Array(cmd.length + 1);
						payload[0] = CLIENT_MSG.INPUT.charCodeAt(0);
						textEncoder.encodeInto(cmd, payload.subarray(1));
						this.wsTxBytes += cmd.length + 1;
						ws.send(payload.subarray(0, cmd.length + 1));
					}
				}, 300);
			}

			// Inject an initial Claude prompt (from "Analyze in Sandbox" / URI handler).
			// Runs after any session-attach command so it lands inside the tmux session.
			if (this.initialPrompt) {
				const escaped = this.initialPrompt.replace(/'/g, `'\\''`);
				const cmd = `claude '${escaped}'\n`;
				const delay = this.sessionName ? 700 : 300;
				setTimeout(() => {
					if (ws.readyState === WebSocket.OPEN && gen === this.generation) {
						const payload = new Uint8Array(cmd.length + 1);
						payload[0] = CLIENT_MSG.INPUT.charCodeAt(0);
						textEncoder.encodeInto(cmd, payload.subarray(1));
						this.wsTxBytes += cmd.length + 1;
						ws.send(payload.subarray(0, cmd.length + 1));
						this.initialPrompt = null;
					}
				}, delay);
			}
		};

		const onMessage = (event: MessageEvent) => {
			const rawData = event.data as ArrayBuffer;
			this.wsLastRxAt = Date.now();
			this.wsRxBytes += rawData.byteLength;
			this.wsRxMsgs++;
			const cmd = String.fromCharCode(new Uint8Array(rawData)[0]);

			// Only OUTPUT carries data we need; TITLE / PREFERENCES are ignored.
			if (cmd === SERVER_MSG.OUTPUT) {
				term.write(new Uint8Array(rawData, 1));
			}
		};

		const onClose = (event: CloseEvent) => {
			const now = Date.now();
			const opened = this.wsOpenedAt > 0;
			const sessionMs = opened ? now - this.wsOpenedAt : now - this.wsConnectStartedAt;
			const idleMs = this.wsLastRxAt > 0 ? now - this.wsLastRxAt : -1;
			const codeName = closeCodeName(event.code);
			const detail =
				`code=${event.code} (${codeName}) reason="${event.reason || ""}" wasClean=${event.wasClean} ` +
				`opened=${opened} sessionMs=${sessionMs} idleMsBeforeClose=${idleMs} ` +
				`rxBytes=${this.wsRxBytes} rxMsgs=${this.wsRxMsgs} txBytes=${this.wsTxBytes} ` +
				`gen=${gen} instance=${this.instanceId}`;
			const normal = event.code === 1000 || event.code === 1001 || event.code === 1005;
			if (normal) {
				logger.debug("Terminal", `WebSocket closed cleanly — ${detail}`);
			} else {
				logger.warn("Terminal", `WebSocket dropped — ${detail}`);
			}
			pushConnectionEvent({
				at: now,
				instanceId: this.instanceId,
				gen,
				kind: "close",
				code: event.code,
				codeName,
				reason: event.reason || undefined,
				durationMs: sessionMs,
				rxBytes: this.wsRxBytes,
				txBytes: this.wsTxBytes,
				rxMsgs: this.wsRxMsgs,
				idleMsBeforeClose: idleMs >= 0 ? idleMs : undefined,
			});

			if (gen !== this.generation) return;
			this.ws = null;

			if (normal) {
				// Server closed cleanly (e.g. container stop). Don't auto-reconnect.
				this.showError(container, "Connection closed. The container may have stopped.");
				return;
			}

			// Abnormal close — try to reconnect a few times before surfacing error.
			this.scheduleReconnect(container, gen);
		};

		const onError = () => {
			logger.error("Terminal", `WebSocket error (gen ${gen}, instance ${this.instanceId})`);
			pushConnectionEvent({
				at: Date.now(),
				instanceId: this.instanceId,
				gen,
				kind: "error",
			});
		};

		ws.addEventListener("open", onOpen);
		ws.addEventListener("message", onMessage);
		ws.addEventListener("close", onClose);
		ws.addEventListener("error", onError);
		this.wsDisposables.push({
			dispose: () => {
				ws.removeEventListener("open", onOpen);
				ws.removeEventListener("message", onMessage);
				ws.removeEventListener("close", onClose);
				ws.removeEventListener("error", onError);
			},
		});
	}

	private scheduleReconnect(container: HTMLElement, gen: number): void {
		if (gen !== this.generation) return;
		if (this.reconnectAttempt >= RECONNECT_BACKOFF_MS.length) {
			logger.warn(
				"Terminal",
				`Reconnect gave up after ${this.reconnectAttempt} attempts (instance ${this.instanceId})`,
			);
			this.showError(
				container,
				`Connection lost — could not reconnect after ${this.reconnectAttempt} attempts.`,
			);
			return;
		}
		const waitMs = RECONNECT_BACKOFF_MS[this.reconnectAttempt];
		this.reconnectAttempt++;
		this.showStatusBanner(
			`Connection dropped — reconnecting (attempt ${this.reconnectAttempt}/${RECONNECT_BACKOFF_MS.length}, in ${Math.round(waitMs / 100) / 10}s)…`,
		);
		pushConnectionEvent({
			at: Date.now(),
			instanceId: this.instanceId,
			gen,
			kind: "reconnect",
			attempt: this.reconnectAttempt,
		});
		this.reconnectTimer = window.setTimeout(() => {
			this.reconnectTimer = null;
			if (gen !== this.generation) return;
			this.attachWebSocket(container, gen, /*isReconnect*/ true);
		}, waitMs);
	}

	private showStatusBanner(text: string): void {
		const wrapper = this.contentEl.querySelector(".sandbox-terminal-container");
		if (!wrapper || !(wrapper instanceof HTMLElement)) return;
		if (!this.statusBanner) {
			this.statusBanner = wrapper.createDiv({
				cls: "sandbox-terminal-status",
			}) as HTMLDivElement;
		}
		this.statusBanner.setText(text);
	}

	private clearStatusBanner(): void {
		if (this.statusBanner) {
			this.statusBanner.remove();
			this.statusBanner = null;
		}
	}

	private dispose(): void {
		for (const d of this.termDisposables) d.dispose();
		this.termDisposables = [];
		for (const d of this.wsDisposables) d.dispose();
		this.wsDisposables = [];
		if (this.reconnectTimer != null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		this.reconnectAttempt = 0;
		this.clearStatusBanner();
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
