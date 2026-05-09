export type ContainerState = "stopped" | "starting" | "running" | "error" | "checking";

const STATE_DISPLAY: Record<ContainerState, string> = {
	stopped: "Sandbox: \u23F9 Stopped",
	starting: "Sandbox: \u23F3 Starting",
	running: "Sandbox: \u25B6 Running",
	error: "Sandbox: \u26A0 Error",
	checking: "Sandbox: \uD83D\uDD0D Checking",
};

export class StatusBarManager {
	private el: HTMLElement;
	private state: ContainerState;
	private details: string | null = null;
	private attentionCount = 0;

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
	}

	getState(): ContainerState {
		return this.state;
	}

	setDetails(details: string): void {
		if (this.details === details) return;
		this.details = details;
		this.el.setAttribute("aria-label", details);
	}

	setAttentionCount(n: number): void {
		if (this.attentionCount === n) return;
		this.attentionCount = n;
		this.render();
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
