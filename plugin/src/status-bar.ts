export type ContainerState = "stopped" | "starting" | "running" | "error" | "checking";

const STATE_DISPLAY: Record<ContainerState, string> = {
	stopped: "Sandbox: \u23F9 Stopped",
	starting: "Sandbox: \u23F3 Starting",
	running: "Sandbox: \u25B6 Running",
	error: "Sandbox: \u26A0 Error",
	checking: "Sandbox: \uD83D\uDD0D Checking",
};

export interface RunningTooltipContext {
	port: number;
	firewall: FirewallState;
	mcp: { running: boolean; port: number; toolCount: number };
}

export class StatusBarManager {
	private el: HTMLElement;
	private state: ContainerState;
	private details: string | null = null;
	private attentionCount = 0;
	private attentionNames: string[] = [];
	private runningCtx: RunningTooltipContext | null = null;

	constructor(statusBarItemEl: HTMLElement) {
		this.el = statusBarItemEl;
		this.el.addClass("sandbox-status-bar");
		this.state = "stopped";
		this.render();
	}

	setState(state: ContainerState): void {
		if (this.state === state) return;
		this.state = state;
		this.render();
		this.recomposeRunningTooltip();
	}

	getState(): ContainerState {
		return this.state;
	}

	/** Imperative tooltip override \u2014 used for non-running states (Starting\u2026, Stopped, Error). */
	setDetails(details: string): void {
		if (this.details === details) return;
		this.details = details;
		this.el.setAttribute("aria-label", details);
	}

	/** Push the structured context for the default running-state tooltip. Recomposes immediately. */
	setRunningTooltipContext(ctx: RunningTooltipContext): void {
		this.runningCtx = ctx;
		this.recomposeRunningTooltip();
	}

	/** Update the attention badge count + the names used in the running tooltip override. */
	setAttention(count: number, names: string[] = []): void {
		const sameCount = this.attentionCount === count;
		const sameNames =
			names.length === this.attentionNames.length &&
			names.every((n, i) => n === this.attentionNames[i]);
		if (sameCount && sameNames) return;
		this.attentionCount = count;
		this.attentionNames = names;
		this.render();
		this.recomposeRunningTooltip();
	}

	private recomposeRunningTooltip(): void {
		if (this.state !== "running" || !this.runningCtx) return;
		if (this.attentionCount > 0) {
			this.setDetails(
				`Sandbox running. ${this.attentionCount} session(s) awaiting input: ${this.attentionNames.join(", ")}\nClick for options`,
			);
			return;
		}
		const { port, firewall, mcp } = this.runningCtx;
		const fwLabel =
			firewall === "enabled" ? "enabled" : firewall === "disabled" ? "disabled" : "n/a";
		const mcpLabel = mcp.running ? `port ${mcp.port}, ${mcp.toolCount} tools` : "off";
		this.setDetails(
			[
				"Container: running",
				`Port: ${port}`,
				`Firewall: ${fwLabel}`,
				`MCP: ${mcpLabel}`,
				"",
				"Click for options",
			].join("\n"),
		);
	}

	private render(): void {
		const base = STATE_DISPLAY[this.state];
		const badge = this.attentionCount > 0 ? " \u26A0" : "";
		this.el.setText(base + badge);
	}
}

export type FirewallState = "enabled" | "disabled" | "hidden";

export class FirewallStatusBar {
	private el: HTMLElement;
	private state: FirewallState = "hidden";
	private clickHandler: () => void;

	constructor(statusBarItemEl: HTMLElement, onClick: () => void) {
		this.el = statusBarItemEl;
		this.clickHandler = onClick;
		this.el.addClass("sandbox-firewall-status");
		this.el.addEventListener("click", this.clickHandler);
		this.render();
	}

	setState(state: FirewallState): void {
		if (this.state === state) return;
		this.state = state;
		this.render();
	}

	getState(): FirewallState {
		return this.state;
	}

	private render(): void {
		this.el.toggleClass("sandbox-statusbar-hidden", this.state === "hidden");
		if (this.state === "hidden") return;
		this.el.setText("\uD83D\uDEE1 FW");
		this.el.toggleClass("firewall-enabled", this.state === "enabled");
		this.el.toggleClass("firewall-disabled", this.state === "disabled");
		this.el.setAttribute(
			"aria-label",
			this.state === "enabled"
				? "Firewall active \u2014 click to disable"
				: "Firewall inactive \u2014 click to enable",
		);
	}

	destroy(): void {
		this.el.removeEventListener("click", this.clickHandler);
	}
}
