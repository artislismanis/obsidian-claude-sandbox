/**
 * Global setup/teardown for the integration test suite.
 *
 * Runs the test container ONCE before all test files, and tears it down
 * ONCE at the end. Per-file beforeAll/afterAll hooks no longer need to
 * manage container lifecycle — they just exec into the shared container.
 *
 * This dramatically reduces wall-clock time (one 10s container startup
 * instead of one per test file) and eliminates the race conditions that
 * came from multiple files fighting over the same container name.
 */

import {
	isDockerAvailable,
	isImageBuilt,
	containerUp,
	containerDown,
	seedClaudeAuth,
	waitForHealth,
	TTYD_PORT,
} from "./helpers";

export async function setup(): Promise<void> {
	if (!isDockerAvailable()) {
		// eslint-disable-next-line no-console
		console.log("[integration] Docker unavailable — tests will skip");
		return;
	}
	if (!isImageBuilt()) {
		// eslint-disable-next-line no-console
		console.log("[integration] oas-sandbox image not built — tests will skip");
		return;
	}

	// eslint-disable-next-line no-console
	console.log("[integration] starting test container...");
	containerUp();

	// Best-effort: seed Claude auth from the live volume if it exists.
	// Tests that need Claude will skip if seeding fails.
	const seeded = seedClaudeAuth();
	// eslint-disable-next-line no-console
	console.log(
		seeded ? "[integration] Claude auth seeded" : "[integration] no live Claude auth to seed",
	);

	await waitForHealth(`http://127.0.0.1:${TTYD_PORT}`, 60000);
	// eslint-disable-next-line no-console
	console.log("[integration] container healthy");
}

export async function teardown(): Promise<void> {
	if (!isDockerAvailable()) return;
	// eslint-disable-next-line no-console
	console.log("[integration] tearing down test container...");
	containerDown();
}
