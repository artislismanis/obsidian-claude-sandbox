import { requestUrl } from "obsidian";

const FETCH_TIMEOUT_MS = 5000;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(() => reject(new Error("timeout")), ms);
	});
	return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolve the host part of a ttyd URL.
 *
 * The `ttydBindAddress` setting controls where ttyd listens INSIDE the
 * container; for the plugin's HTTP/WS connection back to it from Obsidian
 * we need a reachable address. Two cases:
 *
 * - `127.0.0.1` (the default) — connect to localhost. The compose port
 *   mapping binds the host's loopback to the container port, so this
 *   reaches ttyd. We prefer the literal `127.0.0.1` over `localhost` to
 *   avoid IPv6 resolution surprises (`::1` vs `127.0.0.1`) on hosts where
 *   ttyd is IPv4-only.
 * - non-loopback (e.g. `0.0.0.0` for LAN access) — connect via the same
 *   address. Previously the helpers hardcoded `localhost`, so users who
 *   bound ttyd to `0.0.0.0` for remote access had a broken connection on
 *   any host where loopback resolution differed.
 */
function resolveHost(bindAddress: string | undefined): string {
	const v = (bindAddress ?? "").trim();
	if (!v || v === "127.0.0.1" || v === "0.0.0.0") return "127.0.0.1";
	return v;
}

export async function pollUntilReady(
	port: number,
	maxRetries: number,
	backoff: number | ((attemptIdx: number) => number),
	isAborted: () => boolean,
	onAttempt?: (attemptIdx: number, waitMs: number) => void,
	bindAddress?: string,
): Promise<boolean> {
	const host = resolveHost(bindAddress);
	for (let i = 0; i < maxRetries; i++) {
		if (isAborted()) return false;

		try {
			const resp = await withTimeout(
				requestUrl({ url: `http://${host}:${port}`, throw: false }),
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

/** Exponential backoff: 500 ms × 1.5^n, capped at 5 s. */
export function exponentialBackoff(attemptIdx: number): number {
	return Math.min(5000, Math.round(500 * Math.pow(1.5, attemptIdx)));
}

export function buildWsUrl(port: number, bindAddress?: string): string {
	return `ws://${resolveHost(bindAddress)}:${port}/ws`;
}
