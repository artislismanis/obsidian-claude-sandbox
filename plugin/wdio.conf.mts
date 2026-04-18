import * as path from "path";
import { parseObsidianVersions } from "wdio-obsidian-service";
import { env } from "process";

const cacheDir = path.resolve(".obsidian-cache");

// Test matrix: OBSIDIAN_VERSIONS env var overrides. Default = latest.
// Format: "appVersion/installerVersion", space-separated for multiple.
// "earliest" resolves to manifest.json's minAppVersion.
const versions = await parseObsidianVersions(env.OBSIDIAN_VERSIONS ?? "latest/latest", {
	cacheDir,
});

if (env.CI) {
	// Consumed by GitHub Actions cache key
	// eslint-disable-next-line no-console
	console.log("obsidian-cache-key:", JSON.stringify(versions));
}

export const config: WebdriverIO.Config = {
	runner: "local",
	framework: "mocha",
	specs: ["./test/e2e/specs/**/*.e2e.ts"],

	maxInstances: Number(env.WDIO_MAX_INSTANCES || 2),

	capabilities: versions.map<WebdriverIO.Capabilities>(([appVersion, installerVersion]) => ({
		browserName: "obsidian",
		"wdio:obsidianOptions": {
			appVersion,
			installerVersion,
			// Path to built plugin artifacts (manifest.json, main.js, styles.css).
			// The service copies these into the test vault and enables the plugin.
			plugins: ["./dist"],
			// Ephemeral copy of this vault per Obsidian launch.
			vault: "./test/e2e/vaults/simple",
		},
	})),

	services: ["obsidian"],
	reporters: ["obsidian"],

	mochaOpts: {
		ui: "bdd",
		timeout: 60 * 1000,
	},

	waitforInterval: 250,
	waitforTimeout: 5 * 1000,
	logLevel: "warn",

	cacheDir,

	// Require explicit imports of describe/it/expect (plays nicely with ESLint).
	injectGlobals: false,
};
