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

// Auto-reconnect on abnormal close. Container is almost always still running;
// the WebSocket just dropped (Obsidian sleep, brief network hiccup). Be more
// patient than the initial connect because reconnects happen during *active*
// use — a "could not reconnect" error mid-session is much more disruptive
// than a slow first connect when the user is waiting anyway.
const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000, 8000, 8000, 8000];

// ttyd wire protocol — single-byte command prefix. Each direction has its own
// meanings for the same ASCII codes; we only consume OUTPUT inbound.
const SERVER_MSG = { OUTPUT: 0x30 } as const;
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

/**
 * Send a ttyd INPUT frame (`'0' + UTF-8 bytes`) over the socket, returning the
 * number of bytes written or 0 if the socket isn't open. Encodes the text
 * exactly once and prefixes the command byte — no over-allocation guesswork.
 */
function sendInputText(ws: WebSocket | null, text: string): number {
	if (!ws || ws.readyState !== WebSocket.OPEN) return 0;
	const encoded = textEncoder.encode(text);
	const payload = new Uint8Array(encoded.length + 1);
	payload[0] = CLIENT_MSG.INPUT.charCodeAt(0);
	payload.set(encoded, 1);
	ws.send(payload);
	return payload.length;
}

export function getTerminalConnectionLog(): TerminalConnectionEvent[] {
	return connectionLog.slice();
}

/**
 * Reset the process-wide connection-log ring and instance counter. Call from
 * plugin onload so events from a previous plugin lifecycle (Obsidian caches
 * the module across disable+enable) don't bleed into postmortems for the
 * current session.
 */
export function resetTerminalConnectionLog(): void {
	connectionLog.length = 0;
	nextInstanceId = 1;
}

/** Format a connection event ring buffer for the "Copy connection log" command. */
export function formatConnectionLog(events: TerminalConnectionEvent[]): string {
	return events
		.map((e) => {
			const ts = new Date(e.at).toISOString();
			const head = `${ts}  inst=${e.instanceId} gen=${e.gen} ${e.kind}`;
			const parts: string[] = [];
			if (e.code != null) parts.push(`code=${e.code}(${e.codeName})`);
			if (e.reason) parts.push(`reason="${e.reason}"`);
			if (e.durationMs != null) parts.push(`duration=${e.durationMs}ms`);
			if (e.idleMsBeforeClose != null) parts.push(`idleBeforeClose=${e.idleMsBeforeClose}ms`);
			if (e.rxBytes != null) parts.push(`rx=${e.rxBytes}b/${e.rxMsgs}msgs`);
			if (e.txBytes != null) parts.push(`tx=${e.txBytes}b`);
			if (e.attempt) parts.push(`attempt=${e.attempt}`);
			return parts.length ? `${head}  ${parts.join(" ")}` : head;
		})
		.join("\n");
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
	private wsDispose: (() => void) | null = null;

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
	// Tracked timers for the post-WS-open input-injection sequence (session
	// attach + initial prompt). Cleared in dispose() so a rapid view-close
	// can't fire them after the underlying ws/term refs are gone.
	private injectionTimers: number[] = [];

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

	/** Append a connection event with `at`/`instanceId` filled in. */
	private logEvent(
		gen: number,
		kind: TerminalConnectionEvent["kind"],
		extra: Partial<TerminalConnectionEvent> = {},
	): void {
		pushConnectionEvent({
			at: extra.at ?? Date.now(),
			instanceId: this.instanceId,
			gen,
			kind,
			...extra,
		});
	}

	setActivityPrefix(prefix: ActivityPrefix): void {
		if (this.activityPrefix === prefix) return;
		this.activityPrefix = prefix;
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

	private scopeInstalled = false;

	async onOpen(): Promise<void> {
		this.generation++;

		// Obsidian's Scope system intercepts Escape for "navigate back" before
		// the DOM event reaches xterm.js. Register a Scope handler that blocks
		// Obsidian's navigation and routes the ESC byte through xterm's input
		// pipeline so wsTxBytes accounting and any onData chain stay consistent.
		// Idempotency guard: onOpen is invoked again after Obsidian restores a
		// persisted leaf without first popping our previous Scope, so without
		// this flag we'd allocate a new Scope each time and leak the prior one
		// (the user only sees the most-recent one's Escape binding work).
		if (!this.scopeInstalled) {
			this.scope = new Scope(this.app.scope);
			this.scope.register([], "Escape", () => {
				this.term?.input("\x1b");
				return false;
			});
			this.scopeInstalled = true;
		}

		void this.connect();
	}

	async onClose(): Promise<void> {
		this.generation++;
		this.dispose();
		this.scopeInstalled = false;
	}

	onResize(): void {
		this.scheduleFit();
		// No focus call here — stealing focus on every resize (which fires when
		// other panes change layout, not just user interaction) is disruptive.
		// xterm focuses naturally on click/hotkey.
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
		// registerDomEvent is the Component-managed addEventListener: Obsidian
		// removes it automatically when this view is unloaded, so a rapid
		// view-close while the error UI is showing can't leak a closure
		// holding `this` (and the disposed term + ws) past the view's life.
		this.registerDomEvent(retryBtn, "click", () => {
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

		const cssVar = (name: string, fallback: string) =>
			styles.getPropertyValue(name).trim() || fallback;

		type ThemeColors = {
			background: string;
			foreground: string;
			cursor: string;
			selectionBackground: string;
		};

		const THEMES: Record<TerminalThemeMode, () => ThemeColors> = {
			dark: () => ({
				background: "#1e1e1e",
				foreground: "#d4d4d4",
				cursor: "#f0f0f0",
				selectionBackground: "#264f78",
			}),
			light: () => ({
				background: "#ffffff",
				foreground: "#383a42",
				cursor: "#526eff",
				selectionBackground: "#add6ff",
			}),
			obsidian: () => ({
				background: cssVar("--background-primary", "#1e1e1e"),
				foreground: cssVar("--text-normal", "#d4d4d4"),
				cursor: cssVar("--text-accent", "#f0f0f0"),
				selectionBackground: cssVar("--text-selection", "#264f78"),
			}),
		};

		return { fontFamily, theme: THEMES[mode]() };
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
				if (!selection) return;
				// navigator.clipboard.writeText silently throws DOMException
				// "Document is not focused" when Obsidian's window has lost
				// focus mid-selection (e.g. user dragged across, clicked away).
				// Skip the write rather than emitting a noisy console warning.
				if (typeof document !== "undefined" && !document.hasFocus()) return;
				navigator.clipboard.writeText(selection).catch(() => {});
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
				this.wsTxBytes += sendInputText(this.ws, input);
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
		this.wsDispose?.();
		this.wsDispose = null;
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
			this.logEvent(gen, "open", {
				at: this.wsOpenedAt,
				durationMs: connectMs,
				attempt: isReconnect ? this.reconnectAttempt : 0,
			});
			this.reconnectAttempt = 0;
			this.clearStatusBanner();

			const msg = JSON.stringify({ columns: term.cols, rows: term.rows });
			const handshake = textEncoder.encode(msg);
			this.wsTxBytes += handshake.length;
			ws.send(handshake);
			// Focus only on the initial attach, not on reconnect — reconnects
			// happen unattended and stealing focus interrupts whatever the user
			// has switched to.
			if (!isReconnect) term.focus();

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
				const id = window.setTimeout(() => {
					if (gen === this.generation) {
						this.wsTxBytes += sendInputText(ws, cmd);
					}
				}, 300);
				this.injectionTimers.push(id);
			}

			// Inject an initial Claude prompt (from "Analyze in Sandbox" / URI handler).
			// Runs after any session-attach command so it lands inside the tmux session.
			//
			// Suppress terminal input during the wait window so a fast user keystroke
			// can't interleave with `claude '<escaped>'\n` — otherwise the injected
			// command would run with the user's bytes appended to it.
			if (this.initialPrompt) {
				const escaped = this.initialPrompt.replace(/'/g, `'\\''`);
				const cmd = `claude '${escaped}'\n`;
				const delay = this.sessionName ? 700 : 300;
				const wasStdinDisabled = term.options.disableStdin === true;
				term.options.disableStdin = true;
				const id = window.setTimeout(() => {
					try {
						if (gen !== this.generation) return;
						const sent = sendInputText(ws, cmd);
						if (sent > 0) {
							this.wsTxBytes += sent;
							this.initialPrompt = null;
						}
					} finally {
						// Re-enable input only on the still-current term — a fast
						// view close that swapped this.term should leave it alone.
						// Wrap the options setter: dispose() races this timer and
						// can null `term.options` mid-call, throwing TypeError out
						// of the finally block (which would otherwise propagate).
						if (this.term === term) {
							try {
								term.options.disableStdin = wasStdinDisabled;
							} catch {
								/* term disposed before re-enable landed */
							}
						}
					}
				}, delay);
				this.injectionTimers.push(id);
			}
		};

		const onMessage = (event: MessageEvent) => {
			const rawData = event.data as ArrayBuffer;
			this.wsLastRxAt = Date.now();
			this.wsRxBytes += rawData.byteLength;
			this.wsRxMsgs++;
			// Only OUTPUT carries data we need; TITLE / PREFERENCES are ignored.
			if (new Uint8Array(rawData, 0, 1)[0] === SERVER_MSG.OUTPUT) {
				term.write(new Uint8Array(rawData, 1));
			}
		};

		const onClose = (event: CloseEvent) => {
			const now = Date.now();
			// Defence-in-depth guards first: a stale close fired after the view
			// closed (gen drift) or after attachWebSocket swapped this.ws would
			// otherwise log freshly-zeroed counters and confuse observability.
			// Listener teardown via wsDispose normally prevents this.
			if (gen !== this.generation) return;
			if (this.ws !== ws) return;

			const opened = this.wsOpenedAt > 0;
			const sessionMs = opened ? now - this.wsOpenedAt : now - this.wsConnectStartedAt;
			const idleMs = this.wsLastRxAt > 0 ? now - this.wsLastRxAt : -1;
			const codeName = CLOSE_CODE_NAMES[event.code] ?? `code-${event.code}`;
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
			this.logEvent(gen, "close", {
				at: now,
				code: event.code,
				codeName,
				reason: event.reason || undefined,
				durationMs: sessionMs,
				rxBytes: this.wsRxBytes,
				txBytes: this.wsTxBytes,
				rxMsgs: this.wsRxMsgs,
				idleMsBeforeClose: idleMs >= 0 ? idleMs : undefined,
			});

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
			logger.error(
				"Terminal",
				`WebSocket error (gen ${gen}, instance ${this.instanceId}, url=${ws.url}, readyState=${ws.readyState})`,
			);
			this.logEvent(gen, "error");
		};

		ws.addEventListener("open", onOpen);
		ws.addEventListener("message", onMessage);
		ws.addEventListener("close", onClose);
		ws.addEventListener("error", onError);
		this.wsDispose = () => {
			ws.removeEventListener("open", onOpen);
			ws.removeEventListener("message", onMessage);
			ws.removeEventListener("close", onClose);
			ws.removeEventListener("error", onError);
		};
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
		this.logEvent(gen, "reconnect", { attempt: this.reconnectAttempt });
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
		this.wsDispose?.();
		this.wsDispose = null;
		if (this.reconnectTimer != null) {
			window.clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		for (const id of this.injectionTimers) window.clearTimeout(id);
		this.injectionTimers = [];
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
