/** Shared input validators. Used by both settings.ts (UI) and docker.ts (runtime). */

import { posix as posixPath } from "path";
import { realpathSync } from "fs";
import { resolve as resolveNative, sep as nativeSep } from "path";

export function isValidWriteDir(dir: string): boolean {
	if (!dir.trim()) return false;
	return !dir.includes("..") && !dir.startsWith("/") && dir !== ".";
}

export function isPathWithinDir(filePath: string, dir: string): boolean {
	const normalized = posixPath.normalize(filePath).replace(/^\//, "");
	const normalizedDir = posixPath.normalize(dir).replace(/^\//, "");
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
	return value.split(",").every((entry) => {
		const trimmed = entry.trim();
		return trimmed.length > 0 && isValidIpOrCidr(trimmed);
	});
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
	return value.split(",").every((entry) => {
		const trimmed = entry.trim();
		return trimmed.length > 0 && VALID_DOMAIN.test(trimmed);
	});
}

/**
 * Checks whether a path is allowed by the allowlist/blocklist rules.
 * - If allowlist is non-empty, the path must match at least one allowlist prefix.
 * - Blocklist entries are always denied, even if they match the allowlist.
 * - Empty lists = no restriction.
 */
export function isPathAllowed(filePath: string, allowlist: string[], blocklist: string[]): boolean {
	const norm = (p: string) => posixPath.normalize(p).replace(/^\/|\/$/g, "");
	const normalized = norm(filePath);
	for (const blocked of blocklist) {
		const nb = norm(blocked);
		if (normalized === nb || normalized.startsWith(nb + "/")) return false;
	}
	if (allowlist.length === 0) return true;
	for (const allowed of allowlist) {
		const na = norm(allowed);
		if (normalized === na || normalized.startsWith(na + "/")) return true;
	}
	return false;
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
