import { describe, it, expect, vi, beforeEach } from "vitest";
import { pollUntilReady, fetchAuthToken, buildWsUrl } from "../ttyd-client";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

beforeEach(() => {
	mockFetch.mockReset();
});

describe("pollUntilReady", () => {
	it("returns true when server responds OK", async () => {
		mockFetch.mockResolvedValueOnce({ ok: true, status: 200 });
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(true);
	});

	it("returns true when server responds 401 (auth required)", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(true);
	});

	it("retries on fetch error and eventually succeeds", async () => {
		mockFetch
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockRejectedValueOnce(new Error("ECONNREFUSED"))
			.mockResolvedValueOnce({ ok: true, status: 200 });

		const result = await pollUntilReady(7681, 5, 10, () => false);
		expect(result).toBe(true);
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("returns false after all retries exhausted", async () => {
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));
		const result = await pollUntilReady(7681, 3, 10, () => false);
		expect(result).toBe(false);
		expect(mockFetch).toHaveBeenCalledTimes(3);
	});

	it("aborts early when isAborted returns true", async () => {
		let aborted = false;
		mockFetch.mockRejectedValue(new Error("ECONNREFUSED"));

		const result = await pollUntilReady(7681, 10, 10, () => {
			if (mockFetch.mock.calls.length >= 2) aborted = true;
			return aborted;
		});

		expect(result).toBe(false);
		expect(mockFetch.mock.calls.length).toBeLessThan(10);
	});

	it("returns false for non-OK non-401 status", async () => {
		mockFetch.mockResolvedValue({ ok: false, status: 500 });
		const result = await pollUntilReady(7681, 2, 10, () => false);
		expect(result).toBe(false);
	});
});

describe("fetchAuthToken", () => {
	it("returns token on success", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ token: "abc123" }),
		});
		const token = await fetchAuthToken(7681, "user", "pass");
		expect(token).toBe("abc123");
	});

	it("throws on non-OK response", async () => {
		mockFetch.mockResolvedValueOnce({ ok: false, status: 401 });
		await expect(fetchAuthToken(7681, "user", "wrong")).rejects.toThrow(
			"Authentication failed",
		);
	});

	it("throws on missing token field", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		});
		await expect(fetchAuthToken(7681, "user", "pass")).rejects.toThrow(
			"Invalid token response",
		);
	});

	it("throws on non-string token", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ token: 12345 }),
		});
		await expect(fetchAuthToken(7681, "user", "pass")).rejects.toThrow(
			"Invalid token response",
		);
	});

	it("sends correct request body", async () => {
		mockFetch.mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ token: "t" }),
		});
		await fetchAuthToken(7681, "myuser", "mypass");
		const call = mockFetch.mock.calls[0];
		expect(call[0]).toBe("http://localhost:7681/token");
		const body = JSON.parse(call[1].body as string);
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

	it("uses custom port", () => {
		expect(buildWsUrl(8080)).toBe("ws://localhost:8080/ws");
	});
});
