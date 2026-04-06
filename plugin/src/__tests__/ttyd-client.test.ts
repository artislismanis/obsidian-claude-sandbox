import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock obsidian's requestUrl before importing ttyd-client
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { pollUntilReady, fetchAuthToken, buildWsUrl } from "../ttyd-client";

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

describe("fetchAuthToken", () => {
	it("returns token from GET /token with Basic Auth", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { token: "server-generated-token" },
		});
		const token = await fetchAuthToken(7681, "user", "pass");
		expect(token).toBe("server-generated-token");
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.url).toBe("http://localhost:7681/token");
		expect(call.method).toBe("GET");
		expect(call.headers.Authorization).toBe(`Basic ${btoa("user:pass")}`);
	});

	it("throws on 401 response", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401 });
		await expect(fetchAuthToken(7681, "user", "wrong")).rejects.toThrow(
			"Authentication failed",
		);
	});

	it("throws on missing token field", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 200, json: {} });
		await expect(fetchAuthToken(7681, "user", "pass")).rejects.toThrow(
			"Invalid token response",
		);
	});
});

describe("buildWsUrl", () => {
	it("builds URL without credentials", () => {
		expect(buildWsUrl(7681)).toBe("ws://localhost:7681/ws");
	});

	it("uses custom port", () => {
		expect(buildWsUrl(8080)).toBe("ws://localhost:8080/ws");
	});
});
