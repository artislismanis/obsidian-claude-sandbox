import { describe, it, expect } from "vitest";
import {
	isValidWriteDir,
	isValidPrivateHosts,
	isValidMemory,
	isValidCpus,
	isValidBindAddress,
} from "../validation";
import { DockerManager } from "../docker";

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
	it("accepts nested 'a/b/c'", () => expect(isValidWriteDir("a/b/c")).toBe(true));
});

describe("isValidPrivateHosts", () => {
	it("accepts empty string", () => expect(isValidPrivateHosts("")).toBe(true));
	it("accepts whitespace-only", () => expect(isValidPrivateHosts("  ")).toBe(true));
	it("accepts single IP", () => expect(isValidPrivateHosts("192.168.1.100")).toBe(true));
	it("accepts CIDR /24", () => expect(isValidPrivateHosts("10.0.0.0/24")).toBe(true));
	it("accepts CIDR /8", () => expect(isValidPrivateHosts("10.0.0.0/8")).toBe(true));
	it("accepts CIDR /32", () => expect(isValidPrivateHosts("10.0.0.1/32")).toBe(true));
	it("accepts CIDR /0", () => expect(isValidPrivateHosts("0.0.0.0/0")).toBe(true));
	it("accepts comma-separated IPs", () =>
		expect(isValidPrivateHosts("192.168.1.100, 10.0.0.5")).toBe(true));
	it("accepts mixed IPs and CIDRs", () =>
		expect(isValidPrivateHosts("192.168.1.0/24, 10.0.0.5")).toBe(true));
	it("rejects domain names", () => expect(isValidPrivateHosts("example.com")).toBe(false));
	it("rejects mixed valid/invalid", () =>
		expect(isValidPrivateHosts("192.168.1.1, example.com")).toBe(false));
	it("rejects shell metacharacters", () =>
		expect(isValidPrivateHosts("192.168.1.1; rm -rf /")).toBe(false));
	it("rejects octet > 255", () => expect(isValidPrivateHosts("999.999.999.999")).toBe(false));
	it("rejects 256 in octet", () => expect(isValidPrivateHosts("192.168.1.256")).toBe(false));
	it("rejects CIDR prefix > 32", () => expect(isValidPrivateHosts("10.0.0.0/33")).toBe(false));
	it("rejects leading zeros in octet", () =>
		expect(isValidPrivateHosts("192.168.01.1")).toBe(false));
	it("rejects trailing comma", () => expect(isValidPrivateHosts("192.168.1.1,")).toBe(false));
});

describe("isValidMemory", () => {
	it("accepts empty string", () => expect(isValidMemory("")).toBe(true));
	it("accepts '4G'", () => expect(isValidMemory("4G")).toBe(true));
	it("accepts '512M'", () => expect(isValidMemory("512M")).toBe(true));
	it("accepts '8g' lowercase", () => expect(isValidMemory("8g")).toBe(true));
	it("accepts '1024K'", () => expect(isValidMemory("1024K")).toBe(true));
	it("accepts '1T' terabytes", () => expect(isValidMemory("1T")).toBe(true));
	it("accepts '2t' lowercase", () => expect(isValidMemory("2t")).toBe(true));
	it("rejects plain number", () => expect(isValidMemory("4096")).toBe(false));
	it("rejects text", () => expect(isValidMemory("abc")).toBe(false));
	it("rejects injection", () => expect(isValidMemory("'; rm -rf /; '")).toBe(false));
	it("rejects decimal", () => expect(isValidMemory("1.5G")).toBe(false));
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
	it("rejects octet > 255", () => expect(isValidBindAddress("256.0.0.1")).toBe(false));
	it("rejects leading zeros", () => expect(isValidBindAddress("01.02.03.04")).toBe(false));
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

describe("DockerManager.isBusy()", () => {
	it("reports not busy initially", () => {
		const docker = new DockerManager(() => ({
			dockerMode: "local" as const,
			composePath: "/opt/project",
			wslDistro: "Ubuntu",
		}));
		expect(docker.isBusy()).toBe(false);
	});
});
