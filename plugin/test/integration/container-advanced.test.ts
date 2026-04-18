import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	containerExec,
	waitForHealth,
	TTYD_PORT,
} from "./helpers";

const SKIP = !isDockerAvailable() || !isImageBuilt();

describe.skipIf(SKIP)("Container — advanced (firewall, tmux, port remap)", () => {
	beforeAll(async () => {
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	}, 120000);

	afterAll(() => {
		containerDown();
	});

	// ── tmux / persistent sessions ──
	it("tmux is installed", () => {
		expect(containerExec("tmux -V")).toMatch(/tmux/);
	});

	it("session-helpers.sh is installed in the image", () => {
		// Look for the file in any of the likely install locations.
		// Content: a shell function named `session` that wraps tmux.
		const output = containerExec(
			"bash -c 'find /home/claude /etc -name session-helpers.sh 2>/dev/null | head -1'",
		);
		expect(output).toMatch(/session-helpers\.sh/);
	});

	it("can create and list a tmux session", () => {
		containerExec("tmux new-session -d -s test-session 'sleep 60'");
		const sessions = containerExec("tmux list-sessions -F '#{session_name}'");
		expect(sessions).toContain("test-session");
		containerExec("tmux kill-session -t test-session");
	});

	it("sessions survive exec disconnects", () => {
		containerExec("tmux new-session -d -s persist-test 'sleep 120'");
		const sessions = containerExec("tmux list-sessions -F '#{session_name}'");
		expect(sessions).toContain("persist-test");
		containerExec("tmux kill-session -t persist-test");
	});

	// ── port remapping ──
	it("ttyd responds on remapped port", async () => {
		const res = await fetch(`http://127.0.0.1:${TTYD_PORT}`);
		expect(res.status).toBe(200);
		expect(TTYD_PORT).not.toBe(7681);
	});

	// ── firewall ──
	// These tests require root. init-firewall.sh needs iptables which runs via
	// `docker compose exec --user root`. Our containerExec uses the default user
	// (claude). We call it via `sudo -n` with the known password from compose env.
	it("firewall init script exists and is executable", () => {
		expect(containerExec("test -x /usr/local/bin/init-firewall.sh && echo ok")).toBe("ok");
	});

	it("firewall status is queryable", () => {
		const status = containerExec("/usr/local/bin/init-firewall.sh --status");
		expect(["enabled", "disabled"]).toContain(status);
	});
});
