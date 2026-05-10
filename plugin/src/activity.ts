/**
 * Activity feedback + agent-output notice plumbing.
 *
 * Kept out of main.ts so the plugin entry doesn't carry per-session UI
 * routing and debounce state inline. Two small managers:
 *
 * - `ActivityUi` — wires MCP `agent_status_set` updates into per-tab tab-title
 *   prefixes and the aggregate status-bar attention badge.
 * - `AgentOutputNotifier` — watches vault creates/modifies under the write
 *   directory, debounces bursts, rate-limits, and surfaces an Obsidian Notice.
 */

import type { App } from "obsidian";
import { Notice } from "obsidian";
import type { ActivityEntry } from "./mcp-server";
import type { StatusBarManager } from "./status-bar";
import type { ActivityPrefix, TerminalView } from "./terminal-view";
import { VIEW_TYPE_TERMINAL } from "./view-types";

/**
 * Structural-typed guard that doesn't import the TerminalView class — that
 * import would pull xterm.js into the (jsdom-free) unit test bundle. We
 * cross-check the leaf's view-type *and* the methods we need; a placeholder /
 * deferred view returned by Obsidian during reload won't satisfy both.
 */
function isTerminalViewLike(leafView: unknown): leafView is TerminalView {
	if (!leafView || typeof leafView !== "object") return false;
	const v = leafView as {
		getViewType?: () => string;
		getSessionName?: unknown;
		setActivityPrefix?: unknown;
	};
	return (
		typeof v.getViewType === "function" &&
		v.getViewType() === VIEW_TYPE_TERMINAL &&
		typeof v.getSessionName === "function" &&
		typeof v.setActivityPrefix === "function"
	);
}
import type { AgentStatus } from "./mcp-tools";
import { isPathWithinDir } from "./validation";

import { DEFAULT_SESSION_KEY } from "./mcp-tools";

const STATUS_TO_PREFIX: Record<AgentStatus, ActivityPrefix> = {
	working: "working",
	awaiting_input: "awaiting_input",
	idle: null,
};

export interface ActivityUpdate {
	sessionName: string;
	status: AgentStatus;
	detail?: string;
}

// How often to re-evaluate stale-rolling: getActivity() rolls "working" → "idle"
// after 10 min of no updates, but the UI only refreshes on incoming routes. A
// silent session needs this tick to clear its prefix and badge.
const STALE_TICK_MS = 60_000;

export class ActivityUi {
	private staleTickId: ReturnType<typeof setInterval> | null = null;

	constructor(
		private app: App,
		private statusBar: StatusBarManager,
		private getActivity: () => ReadonlyMap<string, ActivityEntry> | undefined,
	) {
		this.staleTickId = setInterval(() => this.tickStale(), STALE_TICK_MS);
	}

	route(update: ActivityUpdate): void {
		const prefix = STATUS_TO_PREFIX[update.status];

		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			if (!isTerminalViewLike(leaf.view)) continue;
			const view = leaf.view;
			const sessionKey = view.getSessionName() ?? DEFAULT_SESSION_KEY;
			if (sessionKey === update.sessionName) {
				view.setActivityPrefix(prefix);
			}
		}

		this.refreshAttentionBadge();
	}

	/**
	 * Re-route prefixes for all known sessions based on the current (rolled)
	 * activity map. Catches "working" → "idle" transitions caused by staleness
	 * rather than an explicit status update.
	 */
	private tickStale(): void {
		const activity = this.getActivity();
		if (!activity) return;
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			// Defensive: getLeavesOfType normally only returns matching views,
			// but Obsidian has been observed to surface deferred / placeholder
			// views during plugin reload — `view` may not yet be a TerminalView.
			if (!isTerminalViewLike(leaf.view)) continue;
			const view = leaf.view;
			const key = view.getSessionName() ?? DEFAULT_SESSION_KEY;
			const entry = activity.get(key);
			view.setActivityPrefix(entry ? STATUS_TO_PREFIX[entry.status] : null);
		}
		this.refreshAttentionBadge();
	}

	clear(): void {
		if (this.staleTickId != null) {
			clearInterval(this.staleTickId);
			this.staleTickId = null;
		}
		this.statusBar.setAttention(0);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			if (isTerminalViewLike(leaf.view)) leaf.view.setActivityPrefix(null);
		}
	}

	private computeWaiting(): { count: number; names: string[] } {
		const activity = this.getActivity();
		if (!activity) return { count: 0, names: [] };
		const names: string[] = [];
		for (const [name, entry] of activity) {
			if (entry.status === "awaiting_input") {
				names.push(name === DEFAULT_SESSION_KEY ? "(unnamed)" : name);
			}
		}
		return { count: names.length, names };
	}

	private refreshAttentionBadge(): void {
		const { count, names } = this.computeWaiting();
		this.statusBar.setAttention(count, names);
	}
}

export type AgentOutputMode = "new" | "new_or_modified" | "off";

interface BufferedEntry {
	kind: "created" | "modified";
	path: string;
}

const DEBOUNCE_MS = 2000;
const RATE_LIMIT_MS = 5000;

export class AgentOutputNotifier {
	private buffer: BufferedEntry[] = [];
	private debounceId: ReturnType<typeof setTimeout> | null = null;
	private lastNoticeAt = 0;

	constructor(
		private getMode: () => AgentOutputMode,
		private getWriteDir: () => string,
	) {}

	/** Feed `vault.on("create")` events. */
	onCreate(path: string): void {
		if (this.getMode() === "off") return;
		if (!this.pathInsideWriteDir(path)) return;
		this.enqueue({ kind: "created", path });
	}

	/** Feed `vault.on("modify")` events (only fires notices in "new_or_modified" mode). */
	onModify(path: string): void {
		if (this.getMode() !== "new_or_modified") return;
		if (!this.pathInsideWriteDir(path)) return;
		this.enqueue({ kind: "modified", path });
	}

	/** Cancel any pending debounce; call from plugin onunload. */
	dispose(): void {
		if (this.debounceId != null) {
			clearTimeout(this.debounceId);
			this.debounceId = null;
		}
		this.buffer = [];
	}

	private pathInsideWriteDir(path: string): boolean {
		// If the user cleared `vaultWriteDir`, the writeScoped MCP gate
		// fail-closes (no writes allowed). Mirror that here: with no write
		// dir configured, no path counts as "inside the write directory" —
		// notifications stay silent rather than firing for an arbitrary
		// fallback like `agent-workspace/`. Previously this used the
		// fallback string, so notifications could surface for paths that
		// the actual write tier wouldn't permit.
		return isPathWithinDir(path, this.getWriteDir());
	}

	private enqueue(entry: BufferedEntry): void {
		this.buffer.push(entry);
		if (this.debounceId != null) return;
		this.debounceId = setTimeout(() => {
			this.debounceId = null;
			this.flush();
		}, DEBOUNCE_MS);
	}

	private flush(): void {
		if (this.buffer.length === 0) return;
		const now = Date.now();
		const sinceLast = now - this.lastNoticeAt;
		if (sinceLast < RATE_LIMIT_MS) {
			// Inside the rate-limit window — hold the buffer and re-arm so the
			// accumulated events land in the next available slot instead of
			// being silently dropped.
			this.debounceId = setTimeout(() => {
				this.debounceId = null;
				this.flush();
			}, RATE_LIMIT_MS - sinceLast);
			return;
		}
		const buf = this.buffer;
		this.buffer = [];
		this.lastNoticeAt = now;
		if (buf.length === 1) {
			new Notice(`Agent ${buf[0].kind} ${buf[0].path}`, 5000);
			return;
		}
		const createdCount = buf.filter((e) => e.kind === "created").length;
		const modifiedCount = buf.length - createdCount;
		const parts: string[] = [];
		if (createdCount > 0) parts.push(`${createdCount} created`);
		if (modifiedCount > 0) parts.push(`${modifiedCount} modified`);
		new Notice(`Agent output: ${parts.join(", ")}`, 5000);
	}
}
