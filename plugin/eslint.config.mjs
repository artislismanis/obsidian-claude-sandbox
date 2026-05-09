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
			// Disabled: errMsg() captures the message; the wrapped Error is a
			// user-facing string conversion, not a chained system error.
			"preserve-caught-error": "off",
		},
	},
	{
		ignores: ["main.js", "node_modules/", "*.mjs"],
	},
);
