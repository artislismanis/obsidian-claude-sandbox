export type ContainerState = "stopped" | "starting" | "running" | "error";

const STATE_DISPLAY: Record<ContainerState, string> = {
	stopped: "Sandbox: \u23F9 Stopped",
	starting: "Sandbox: \u23F3 Starting",
	running: "Sandbox: \u25B6 Running",
	error: "Sandbox: \u26A0 Error",
};

export class StatusBarManager {
	private el: HTMLElement;
	private state: ContainerState;

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

	setDetails(details: string): void {
		this.el.setAttribute("aria-label", details);
	}

	private render(): void {
		this.el.setText(STATE_DISPLAY[this.state]);
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
		if (this.state === "hidden") {
			this.el.style.display = "none";
			return;
		}
		this.el.style.display = "";
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
