import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		// Unit tests live in src/__tests__/. Integration tests live in test/
		// and have their own vitest.integration.config.ts (Docker-dependent,
		// uses globalSetup). Keep them on separate configs so `npm run test`
		// is fast and doesn't need Docker.
		include: ["src/**/*.test.ts"],
		coverage: {
			// v8 provider — faster than istanbul, ships with Node, no babel.
			provider: "v8",
			reporter: ["text", "html", "json-summary"],
			// Exclude Obsidian-API-bound modules that are exercised by e2e
			// rather than unit tests (see plugin/CLAUDE.md "Testing" — these
			// would require mocking Plugin/ItemView/WorkspaceLeaf).
			exclude: [
				"src/__tests__/**",
				"src/main.ts",
				"src/settings.ts",
				"src/terminal-view.ts",
				"src/modals.ts",
				"src/session-ui.ts",
				"src/status-bar.ts",
				"src/diff-review-modal.ts",
				"src/obsidian-internals.ts",
				"src/view-types.ts",
			],
			// Thresholds: a floor that fails CI if coverage regresses below
			// today's measured level (with a ~1pp buffer for noise). Bump up
			// when the codebase improves; don't drop without justification.
			// Today: lines 77.28 / funcs 74.32 / branches 63.85 / stmts 75.06.
			// See docs/testing.md.
			thresholds: {
				lines: 76,
				functions: 73,
				branches: 62,
				statements: 74,
			},
		},
	},
});
