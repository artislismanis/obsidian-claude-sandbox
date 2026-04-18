import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
	isDockerAvailable,
	isImageBuilt,
	hasLiveClaudeAuth,
	seedClaudeAuth,
	containerUp,
	containerDown,
	containerExec,
	waitForHealth,
	TTYD_PORT,
} from "./helpers";

const SKIP_DOCKER = !isDockerAvailable() || !isImageBuilt();

// We need a running claude subscription to exercise `claude -p`.
// If the user's live oas-claude-config volume is missing, there's no
// auth to borrow and we skip these tests rather than fail.
const SKIP = SKIP_DOCKER || !hasLiveClaudeAuth();

describe.skipIf(SKIP)("Claude Code — programmatic (authenticated from live volume)", () => {
	beforeAll(async () => {
		// Bring the test container up so the test volume is created
		containerUp();
		// Seed auth from the live volume into the test volume.
		// Container sees new files immediately via the mount.
		const seeded = seedClaudeAuth();
		if (!seeded) {
			throw new Error("Failed to seed Claude auth from live volume");
		}
		await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	});

	afterAll(() => {
		// docker compose down -v removes the test volume, so the
		// copied auth is destroyed. Live volume is untouched.
		try {
			containerDown();
		} catch {
			// best effort
		}
	});

	it("claude --version prints a version", () => {
		const output = containerExec("claude --version");
		expect(output).toMatch(/\d+\.\d+/);
	});

	it("claude -p returns output (auth is working)", () => {
		// Simplest possible prompt. If auth works, Claude responds.
		// --output-format text is default; we just check for non-empty output.
		const output = containerExec(
			"bash -c 'claude -p \"say just the single word OK\" --output-format text 2>&1 | tail -5'",
		);
		expect(output.length).toBeGreaterThan(0);
		// Claude may respond conversationally ("OK.", "OK!", "OK"), so match case-insensitively
		expect(output.toLowerCase()).toContain("ok");
	});

	it("claude -p can invoke the memory MCP tool", () => {
		// The memory MCP server is configured in workspace/.mcp.json and
		// runs as a stdio subprocess. Ask Claude to use it.
		const output = containerExec(
			`bash -c 'claude -p "use the memory tool to create an entity named test-entity of type concept with observation hello. Reply with only the word DONE when finished." --allowedTools "mcp__memory__create_entities" --output-format text 2>&1 | tail -20'`,
		);
		expect(output.toLowerCase()).toContain("done");
	});

	it("claude -p reads a vault file via filesystem (no MCP)", () => {
		// The test vault has Welcome.md at /workspace/vault/Welcome.md
		const output = containerExec(
			`bash -c 'claude -p "read the file /workspace/vault/Welcome.md and tell me its first heading. Reply with just the heading text." --allowedTools "Read" --output-format text 2>&1 | tail -5'`,
		);
		expect(output.toLowerCase()).toContain("welcome");
	});
});
