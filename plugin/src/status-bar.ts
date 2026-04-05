export type ContainerState = "stopped" | "starting" | "running" | "error";

const STATE_DISPLAY: Record<ContainerState, string> = {
	stopped: "Sandbox: ⏹ Stopped",
	starting: "Sandbox: ⏳ Starting",
	running: "Sandbox: ▶ Running",
	error: "Sandbox: ⚠ Error",
};

export class StatusBarManager {
	private el: HTMLElement;
	private state: ContainerState;

	constructor(statusBarItemEl: HTMLElement) {
		this.el = statusBarItemEl;
		this.state = "stopped";
		this.render();
	}

	setState(state: ContainerState): void {
		if (this.state === state) return;
		this.state = state;
		this.render();
	}

	private render(): void {
		this.el.setText(STATE_DISPLAY[this.state]);
	}
}
