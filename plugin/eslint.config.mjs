import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
	eslint.configs.recommended,
	...tseslint.configs.recommended,
	{
		rules: {
			"@typescript-eslint/no-unused-vars": [
				"error",
				{ argsIgnorePattern: "^_", varsIgnorePattern: "^_", destructuredArrayIgnorePattern: "^_" },
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
		// Build/release scripts at the package root: keep eslint:recommended on
		// (catches typos in things like process.exit) but drop typescript-eslint
		// rules that need type info.
		files: ["*.mjs"],
		rules: {
			"@typescript-eslint/no-require-imports": "off",
			"@typescript-eslint/no-explicit-any": "off",
			"@typescript-eslint/consistent-type-imports": "off",
			// Build/release scripts are CLIs — console output is the point.
			"no-console": "off",
		},
		languageOptions: {
			globals: { console: "readonly", process: "readonly", Buffer: "readonly" },
		},
	},
);
