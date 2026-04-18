import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["test/integration/**/*.test.ts"],
		testTimeout: 60_000,
		hookTimeout: 120_000,
		// All integration test files share ONE Docker container, brought up
		// and torn down by globalSetup. This is dramatically faster than
		// per-file lifecycles (one 10s start instead of three) and eliminates
		// race conditions from multiple files fighting over the same
		// container name.
		globalSetup: ["./test/integration/globalSetup.ts"],
		// Still serialize execution to avoid concurrent docker exec races.
		fileParallelism: false,
		pool: "threads",
		poolOptions: {
			threads: { singleThread: true },
		},
		sequence: { concurrent: false },
	},
});
