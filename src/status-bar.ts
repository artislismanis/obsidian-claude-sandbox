export type ContainerState = "stopped" | "starting" | "running" | "error";

const STATE_DISPLAY: Record<ContainerState, string> = {
	stopped: "PKM: ⏹ Stopped",
	starting: "PKM: ⏳ Starting",
	running: "PKM: ▶ Running",
	error: "PKM: ⚠ Error",
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
		this.state = state;
		this.render();
	}

	getState(): ContainerState {
		return this.state;
	}

	private render(): void {
		this.el.setText(STATE_DISPLAY[this.state]);
	}
}
