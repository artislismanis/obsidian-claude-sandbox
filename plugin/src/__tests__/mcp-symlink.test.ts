import { describe, it, expect } from "vitest";
import { isRealPathWithinBase } from "../validation";

describe("isRealPathWithinBase", () => {
	it("returns true when basePath is null (non-desktop adapter)", () => {
		expect(isRealPathWithinBase(null, "/tmp/whatever")).toBe(true);
	});

	it("allows a file whose realpath stays inside the base", () => {
		const realpath = (p: string) => {
			if (p === "/vault") return "/vault";
			if (p === "/vault/notes/a.md") return "/vault/notes/a.md";
			throw new Error(`unexpected ${p}`);
		};
		expect(
			isRealPathWithinBase("/vault", "/vault/notes/a.md", realpath as (p: string) => string),
		).toBe(true);
	});

	it("blocks a symlink escaping the vault", () => {
		const realpath = (p: string) => {
			if (p === "/vault") return "/vault";
			if (p === "/vault/evil.md") return "/etc/shadow";
			throw new Error(`unexpected ${p}`);
		};
		expect(
			isRealPathWithinBase("/vault", "/vault/evil.md", realpath as (p: string) => string),
		).toBe(false);
	});

	it("walks up to the longest existing ancestor for missing target", () => {
		// Multi-level walk-up: file doesn't exist, immediate parent doesn't
		// exist, but the next-level-up ancestor does. The earlier version of
		// this test had a duplicate `if (p === "/vault")` branch that masked
		// whether the walker actually traversed past the first missing rung.
		const realpath = (p: string) => {
			if (p === "/vault") return "/vault";
			if (p === "/vault/folder") throw new Error("ENOENT");
			if (p === "/vault/folder/new-note.md") throw new Error("ENOENT");
			throw new Error(`unexpected ${p}`);
		};
		expect(
			isRealPathWithinBase(
				"/vault",
				"/vault/folder/new-note.md",
				realpath as (p: string) => string,
			),
		).toBe(true);
	});

	it("rejects a missing file whose parent escapes", () => {
		const realpath = (p: string) => {
			if (p === "/vault") return "/vault";
			if (p === "/vault/evil-dir/new.md") throw new Error("ENOENT");
			if (p === "/vault/evil-dir") return "/outside/real-dir";
			throw new Error(`unexpected ${p}`);
		};
		expect(
			isRealPathWithinBase(
				"/vault",
				"/vault/evil-dir/new.md",
				realpath as (p: string) => string,
			),
		).toBe(false);
	});

	it("allows a path equal to the base itself", () => {
		const realpath = (p: string) => p;
		expect(isRealPathWithinBase("/vault", "/vault", realpath as (p: string) => string)).toBe(
			true,
		);
	});

	it("does not match a prefix that isn't a path boundary", () => {
		// /vault vs /vault-other — same prefix, different directories
		const realpath = (p: string) => {
			if (p === "/vault") return "/vault";
			if (p === "/vault-other/file") return "/vault-other/file";
			throw new Error(`unexpected ${p}`);
		};
		expect(
			isRealPathWithinBase("/vault", "/vault-other/file", realpath as (p: string) => string),
		).toBe(false);
	});
});
