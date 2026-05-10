/** Shared input validators. Used by both settings.ts (UI) and docker.ts (runtime). */

import { posix as posixPath } from "path";
import { realpathSync } from "fs";
import { resolve as resolveNative, sep as nativeSep } from "path";

/** Split a comma-separated value into trimmed, non-empty entries. */
export function splitCsv(value: string): string[] {
	return value
		.split(",")
		.map((s) => s.trim())
		.filter(Boolean);
}

export function isValidWriteDir(dir: string): boolean {
	if (!dir.trim()) return false;
	return !dir.includes("..") && !dir.startsWith("/") && dir !== ".";
}

/**
 * Validate a memory-file name: bare filename only (no slashes, no path
 * traversal, no leading dot to avoid hidden files). Empty rejected.
 */
export function isValidMemoryFileName(name: string): boolean {
	const t = name.trim();
	if (!t) return false;
	if (t.includes("/") || t.includes("\\") || t.includes("..")) return false;
	if (t.startsWith(".")) return false;
	return /^[A-Za-z0-9_.-]+$/.test(t);
}

/**
 * Validate a comma-separated list of vault-relative path prefixes used in
 * MCP allow/block lists. Each entry: non-empty, no `..`, no leading slash,
 * no backslashes. Empty list = valid (no restriction).
 */
export function isValidPathPrefixList(value: string): boolean {
	if (!value.trim()) return true;
	return splitCsv(value).every(
		(entry) =>
			entry.length > 0 &&
			!entry.includes("..") &&
			!entry.includes("\\") &&
			!entry.startsWith("/"),
	);
}

/** Normalise a vault-relative path: collapse `.`/`..` segments, strip leading and trailing slashes. */
function normaliseVaultPath(p: string): string {
	return posixPath.normalize(p).replace(/^\/|\/$/g, "");
}

/**
 * Is `filePath` inside `dir`? Both args are vault-relative.
 *
 * **Empty `dir` returns `false` (fail-closed).** This is the load-bearing case:
 * `vaultWriteDir` is the only thing gating writeScoped tools from spilling into
 * the whole vault. If a hand-edited `data.json` (or a missing default) leaves
 * the setting blank, every "is this path inside the write dir" check would
 * otherwise return true and the writeScoped tier becomes vault-wide. Treat
 * empty as "no writes allowed" instead. Callers that genuinely want
 * "everywhere" must opt in explicitly (writeVault tier).
 */
export function isPathWithinDir(filePath: string, dir: string): boolean {
	const normalizedDir = normaliseVaultPath(dir);
	if (normalizedDir === "") return false;
	const normalized = normaliseVaultPath(filePath);
	return normalized === normalizedDir || normalized.startsWith(normalizedDir + "/");
}

function isValidOctet(s: string): boolean {
	const n = parseInt(s, 10);
	return n >= 0 && n <= 255 && String(n) === s;
}

function isValidIpAddress(ip: string): boolean {
	const parts = ip.split(".");
	return parts.length === 4 && parts.every(isValidOctet);
}

/** Validates a single IP or CIDR (e.g. "192.168.1.0/24"). */
function isValidIpOrCidr(entry: string): boolean {
	const slashIdx = entry.indexOf("/");
	if (slashIdx === -1) return isValidIpAddress(entry);
	const ip = entry.slice(0, slashIdx);
	const prefix = entry.slice(slashIdx + 1);
	const prefixNum = parseInt(prefix, 10);
	return (
		isValidIpAddress(ip) && String(prefixNum) === prefix && prefixNum >= 0 && prefixNum <= 32
	);
}

/** Validates comma-separated IPs/CIDRs. Empty string = valid (use defaults). */
export function isValidPrivateHosts(value: string): boolean {
	if (!value.trim()) return true;
	return splitCsv(value).every(isValidIpOrCidr);
}

const VALID_MEMORY = /^\d+[KkMmGgTt]$/;

/** Validates Docker memory format (e.g. "4G", "512M", "1T"). Empty = valid. */
export function isValidMemory(value: string): boolean {
	if (!value.trim()) return true;
	return VALID_MEMORY.test(value.trim());
}

const VALID_CPUS = /^\d+(\.\d+)?$/;

/** Validates Docker CPU limit (e.g. "4", "2.5"). Empty = valid. */
export function isValidCpus(value: string): boolean {
	if (!value.trim()) return true;
	return VALID_CPUS.test(value.trim());
}

/** Validates IPv4 bind address (e.g. "127.0.0.1", "0.0.0.0"). Empty = valid. */
export function isValidBindAddress(value: string): boolean {
	if (!value.trim()) return true;
	return isValidIpAddress(value.trim());
}

const VALID_DOMAIN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Validates comma-separated list of domain names (e.g. "api.atlassian.com, slack.com"). Empty = valid. */
export function isValidDomainList(value: string): boolean {
	if (!value.trim()) return true;
	return splitCsv(value).every((entry) => VALID_DOMAIN.test(entry));
}

/**
 * Checks whether a path is allowed by the allowlist/blocklist rules.
 * - If allowlist is non-empty, the path must match at least one allowlist prefix.
 * - Blocklist entries are always denied, even if they match the allowlist.
 * - Empty lists = no restriction.
 */
export function isPathAllowed(filePath: string, allowlist: string[], blocklist: string[]): boolean {
	const matchesAnyPrefix = (prefixes: string[]): boolean =>
		prefixes.some((p) => isPathWithinDir(filePath, p));
	if (matchesAnyPrefix(blocklist)) return false;
	if (allowlist.length === 0) return true;
	return matchesAnyPrefix(allowlist);
}

/**
 * Resolve a vault-relative path to its real filesystem path and verify it
 * stays under the vault base. Blocks symlinks that escape the vault.
 *
 * - Desktop Obsidian supplies `basePath` + `getFullPath`. Mobile / test
 *   adapters that don't should pass `basePath: null` — this function becomes
 *   a no-op pass-through on those.
 * - If the target file doesn't yet exist (e.g. `vault_create` path), realpath
 *   the longest existing ancestor and verify containment there.
 * - A `realpathOverride` hook lets tests inject the realpath result without
 *   touching the filesystem.
 */
export function isRealPathWithinBase(
	basePath: string | null,
	fullPath: string,
	realpathOverride?: (p: string) => string,
): boolean {
	if (!basePath) return true;
	const realpath = realpathOverride ?? realpathSync;
	const baseReal = ((): string => {
		try {
			return realpath(basePath);
		} catch {
			return resolveNative(basePath);
		}
	})();
	let probe = fullPath;
	while (probe && probe !== resolveNative(probe, "..")) {
		try {
			const real = realpath(probe);
			const baseWithSep = baseReal.endsWith(nativeSep) ? baseReal : baseReal + nativeSep;
			return real === baseReal || real.startsWith(baseWithSep);
		} catch {
			probe = resolveNative(probe, "..");
		}
	}
	return false;
}
