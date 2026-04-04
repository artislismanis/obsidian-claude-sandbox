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
	it("returns token on success", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { token: "abc123" },
		});
		const token = await fetchAuthToken(7681, "user", "pass");
		expect(token).toBe("abc123");
	});

	it("throws on non-200 response", async () => {
		mockRequestUrl.mockResolvedValueOnce({ status: 401 });
		await expect(fetchAuthToken(7681, "user", "wrong")).rejects.toThrow(
			"Authentication failed",
		);
	});

	it("throws on missing token field", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: {},
		});
		await expect(fetchAuthToken(7681, "user", "pass")).rejects.toThrow(
			"Invalid token response",
		);
	});

	it("throws on non-string token", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { token: 12345 },
		});
		await expect(fetchAuthToken(7681, "user", "pass")).rejects.toThrow(
			"Invalid token response",
		);
	});

	it("sends correct request", async () => {
		mockRequestUrl.mockResolvedValueOnce({
			status: 200,
			json: { token: "t" },
		});
		await fetchAuthToken(7681, "myuser", "mypass");
		const call = mockRequestUrl.mock.calls[0][0];
		expect(call.url).toBe("http://localhost:7681/token");
		expect(call.method).toBe("POST");
		const body = JSON.parse(call.body as string);
		expect(body).toEqual({ username: "myuser", password: "mypass" });
	});
});

describe("buildWsUrl", () => {
	it("builds URL without token", () => {
		expect(buildWsUrl(7681)).toBe("ws://localhost:7681/ws");
	});

	it("builds URL with token", () => {
		expect(buildWsUrl(7681, "abc123")).toBe("ws://localhost:7681/ws?token=abc123");
	});

	it("encodes special characters in token", () => {
		expect(buildWsUrl(7681, "a&b=c")).toBe("ws://localhost:7681/ws?token=a%26b%3Dc");
	});

	it("uses custom port", () => {
		expect(buildWsUrl(8080)).toBe("ws://localhost:8080/ws");
	});
});
