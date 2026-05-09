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
import type { AgentStatus } from "./mcp-tools";
import { isPathWithinDir } from "./validation";

const DEFAULT_SESSION_KEY = "__default__";

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

export class ActivityUi {
	constructor(
		private app: App,
		private statusBar: StatusBarManager,
		private getActivity: () => ReadonlyMap<string, ActivityEntry> | undefined,
	) {}

	route(update: ActivityUpdate): void {
		const prefix = STATUS_TO_PREFIX[update.status];

		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view as TerminalView;
			const sessionKey = view.getSessionName() ?? DEFAULT_SESSION_KEY;
			if (sessionKey === update.sessionName) {
				view.setActivityPrefix(prefix);
			}
		}

		this.refreshAttentionBadge();
	}

	clear(): void {
		this.statusBar.setAttention(0);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			(leaf.view as TerminalView).setActivityPrefix(null);
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
		return isPathWithinDir(path, this.getWriteDir() || "agent-workspace");
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
