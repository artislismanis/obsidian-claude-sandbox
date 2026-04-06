import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian's requestUrl before importing ttyd-client
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { pollUntilReady, buildAuthToken, buildWsUrl } from "../ttyd-client";

const mockRequestUrl = requestUrl as ReturnType<typeof vi.fn>;

beforeEach(() => {
	mockRequestUrl.mockReset();
});

describe("pollUntilReady", () => {
	it("returns true when server responds 200", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200 });
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(true);
	});

	it("returns true when server responds 401 (auth required)", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401 });
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(true);
	});

	it("retries on error and eventually succeeds", async () => {
		mockRequestUrl
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({ status: 200 });

		const result = await pollUntilReady(7681, 5, 10, () => false);
		expect(result).toBe(true);
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});

	it("returns false after all retries exhausted", async () => {
		mockRequestUrl.mockRejectedValue(new Error("ECONNREFUSED"));
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(false);
		expect(mockRequestUrl).toHaveBeenCalledTimes(3);
	});

	it("aborts early when isAborted returns true", async () => {
		let aborted = false;
		mockRequestUrl.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await pollUntilReady(7681, 10, 10, () => {
			if (mockRequestUrl.mock.calls.length >= 2) aborted = true;
			return aborted;
		});

		expect(result).toBe(false);
		expect(mockRequestUrl.mock.calls.length).toBeLessThan(10);
	});

	it("returns false for non-OK non-401 status", async () => {
		mockRequestUrl.mockResolvedValue({ status: 500 });
		const result = await pollUntilReady(7681, 2, 10, () => false);
		expect(result).toBe(false);
	});
});

describe("buildAuthToken", () => {
	it("returns base64-encoded credential", () => {
		const token = buildAuthToken("user", "pass");
		expect(token).toBe(btoa("user:pass"));
	});

	it("handles special characters in password", () => {
		const token = buildAuthToken("admin", "p@ss:w0rd!");
		expect(token).toBe(btoa("admin:p@ss:w0rd!"));
	});
});

describe("buildWsUrl", () => {
	it("builds URL without token", () => {
		expect(buildWsUrl(7681)).toBe("ws://localhost:7681/ws");
	});

	it("builds URL with token", () => {
		expect(buildWsUrl(7681, "abc123")).toBe("ws://localhost:7681/ws?token=abc123");
	});

	it("passes token without encoding (ttyd expects raw base64)", () => {
		expect(buildWsUrl(7681, "dXNlcjpwYXNz")).toBe("ws://localhost:7681/ws?token=dXNlcjpwYXNz");
	});

	it("preserves base64 padding characters", () => {
		expect(buildWsUrl(7681, "abc=")).toBe("ws://localhost:7681/ws?token=abc=");
	});

	it("uses custom port", () => {
		expect(buildWsUrl(8080)).toBe("ws://localhost:8080/ws");
	});
});
