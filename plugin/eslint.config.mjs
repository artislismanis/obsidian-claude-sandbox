import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		// Type-aware rules need parser project info. Scope to src/ via a
		// nested override below — running type-aware lint on test/ + *.mjs
		// would require those to be in the same TS project.
		files: ["src/**/*.ts"],
		languageOptions: {
			parserOptions: {
				project: ["./tsconfig.json"],
				tsconfigRootDir: import.meta.dirname,
			},
		},
		rules: {
			// Floating promises silently swallow errors. Every async call site
			// must be awaited, .catch()'d, or explicitly `void`'d.
			"@typescript-eslint/no-floating-promises": "error",
			// Async fn passed where a sync callback is expected (e.g.
			// setTimeout(asyncFn)) — the returned promise floats.
			// `checksVoidReturn: false` keeps it permissive for DOM event
			// handlers (which return void) — only flag genuine async misuse.
			"@typescript-eslint/no-misused-promises": ["error", { checksVoidReturn: false }],
		},
	},
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{
					argsIgnorePattern: "^_",
					varsIgnorePattern: "^_",
					destructuredArrayIgnorePattern: "^_",
				},
			],
			"@typescript-eslint/no-explicit-any": "warn",
			"@typescript-eslint/consistent-type-imports": "error",
			"no-console": "warn",
			// errMsg() captures the message; the wrapped Error is a user-facing
			// string conversion, not a chained system error.
			"preserve-caught-error": "off",
		},
	},
	{
		ignores: ["main.js", "node_modules/", "dist/"],
	},
	{
		// Build/release scripts and test harness configs at the package root,
		// plus integration tests under test/, plus unit tests under
		// src/__tests__/. Keep eslint:recommended on (catches typos in things
		// like process.exit) but drop rules that don't fit ad-hoc tooling /
		// test code. Without including src/__tests__/, unit tests were
		// inheriting the strict prod rules (no-console: warn, no-explicit-any:
		// warn, consistent-type-imports: error) while tests under test/ got
		// the relaxed treatment — inconsistent test-file treatment.
		files: ["*.mjs", "*.ts", "*.mts", "test/**/*.ts", "test/**/*.mts", "src/__tests__/**/*.ts"],
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/consistent-type-imports": "off",
			// Build/release scripts and test harnesses are CLIs/diagnostics —
			// console output is the point.
			"no-console": "off",
		},
		languageOptions: {
			globals: { console: "readonly", process: "readonly", Buffer: "readonly" },
		},
	},
);
