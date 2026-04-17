import { describe, it, expect } from "vitest";
import { isPathWithinDir } from "../validation";

describe("isPathWithinDir", () => {
	const writeDir = "agent-workspace";

	it("allows paths within the write directory", () => {
		expect(isPathWithinDir("agent-workspace/file.md", writeDir)).toBe(true);
		expect(isPathWithinDir("agent-workspace/sub/file.md", writeDir)).toBe(true);
	});

	it("allows the write directory itself", () => {
		expect(isPathWithinDir("agent-workspace", writeDir)).toBe(true);
	});

	it("rejects paths outside the write directory", () => {
		expect(isPathWithinDir("other-folder/file.md", writeDir)).toBe(false);
		expect(isPathWithinDir("file.md", writeDir)).toBe(false);
	});

	it("rejects path traversal with ..", () => {
		expect(isPathWithinDir("agent-workspace/../secret.md", writeDir)).toBe(false);
		expect(isPathWithinDir("agent-workspace/sub/../../secret.md", writeDir)).toBe(false);
		expect(isPathWithinDir("agent-workspace/../../../etc/passwd", writeDir)).toBe(false);
	});

	it("rejects path traversal in nested paths", () => {
		expect(isPathWithinDir("agent-workspace/notes/../../../config.json", writeDir)).toBe(false);
	});

	it("handles leading slash", () => {
		expect(isPathWithinDir("/agent-workspace/file.md", writeDir)).toBe(true);
		expect(isPathWithinDir("/agent-workspace/../secret.md", writeDir)).toBe(false);
	});

	it("rejects prefix-matching attacks", () => {
		expect(isPathWithinDir("agent-workspace-evil/file.md", writeDir)).toBe(false);
		expect(isPathWithinDir("agent-workspacex/file.md", writeDir)).toBe(false);
	});

	it("handles empty and edge-case paths", () => {
		expect(isPathWithinDir("", writeDir)).toBe(false);
		expect(isPathWithinDir("/", writeDir)).toBe(false);
		expect(isPathWithinDir(".", writeDir)).toBe(false);
		expect(isPathWithinDir("..", writeDir)).toBe(false);
	});

	it("normalizes redundant separators and dots", () => {
		expect(isPathWithinDir("agent-workspace/./file.md", writeDir)).toBe(true);
		expect(isPathWithinDir("agent-workspace//file.md", writeDir)).toBe(true);
		expect(isPathWithinDir("./agent-workspace/file.md", writeDir)).toBe(true);
	});
});
