/** Shared input validators. Used by both settings.ts (UI) and docker.ts (runtime). */

export function isValidWriteDir(dir: string): boolean {
	if (!dir.trim()) return false;
	return !dir.includes("..") && !dir.startsWith("/") && dir !== ".";
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
