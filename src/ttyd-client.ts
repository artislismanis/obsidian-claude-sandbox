const FETCH_TIMEOUT_MS = 5000;

export async function pollUntilReady(
	port: number,
	maxRetries: number,
	retryDelayMs: number,
	isAborted: () => boolean,
): Promise<boolean> {
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		const controller = new AbortController();
		const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

		try {
			const resp = await fetch(`http://localhost:${port}`, {
				signal: controller.signal,
			});
			if (resp.ok || resp.status === 401) {
				return true;
			}
		} catch {
			// Not ready yet
		} finally {
			clearTimeout(timeout);
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
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
	try {
		const resp = await fetch(`http://localhost:${port}/token`, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ username, password }),
			signal: controller.signal,
		});
		if (!resp.ok) throw new Error("Authentication failed");
		const data = (await resp.json()) as { token?: string };
		if (typeof data.token !== "string") {
			throw new Error("Invalid token response");
		}
		return data.token;
	} finally {
		clearTimeout(timeout);
	}
}

export function buildWsUrl(port: number, token?: string): string {
	const base = `ws://localhost:${port}/ws`;
	return token ? `${base}?token=${encodeURIComponent(token)}` : base;
}
