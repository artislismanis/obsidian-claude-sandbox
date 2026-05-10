import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian's requestUrl before importing ttyd-client
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { pollUntilReady, buildWsUrl } from "../ttyd-client";

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

describe("buildWsUrl", () => {
	it("defaults to 127.0.0.1 when no bind address given", () => {
		expect(buildWsUrl(7681)).toBe("ws://127.0.0.1:7681/ws");
	});

	it("uses custom port", () => {
		expect(buildWsUrl(8080)).toBe("ws://127.0.0.1:8080/ws");
	});

	it("normalises 0.0.0.0 to loopback (Obsidian connects from the host)", () => {
		expect(buildWsUrl(7681, "0.0.0.0")).toBe("ws://127.0.0.1:7681/ws");
	});

	it("honours non-loopback bind addresses", () => {
		expect(buildWsUrl(7681, "192.168.1.5")).toBe("ws://192.168.1.5:7681/ws");
	});

	it("treats empty/whitespace as loopback", () => {
		expect(buildWsUrl(7681, "")).toBe("ws://127.0.0.1:7681/ws");
		expect(buildWsUrl(7681, "  ")).toBe("ws://127.0.0.1:7681/ws");
	});
});
