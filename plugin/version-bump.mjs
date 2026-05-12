/**
 * Sync `manifest.json` and `versions.json` to the version just set in
 * `package.json`. Called automatically by `npm version` via the "version"
 * lifecycle script (see package.json).
 *
 * - manifest.json: update `version` to match package.json.
 * - versions.json: add `{ <new version>: <minAppVersion from manifest> }`.
 *
 * Stages the updated files so `npm version`'s commit step includes them.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
	console.error("version-bump: npm_package_version is unset");
	process.exit(1);
}

// Validate the version shape so we don't write garbage into the JSON files.
// npm version normally produces semver-clean strings, but if anything ever
// invokes this script directly with a malformed env var we want to fail
// loudly rather than silently corrupt manifest.json / versions.json.
if (!/^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/.test(targetVersion)) {
	console.error(`version-bump: '${targetVersion}' is not a valid semver string`);
	process.exit(1);
}

// Always resolve paths relative to this script's directory rather than CWD.
// `npm version` runs the script with cwd = package.json's dir (so the old
// relative-path form worked), but invocations like `npm version --prefix
// plugin <ver>` set cwd to the caller — relative reads would then resolve
// against the wrong directory and either fail noisily or stage nothing.
const here = dirname(fileURLToPath(import.meta.url));
const manifestPath = resolve(here, "manifest.json");
const versionsPath = resolve(here, "versions.json");

for (const p of [manifestPath, versionsPath]) {
	if (!existsSync(p)) {
		console.error(`version-bump: required file missing: ${p}`);
		process.exit(1);
	}
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf-8"));
const { minAppVersion } = manifest;
manifest.version = targetVersion;
writeFileSync(manifestPath, JSON.stringify(manifest, null, "\t") + "\n");

const versions = JSON.parse(readFileSync(versionsPath, "utf-8"));
versions[targetVersion] = minAppVersion;
writeFileSync(versionsPath, JSON.stringify(versions, null, "\t") + "\n");

// Use absolute paths so `git add` works regardless of cwd.
execSync(`git add "${manifestPath}" "${versionsPath}"`);
console.log(`version-bump: synced manifest.json + versions.json to ${targetVersion}`);
