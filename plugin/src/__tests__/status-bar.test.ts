import { describe, it, expect, vi } from "vitest";
import { FirewallStatusBar, StatusBarManager } from "../status-bar";

function createMockElement(): HTMLElement {
	const el = {
		setText: vi.fn(),
		addClass: vi.fn(),
		toggleClass: vi.fn(),
		setAttribute: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		style: { display: "" },
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

	it("sets tooltip via setDetails", () => {
		const el = createMockElement();
		const mgr = new StatusBarManager(el);
		mgr.setDetails("Container: running\nPort: 7681");
		expect(el.setAttribute).toHaveBeenCalledWith(
			"aria-label",
			"Container: running\nPort: 7681",
		);
	});
});

describe("FirewallStatusBar", () => {
	it("starts hidden", () => {
		const el = createMockElement();
		new FirewallStatusBar(el, vi.fn());
		expect(el.style.display).toBe("none");
	});

	it("shows enabled state with success class", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("enabled");
		expect(el.style.display).toBe("");
		expect(el.setText).toHaveBeenCalledWith("\uD83D\uDEE1 FW");
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-enabled", true);
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-disabled", false);
	});

	it("shows disabled state with muted class", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("disabled");
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-enabled", false);
		expect(el.toggleClass).toHaveBeenCalledWith("firewall-disabled", true);
	});

	it("hides when set to hidden", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("enabled");
		bar.setState("hidden");
		expect(el.style.display).toBe("none");
	});

	it("skips render on duplicate state", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		bar.setState("enabled");
		(el.setText as ReturnType<typeof vi.fn>).mockClear();
		bar.setState("enabled");
		expect(el.setText).not.toHaveBeenCalled();
	});

	it("returns current state via getState", () => {
		const el = createMockElement();
		const bar = new FirewallStatusBar(el, vi.fn());
		expect(bar.getState()).toBe("hidden");
		bar.setState("enabled");
		expect(bar.getState()).toBe("enabled");
	});

	it("registers click handler", () => {
		const el = createMockElement();
		const handler = vi.fn();
		new FirewallStatusBar(el, handler);
		expect(el.addEventListener).toHaveBeenCalledWith("click", handler);
	});

	it("removes click handler on destroy", () => {
		const el = createMockElement();
		const handler = vi.fn();
		const bar = new FirewallStatusBar(el, handler);
		bar.destroy();
		expect(el.removeEventListener).toHaveBeenCalledWith("click", handler);
	});
});
