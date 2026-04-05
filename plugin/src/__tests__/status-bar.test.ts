import { describe, it, expect, vi } from "vitest";
import { StatusBarManager } from "../status-bar";

function createMockElement(): HTMLElement {
	const el = {
		setText: vi.fn(),
	};
	return el as unknown as HTMLElement;
}

describe("StatusBarManager", () => {
	it("renders stopped state on construction", () => {
		const el = createMockElement();
		new StatusBarManager(el);
		expect(el.setText).toHaveBeenCalledWith("Sandbox: \u23F9 Stopped");
	});

	it("updates display on setState", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("running");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: \u25B6 Running");
	});

	it("shows starting state", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("starting");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: \u23F3 Starting");
	});

	it("shows error state", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setState("error");
		expect(el.setText).toHaveBeenCalledWith("Sandbox: \u26A0 Error");
	});

	it("skips render when state unchanged", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		(el.setText as ReturnType<typeof vi.fn>).mockClear();
		mgr.setState("stopped"); // already stopped
		expect(el.setText).not.toHaveBeenCalled();
	});
});
