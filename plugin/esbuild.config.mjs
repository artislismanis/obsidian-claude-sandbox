import esbuild from "esbuild";
import { copyFileSync, mkdirSync } from "fs";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

const context = await esbuild.context({
	entryPoints: ["src/main.ts"],
	bundle: true,
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		"@lezer/common",
		"@lezer/highlight",
		"@lezer/lr",
		...builtins,
	],
	format: "cjs",
	target: "es2022",
	logLevel: "info",
	sourcemap: prod ? false : "inline",
	treeShaking: true,
	outfile: "dist/main.js",
	minify: prod,
});

if (prod) {
	await context.rebuild();
	mkdirSync("dist", { recursive: true });
	copyFileSync("manifest.json", "dist/manifest.json");
	copyFileSync("styles.css", "dist/styles.css");
	process.exit(0);
} else {
	// Clean SIGINT handling: dispose the esbuild context (closes file watchers,
	// kills the worker subprocess) before exiting. Without this, Ctrl-C in dev
	// mode leaves the watcher process orphaned until the parent shell reaps it.
	process.on("SIGINT", () => {
		context.dispose();
		process.exit(0);
	});
	await context.watch();
}
