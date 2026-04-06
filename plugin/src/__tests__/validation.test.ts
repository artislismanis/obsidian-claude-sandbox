import { describe, it, expect } from "vitest";
import {
	isValidWriteDir,
	isValidPrivateHosts,
	isValidMemory,
	isValidCpus,
	isValidBindAddress,
	DockerManager,
} from "../docker";

describe("isValidWriteDir", () => {
	it("rejects '..'", () => expect(isValidWriteDir("..")).toBe(false));
	it("rejects '../escape'", () => expect(isValidWriteDir("../escape")).toBe(false));
	it("rejects '/absolute'", () => expect(isValidWriteDir("/absolute")).toBe(false));
	it("rejects '.'", () => expect(isValidWriteDir(".")).toBe(false));
	it("rejects 'foo/../bar'", () => expect(isValidWriteDir("foo/../bar")).toBe(false));
	it("rejects empty string", () => expect(isValidWriteDir("")).toBe(false));
	it("rejects whitespace-only", () => expect(isValidWriteDir("   ")).toBe(false));
	it("accepts 'claude-workspace'", () => expect(isValidWriteDir("claude-workspace")).toBe(true));
	it("accepts 'subfolder'", () => expect(isValidWriteDir("subfolder")).toBe(true));
	it("accepts 'my-dir'", () => expect(isValidWriteDir("my-dir")).toBe(true));
});

describe("isValidPrivateHosts", () => {
	it("accepts empty string", () => expect(isValidPrivateHosts("")).toBe(true));
	it("accepts single IP", () => expect(isValidPrivateHosts("192.168.1.100")).toBe(true));
	it("accepts CIDR", () => expect(isValidPrivateHosts("10.0.0.0/8")).toBe(true));
	it("accepts comma-separated IPs", () =>
		expect(isValidPrivateHosts("192.168.1.100, 10.0.0.5")).toBe(true));
	it("accepts mixed IPs and CIDRs", () =>
		expect(isValidPrivateHosts("192.168.1.0/24, 10.0.0.5")).toBe(true));
	it("rejects domain names", () => expect(isValidPrivateHosts("example.com")).toBe(false));
	it("rejects mixed valid/invalid", () =>
		expect(isValidPrivateHosts("192.168.1.1, example.com")).toBe(false));
	it("rejects shell metacharacters", () =>
		expect(isValidPrivateHosts("192.168.1.1; rm -rf /")).toBe(false));
});

describe("isValidMemory", () => {
	it("accepts empty string", () => expect(isValidMemory("")).toBe(true));
	it("accepts '4G'", () => expect(isValidMemory("4G")).toBe(true));
	it("accepts '512M'", () => expect(isValidMemory("512M")).toBe(true));
	it("accepts '8g' lowercase", () => expect(isValidMemory("8g")).toBe(true));
	it("accepts '1024K'", () => expect(isValidMemory("1024K")).toBe(true));
	it("rejects plain number", () => expect(isValidMemory("4096")).toBe(false));
	it("rejects text", () => expect(isValidMemory("abc")).toBe(false));
	it("rejects injection", () => expect(isValidMemory("'; rm -rf /; '")).toBe(false));
});

describe("isValidCpus", () => {
	it("accepts empty string", () => expect(isValidCpus("")).toBe(true));
	it("accepts '4'", () => expect(isValidCpus("4")).toBe(true));
	it("accepts '2.5'", () => expect(isValidCpus("2.5")).toBe(true));
	it("accepts '0.5'", () => expect(isValidCpus("0.5")).toBe(true));
	it("rejects text", () => expect(isValidCpus("abc")).toBe(false));
	it("rejects negative", () => expect(isValidCpus("-1")).toBe(false));
	it("rejects injection", () => expect(isValidCpus("4; rm")).toBe(false));
});

describe("isValidBindAddress", () => {
	it("accepts empty string", () => expect(isValidBindAddress("")).toBe(true));
	it("accepts '127.0.0.1'", () => expect(isValidBindAddress("127.0.0.1")).toBe(true));
	it("accepts '0.0.0.0'", () => expect(isValidBindAddress("0.0.0.0")).toBe(true));
	it("accepts '192.168.1.100'", () => expect(isValidBindAddress("192.168.1.100")).toBe(true));
	it("rejects hostname", () => expect(isValidBindAddress("localhost")).toBe(false));
	it("rejects CIDR", () => expect(isValidBindAddress("0.0.0.0/0")).toBe(false));
});

describe("writeDir validation in DockerManager", () => {
	function createDocker(writeDir: string) {
		return new DockerManager(() => ({
			dockerMode: "local" as const,
			composePath: "/opt/project",
			wslDistro: "Ubuntu",
			writeDir,
		}));
	}

	it("rejects '..' as writeDir", async () => {
		const docker = createDocker("..");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects '../escape' as writeDir", async () => {
		const docker = createDocker("../escape");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects '/absolute' as writeDir", async () => {
		const docker = createDocker("/absolute");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects '.' as writeDir", async () => {
		const docker = createDocker(".");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});

	it("rejects 'foo/../bar' as writeDir", async () => {
		const docker = createDocker("foo/../bar");
		await expect(docker.start()).rejects.toThrow("Invalid vault write directory");
	});
});
