import { requestUrl } from "obsidian";

const FETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let done = false;
	return new Promise<T>((resolve, reject) => {
		const timer = setTimeout(() => {
			if (!done) {
				done = true;
				reject(new Error("timeout"));
			}
		}, ms);
		promise.then(
			(val) => {
				clearTimeout(timer);
				if (!done) {
					done = true;
					resolve(val);
				}
			},
			(err) => {
				clearTimeout(timer);
				if (!done) {
					done = true;
					reject(err);
				}
			},
		);
	});
}

export async function pollUntilReady(
	port: number,
	maxRetries: number,
	retryDelayMs: number,
	isAborted: () => boolean,
): Promise<boolean> {
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		try {
			const resp = await withTimeout(
				requestUrl({ url: `http://localhost:${port}`, throw: false }),
				FETCH_TIMEOUT_MS,
			);
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
	const resp = await withTimeout(
		requestUrl({
			url: `http://localhost:${port}/token`,
			method: "GET",
			headers: {
				Authorization: `Basic ${btoa(`${username}:${password}`)}`,
			},
			throw: false,
		}),
		FETCH_TIMEOUT_MS,
	);
	if (resp.status !== 200) {
		throw new Error(
			resp.status === 403 || resp.status === 401
				? "Authentication failed — check ttyd username and password in settings"
				: `ttyd auth request failed (HTTP ${resp.status})`,
		);
	}
	const data = resp.json as { token?: string };
	if (typeof data.token !== "string") {
		throw new Error("Invalid token response");
	}
	return data.token;
}

export function buildWsUrl(port: number): string {
	return `ws://localhost:${port}/ws`;
}
