import { requestUrl } from "obsidian";

const FETCH_TIMEOUT_MS = 5000;

export async function pollUntilReady(
	port: number,
	maxRetries: number,
	retryDelayMs: number,
	isAborted: () => boolean,
): Promise<boolean> {
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		try {
			const resp = await Promise.race([
				requestUrl({ url: `http://localhost:${port}`, throw: false }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("timeout")), FETCH_TIMEOUT_MS),
				),
			]);
			if (resp.status === 200 || resp.status === 401) {
				return true;
			}
		} catch {
			// Not ready yet
		}

		if (isAborted()) return false;

		await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
	}
	return false;
}

export async function fetchAuthToken(
	port: number,
	username: string,
	password: string,
): Promise<string> {
	const resp = await Promise.race([
		requestUrl({
			url: `http://localhost:${port}/token`,
			method: "POST",
			contentType: "application/json",
			body: JSON.stringify({ username, password }),
			throw: false,
		}),
		new Promise<never>((_, reject) =>
			setTimeout(() => reject(new Error("timeout")), FETCH_TIMEOUT_MS),
		),
	]);
	if (resp.status !== 200) throw new Error("Authentication failed");
	const data = resp.json as { token?: string };
	if (typeof data.token !== "string") {
		throw new Error("Invalid token response");
	}
	return data.token;
}

export function buildWsUrl(port: number, token?: string): string {
	const base = `ws://localhost:${port}/ws`;
	return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
