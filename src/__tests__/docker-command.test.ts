import { describe, it, expect } from "vitest";
import { buildWslCommand } from "../docker";

describe("buildWslCommand", () => {
	it("builds a basic command", () => {
		const cmd = buildWslCommand("/home/user/project", "Ubuntu", "docker compose up -d");
		expect(cmd).toBe(
			"wsl -d Ubuntu -- bash -c \"cd '/home/user/project' && docker compose up -d\"",
		);
	});

	it("escapes single quotes in path for bash", () => {
		const cmd = buildWslCommand("/home/user/it's a test", "Ubuntu", "docker compose up -d");
		expect(cmd).toContain("'\\''");
		expect(cmd).toContain("cd '/home/user/it'\\''s a test'");
	});

	it("escapes double quotes in path for cmd.exe", () => {
		const cmd = buildWslCommand('/home/user/"quoted"', "Ubuntu", "docker compose up -d");
		expect(cmd).toContain('\\"quoted\\"');
		expect(cmd).not.toContain('/"quoted"/');
	});

	it("handles paths with spaces", () => {
		const cmd = buildWslCommand("/home/user/my project", "Ubuntu", "docker compose up -d");
		expect(cmd).toContain("cd '/home/user/my project'");
	});

	it("rejects distro names with spaces", () => {
		expect(() => buildWslCommand("/home/user", "Ubuntu Bad", "docker compose up -d")).toThrow(
			"Invalid WSL distribution name",
		);
	});

	it("rejects distro names with shell metacharacters", () => {
		expect(() => buildWslCommand("/home/user", "Ubuntu&&calc", "docker compose up -d")).toThrow(
			"Invalid WSL distribution name",
		);
	});

	it("rejects empty distro name", () => {
		expect(() => buildWslCommand("/home/user", "", "docker compose up -d")).toThrow(
			"Invalid WSL distribution name",
		);
	});

	it("allows distro names with dots and hyphens", () => {
		const cmd = buildWslCommand("/home/user", "Ubuntu-22.04", "docker compose up -d");
		expect(cmd).toContain("wsl -d Ubuntu-22.04");
	});

	it("allows distro names with underscores", () => {
		const cmd = buildWslCommand("/home/user", "my_distro", "docker compose up -d");
		expect(cmd).toContain("wsl -d my_distro");
	});
});
