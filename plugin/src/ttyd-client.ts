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
	backoff: number | ((attemptIdx: number) => number),
	isAborted: () => boolean,
	onAttempt?: (attemptIdx: number, waitMs: number) => void,
): Promise<boolean> {
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		try {
			const resp = await withTimeout(
				requestUrl({ url: `http://localhost:${port}`, throw: false }),
				FETCH_TIMEOUT_MS,
			);
			if (resp.status === 200) {
				return true;
			}
		} catch {
			// Not ready yet
		}

		if (isAborted()) return false;

		const waitMs = typeof backoff === "number" ? backoff : backoff(i);
		onAttempt?.(i, waitMs);
		await new Promise((resolve) => setTimeout(resolve, waitMs));
	}
	return false;
}

/** Exponential backoff: 500 ms × 1.5^n, capped at 5 s. Matches the terminal-view retry schedule. */
export function exponentialBackoff(attemptIdx: number): number {
	return Math.min(5000, Math.round(500 * Math.pow(1.5, attemptIdx)));
}

export function buildWsUrl(port: number): string {
	return `ws://localhost:${port}/ws`;
}
