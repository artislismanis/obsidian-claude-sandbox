import { describe, it, expect } from "vitest";
import { execSync } from "child_process";
import {
	isDockerAvailable,
	isImageBuilt,
	containerExec,
	containerLogs,
	TTYD_PORT,
} from "./helpers";

function execSyncTrim(cmd: string): string {
	return execSync(cmd, { stdio: "pipe" }).toString().trim();
}

const SKIP = !isDockerAvailable();
const SKIP_NO_IMAGE = SKIP || !isImageBuilt();

describe.skipIf(SKIP)("Container prerequisites", () => {
	it("Docker daemon is running", () => {
		expect(isDockerAvailable()).toBe(true);
	});

	it("oas-sandbox image is built", () => {
		expect(isImageBuilt()).toBe(true);
	});
});

// Container lifecycle is managed by globalSetup.ts — we just run tests against it.
describe.skipIf(SKIP_NO_IMAGE)("Container", () => {
	// ── lifecycle / health ──
	it("is running and healthy", () => {
		expect(containerExec("echo ok")).toBe("ok");
	});

	it("ttyd responds on configured port", async () => {
		const res = await fetch(`http://127.0.0.1:${TTYD_PORT}`);
		expect(res.status).toBe(200);
	});

	it("verify.sh passes", () => {
		const output = containerExec("verify.sh");
		expect(output).toContain("Tool versions");
		expect(output).not.toContain("not found");
	});

	it("logs have no critical errors", () => {
		const logs = containerLogs();
		expect(logs).not.toContain("FATAL");
		expect(logs).not.toContain("panic");
	});

	// ── vault mounts ──
	it("vault is mounted and readable", () => {
		expect(containerExec("cat /workspace/vault/Welcome.md")).toContain("Welcome");
	});

	it("vault write directory is writable", () => {
		containerExec("touch /workspace/vault/agent-workspace/_integration_test");
		containerExec("rm /workspace/vault/agent-workspace/_integration_test");
	});

	it("vault root is not writable", () => {
		expect(() => containerExec("touch /workspace/vault/_should_fail")).toThrow();
	});

	// ── workspace tier (Tier 1) ──
	it("workspace tier files are visible", () => {
		expect(containerExec("test -f /workspace/CLAUDE.md && echo ok")).toBe("ok");
		expect(containerExec("test -f /workspace/.mcp.json && echo ok")).toBe("ok");
		expect(containerExec("test -f /workspace/.claude/settings.json && echo ok")).toBe("ok");
	});

	it("container/ infra is NOT visible (mount isolation)", () => {
		expect(() => containerExec("ls /workspace/container")).toThrow();
	});

	// ── env vars ──
	it("MCP env vars are injected", () => {
		expect(containerExec("bash -c 'echo $OAS_MCP_TOKEN'")).toBe("integration-test-token");
		expect(containerExec("bash -c 'echo $OAS_MCP_PORT'")).toBe("38080");
	});

	// ── Claude Code ──
	it("claude CLI is installed", () => {
		expect(containerExec("claude --version")).toMatch(/\d+\.\d+/);
	});

	// ── sudo model ──
	it("sudo is narrow (apt-get/apt only)", () => {
		const output = containerExec("sudo -l -U claude");
		expect(output).toContain("/usr/bin/apt-get");
		expect(output).toContain("/usr/bin/apt");
		expect(output).not.toContain("NOPASSWD");
	});

	it("SUDO_PASSWORD env var is unset after entrypoint drops privileges", () => {
		expect(containerExec("bash -c 'echo -n ${SUDO_PASSWORD:-UNSET}'")).toBe("UNSET");
	});

	// ── Docker resource naming ──
	it("container uses the expected test name", () => {
		const name = execSyncTrim("docker inspect --format '{{.Name}}' oas-test-sandbox");
		expect(name.replace("/", "")).toBe("oas-test-sandbox");
	});

	it("image is oas-sandbox:latest", () => {
		const image = execSyncTrim("docker inspect --format '{{.Config.Image}}' oas-test-sandbox");
		expect(image).toBe("oas-sandbox:latest");
	});

	it("named volumes use test prefix", () => {
		const mounts = execSyncTrim(
			"docker inspect --format '{{range .Mounts}}{{.Name}} {{end}}' oas-test-sandbox",
		);
		expect(mounts).toContain("oas-test_oas-test-claude-config");
		expect(mounts).toContain("oas-test_oas-test-shell-history");
	});
});
