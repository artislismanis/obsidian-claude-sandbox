import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execSync } from "child_process";
import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	containerExec,
	containerLogs,
	waitForHealth,
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

describe.skipIf(SKIP_NO_IMAGE)("Container lifecycle", () => {
	beforeAll(async () => {
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	});

	afterAll(() => {
		try {
			containerDown();
		} catch {
			// best effort
		}
	});

	it("container is running and healthy", async () => {
		const output = containerExec("echo ok");
		expect(output).toBe("ok");
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

	it("vault is mounted read-only", () => {
		const output = containerExec("cat /workspace/vault/Welcome.md");
		expect(output).toContain("Welcome");
	});

	it("vault write dir is writable", () => {
		containerExec("touch /workspace/vault/agent-workspace/_integration_test");
		containerExec("rm /workspace/vault/agent-workspace/_integration_test");
	});

	it("vault root is not writable", () => {
		expect(() => {
			containerExec("touch /workspace/vault/_should_fail 2>&1");
		}).toThrow();
	});

	it("claude code CLI is installed", () => {
		const output = containerExec("claude --version");
		expect(output).toMatch(/\d+\.\d+/);
	});

	it("MCP env vars are injected", () => {
		const token = containerExec("echo $OAS_MCP_TOKEN");
		const port = containerExec("echo $OAS_MCP_PORT");
		expect(token).toBe("integration-test-token");
		expect(port).toBe("38080");
	});

	it("container logs have no critical errors", () => {
		const logs = containerLogs();
		expect(logs).not.toContain("FATAL");
		expect(logs).not.toContain("panic");
	});

	it("workspace tier files are visible", () => {
		expect(containerExec("test -f /workspace/CLAUDE.md && echo ok")).toBe("ok");
		expect(containerExec("test -f /workspace/.mcp.json && echo ok")).toBe("ok");
		expect(containerExec("test -f /workspace/.claude/settings.json && echo ok")).toBe("ok");
	});

	it("container/ infra is NOT visible (mount isolation)", () => {
		expect(() => containerExec("ls /workspace/container 2>&1")).toThrow();
	});

	it("sudo is narrow (apt-get/apt only)", () => {
		const output = containerExec("sudo -l -U claude 2>&1 || true");
		expect(output).toContain("/usr/bin/apt-get");
		expect(output).toContain("/usr/bin/apt");
		expect(output).not.toContain("NOPASSWD");
	});

	it("SUDO_PASSWORD env var is unset after entrypoint drops privileges", () => {
		const output = containerExec("bash -c 'echo -n \"${SUDO_PASSWORD:-UNSET}\"'");
		expect(output).toBe("UNSET");
	});
});

describe.skipIf(SKIP_NO_IMAGE)("Docker resource naming (oas-test prefix in tests)", () => {
	beforeAll(async () => {
		containerUp();
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	});

	afterAll(() => {
		try {
			containerDown();
		} catch {
			// best effort
		}
	});

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
