import { exec as execCb, spawn } from "child_process";
import { createServer } from "net";
import { networkInterfaces } from "os";
import { promisify } from "util";
import { logger, errMsg } from "./logger";

const exec = promisify(execCb);

const VALID_DISTRO_NAME = /^[\w][\w.-]*$/;
const VALID_SESSION_NAME = /^[\w.-]+$/;

function assertSafeSessionName(name: string): void {
	if (!VALID_SESSION_NAME.test(name)) {
		throw new Error(
			`Invalid tmux session name '${name}'. Only letters, digits, '_', '.', and '-' are allowed.`,
		);
	}
}
const EXEC_TIMEOUT = 30_000;
const PROBE_TIMEOUT = 5_000;
const SERVICE_NAME = "sandbox";

import type { DockerMode } from "./settings";
import {
	isValidWriteDir,
	isValidPrivateHosts,
	isValidDomainList,
	isValidMemory,
	isValidCpus,
} from "./validation";

export interface DockerManagerSettings {
	dockerMode: DockerMode;
	composePath: string;
	wslDistro: string;
	vaultPath?: string;
	writeDir?: string;
	memoryFileName?: string;
	ttydPort?: number;
	ttydBindAddress?: string;
	allowedPrivateHosts?: string;
	additionalFirewallDomains?: string;
	containerMemory?: string;
	containerCpus?: string;
	sudoPassword?: string;
	mcpToken?: string;
	mcpPort?: number;
}

export function windowsToWslPath(windowsPath: string): string {
	const match = windowsPath.match(/^([A-Za-z]):[/\\]/);
	if (!match) return windowsPath;
	const driveLetter = match[1].toLowerCase();
	const rest = windowsPath.slice(3).replace(/\\/g, "/");
	return `/mnt/${driveLetter}/${rest}`;
}

/**
 * Builds the inner shell command string with env vars and cd.
 * `dockerCmd` must be a trusted literal — it is NOT escaped.
 */
function buildInnerCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string>,
): string {
	const escapedPath = composePath.replace(/'/g, "'\\''");

	const envPrefix = Object.entries(envVars)
		.map(([key, value]) => {
			const escapedValue = value.replace(/'/g, "'\\''");
			return `${key}='${escapedValue}'`;
		})
		.join(" ");
	const envPart = envPrefix ? `export ${envPrefix} && ` : "";

	return `${envPart}cd '${escapedPath}' && ${dockerCmd}`;
}

// Escape a string so it round-trips unchanged through `bash -c "..."`. The
// single-quoted inner command does NOT shield `$` or backtick from the outer
// double-quoted context — bash still expands them. Order matters: backslash
// first, otherwise later passes would re-escape our own escapes.
function escapeForOuterDoubleQuote(s: string): string {
	return s.replace(/\\/g, "\\\\").replace(/`/g, "\\`").replace(/\$/g, "\\$").replace(/"/g, '\\"');
}

export function buildWslCommand(
	composePath: string,
	wslDistro: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	if (!VALID_DISTRO_NAME.test(wslDistro)) {
		throw new Error(
			`Invalid WSL distribution name '${wslDistro}'. Only alphanumeric characters, hyphens, underscores, and dots are allowed.`,
		);
	}
	const cmdSafe = escapeForOuterDoubleQuote(buildInnerCommand(composePath, dockerCmd, envVars));
	return `wsl -d ${wslDistro} -- bash -c "${cmdSafe}"`;
}

export function buildLocalCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	const cmdSafe = escapeForOuterDoubleQuote(buildInnerCommand(composePath, dockerCmd, envVars));
	return `bash -c "${cmdSafe}"`;
}

/**
 * Builds a command string for Windows cmd.exe when using Local Docker mode.
 * Uses `set` for env vars and `cd /d` for Windows drive paths.
 * No explicit shell wrapper — exec() uses cmd.exe on Windows by default.
 */
export function buildLocalWindowsCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	const escapedPath = composePath.replace(/"/g, '""');

	const envParts = Object.entries(envVars).map(([key, value]) => {
		const escapedValue = value.replace(/"/g, '""');
		return `set "${key}=${escapedValue}"`;
	});

	const envPart = envParts.length > 0 ? envParts.join(" && ") + " && " : "";

	return `${envPart}cd /d "${escapedPath}" && ${dockerCmd}`;
}

// Returns "mirrored", "nat", or undefined when wslinfo is unavailable
// (older WSL, non-Windows, or distro not running).
export async function getWslNetworkingMode(wslDistro: string): Promise<string | undefined> {
	if (process.platform !== "win32") return undefined;
	if (!VALID_DISTRO_NAME.test(wslDistro)) return undefined;
	try {
		const { stdout } = await exec(`wsl.exe -d ${wslDistro} -- wslinfo --networking-mode`, {
			timeout: PROBE_TIMEOUT,
			windowsHide: true,
		});
		return stdout.trim().toLowerCase();
	} catch {
		return undefined;
	}
}

// Returns the Windows host IP the container should use to reach services on
// the host, or undefined when not on Windows / no suitable adapter is found.
// In WSL mirrored mode, eth0 inside WSL carries the Windows LAN IP, so the
// plugin picks the primary LAN adapter. In NAT mode (and when the mode can't
// be detected), picks the vEthernet(WSL) adapter — the legacy behaviour.
export function getWslHostIp(mode: string | undefined): string | undefined {
	if (process.platform !== "win32") return undefined;
	const nets = networkInterfaces();

	const pick = (predicate: (name: string) => boolean): string | undefined => {
		for (const [name, addrs] of Object.entries(nets)) {
			if (!predicate(name)) continue;
			const addr = addrs?.find((a) => a.family === "IPv4" && !a.internal);
			if (addr) return addr.address;
		}
		return undefined;
	};

	if (mode === "mirrored") {
		return pick((n) => !/wsl|vethernet|loopback/i.test(n));
	}
	return pick((n) => n.toLowerCase().includes("wsl"));
}

export class DockerManager {
	private getSettings: () => DockerManagerSettings;
	private busy = false;
	// WSL networking mode and host IP only change when the user reconfigures
	// WSL itself. Probing wsl.exe on every docker call adds a process spawn to
	// every health poll and menu render. Cache per (wslDistro) and clear on
	// restart() — a manual restart is the natural reconfiguration boundary.
	private wslProbeCache: {
		distro: string;
		mode: string | undefined;
		hostIp: string | undefined;
	} | null = null;

	constructor(getSettings: () => DockerManagerSettings) {
		this.getSettings = getSettings;
	}

	isBusy(): boolean {
		return this.busy;
	}

	private async getWslProbe(
		wslDistro: string,
	): Promise<{ mode: string | undefined; hostIp: string | undefined }> {
		if (this.wslProbeCache && this.wslProbeCache.distro === wslDistro) {
			return { mode: this.wslProbeCache.mode, hostIp: this.wslProbeCache.hostIp };
		}
		const mode = await getWslNetworkingMode(wslDistro);
		const hostIp = getWslHostIp(mode);
		this.wslProbeCache = { distro: wslDistro, mode, hostIp };
		return { mode, hostIp };
	}

	private async run(dockerCmd: string, timeout = EXEC_TIMEOUT, quiet = false): Promise<string> {
		const {
			dockerMode,
			composePath,
			wslDistro,
			vaultPath,
			writeDir,
			memoryFileName,
			ttydPort,
			ttydBindAddress,
			allowedPrivateHosts,
			additionalFirewallDomains,
			containerMemory,
			containerCpus,
			sudoPassword,
		} = this.getSettings();

		if (!composePath) {
			throw new Error(
				"Docker Compose path not configured. Set it in Settings > Agent Sandbox.",
			);
		}

		// Convert Windows paths for WSL mode (e.g. Z:\path → /mnt/z/path)
		const effectiveComposePath =
			dockerMode === "wsl" ? windowsToWslPath(composePath) : composePath;

		const { mcpToken, mcpPort } = this.getSettings();

		const envSpec: {
			key: string;
			value: string | number | undefined;
			validate?: (v: string) => boolean;
			invalidMsg?: string;
		}[] = [
			{
				key: "PKM_VAULT_PATH",
				value: vaultPath
					? dockerMode === "wsl"
						? windowsToWslPath(vaultPath)
						: vaultPath
					: "",
			},
			{
				key: "PKM_WRITE_DIR",
				value: writeDir,
				validate: isValidWriteDir,
				invalidMsg:
					"Invalid vault write directory. Must be a relative path without '..' components.",
			},
			{ key: "TTYD_PORT", value: ttydPort ? String(ttydPort) : "" },
			{ key: "TTYD_BIND", value: ttydBindAddress },
			{ key: "MEMORY_FILE_NAME", value: memoryFileName },
			{
				key: "ALLOWED_PRIVATE_HOSTS",
				value: allowedPrivateHosts,
				validate: isValidPrivateHosts,
				invalidMsg:
					"Invalid allowed private hosts. Use comma-separated IPs or CIDRs (e.g. 192.168.1.100, 10.0.0.0/8).",
			},
			{
				key: "OAS_ALLOWED_DOMAINS",
				value: additionalFirewallDomains,
				validate: isValidDomainList,
				invalidMsg:
					"Invalid additional firewall domains. Use comma-separated domain names (e.g. api.atlassian.com, slack.com).",
			},
			{
				key: "CONTAINER_MEMORY",
				value: containerMemory,
				validate: isValidMemory,
				invalidMsg:
					"Invalid memory limit. Use a number with unit suffix (e.g. 4G, 512M, 1T).",
			},
			{
				key: "CONTAINER_CPUS",
				value: containerCpus,
				validate: isValidCpus,
				invalidMsg: "Invalid CPU limit. Use a number (e.g. 4, 2.5).",
			},
			{ key: "SUDO_PASSWORD", value: sudoPassword },
			{ key: "OAS_MCP_TOKEN", value: mcpToken },
			{ key: "OAS_MCP_PORT", value: mcpPort ? String(mcpPort) : "" },
		];

		const envVars: Record<string, string> = {};
		for (const { key, value, validate, invalidMsg } of envSpec) {
			if (value === undefined || value === "") continue;
			const v = String(value);
			if (validate && !validate(v)) throw new Error(invalidMsg!);
			envVars[key] = v;
		}
		// On Windows, inject the actual Windows host IP so the container can
		// reach host.docker.internal correctly under Rancher Desktop / WSL2.
		// The Docker bridge address (172.17.x.x) or Rancher's internal DNS
		// (192.168.127.x) that host-gateway resolves to inside WSL2 is not
		// reachable from within the container. The vEthernet WSL adapter IP
		// (typically 172.20.x.1) is the correct gateway.
		//
		// Mirrored mode is different: there is no vEthernet(WSL) adapter path
		// to the host — the primary LAN adapter is. And Docker's default
		// MASQUERADE rewrites the container source IP to that same LAN IP,
		// which Windows' Hyper-V firewall (allowlist: 172.16.0.0/12) then
		// drops. So disable masquerade on the bridge in mirrored mode only.
		const { mode: wslMode, hostIp: wslHostIp } = await this.getWslProbe(wslDistro);
		if (wslHostIp) {
			envVars.OAS_HOST_IP = wslHostIp;
		}
		if (wslMode === "mirrored") {
			envVars.OAS_IP_MASQ = "false";
		}

		const command =
			dockerMode === "wsl"
				? buildWslCommand(effectiveComposePath, wslDistro, dockerCmd, envVars)
				: process.platform === "win32"
					? buildLocalWindowsCommand(composePath, dockerCmd, envVars)
					: buildLocalCommand(composePath, dockerCmd, envVars);
		try {
			const { stdout } = await exec(command, { timeout, windowsHide: true });
			return stdout.trim();
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string; killed?: boolean };
			const detail = err.stderr || err.message || String(error);
			const combined = (err.stderr || "") + (err.message || "");

			if (!quiet) logger.error("Docker", `Command failed: ${detail}`);

			const dockerNotRunningPatterns = [
				"Cannot connect to the Docker daemon",
				"//./pipe/docker_engine",
				"The system cannot find the file specified",
			];
			const errorPatterns: Array<[boolean, string]> = [
				[
					combined.includes("is not recognized"),
					"WSL is not available. Please ensure WSL is installed and configured.",
				],
				[
					dockerNotRunningPatterns.some((p) => combined.includes(p)),
					"Docker is not running. Please start your Docker engine.",
				],
				[
					combined.includes("No such distribution"),
					`WSL distribution '${wslDistro}' not found. Check Settings > Docker.`,
				],
				[
					combined.includes("no configuration file provided"),
					"docker-compose.yml not found. Check Settings > Docker Compose path.",
				],
				// Only rewrite when the ENOENT is at the Node spawn level (cwd missing →
				// phrase appears in err.message, stderr empty). When a downstream tool
				// like tmux reports "No such file or directory" via stderr, leave the
				// original error so callers can recognise it.
				[
					!err.stderr && (err.message?.includes("No such file or directory") ?? false),
					"Docker Compose directory not found. Check Settings > Docker Compose path.",
				],
				[
					!!err.killed ||
						combined.includes("ETIMEDOUT") ||
						combined.includes("timed out"),
					"Docker is not responding. It may still be starting — try again in a moment.",
				],
			];
			for (const [match, message] of errorPatterns) {
				if (match) throw new Error(message);
			}
			throw new Error(
				"Unexpected Docker error. Open the developer console (Ctrl+Shift+I) for details.",
			);
		}
	}

	/** Wraps an async operation with a busy guard to prevent concurrent docker operations. */
	private async withGuard<T>(fn: () => Promise<T>): Promise<T> {
		if (this.busy) {
			throw new Error("Another container operation is in progress. Please wait.");
		}
		this.busy = true;
		try {
			return await fn();
		} finally {
			this.busy = false;
		}
	}

	/**
	 * `docker compose up -d` is idempotent: compose reuses an existing
	 * container when its effective config matches, and recreates it when
	 * anything differs. No `down` first — that would destroy a healthy
	 * container on every start. For a forced clean recreate, use `restart()`.
	 */
	async start(): Promise<string> {
		return this.withGuard(() => this.run("docker compose up -d"));
	}

	async stop(): Promise<string> {
		return this.withGuard(() => this.run("docker compose down"));
	}

	/** Fire-and-forget stop for plugin unload (parent stays alive). */
	stopDetached(): void {
		const { dockerMode, composePath, wslDistro } = this.getSettings();
		if (!composePath) return;

		let shell: string;
		let args: string[];
		if (dockerMode === "wsl") {
			// On Windows, spawn wsl.exe directly (no bash available on host)
			const wslPath = windowsToWslPath(composePath);
			const escapedPath = wslPath.replace(/'/g, "'\\''");
			const innerCmd = `cd '${escapedPath}' && docker compose down`;
			shell = "wsl";
			args = ["-d", wslDistro, "--", "bash", "-c", innerCmd];
		} else if (process.platform === "win32") {
			// Native Docker on Windows — use cmd.exe (doubles internal quotes).
			const escapedPath = composePath.replace(/"/g, '""');
			shell = "cmd.exe";
			args = ["/c", `cd /d "${escapedPath}" && docker compose down`];
		} else {
			// Linux / Mac
			const command = buildLocalCommand(composePath, "docker compose down");
			shell = "bash";
			args = ["-c", command];
		}

		// On Windows, child processes survive parent exit naturally.
		// detached: true on Windows creates a visible console window.
		const child = spawn(shell, args, {
			detached: process.platform !== "win32",
			stdio: "ignore",
			windowsHide: true,
		});
		child.unref();
	}

	async status(): Promise<string> {
		return this.run("docker compose ps --format json");
	}

	/** Fast status probe with a short timeout for startup checks and health polls. */
	async probeStatus(): Promise<string> {
		return this.run("docker compose ps --format json", PROBE_TIMEOUT);
	}

	/**
	 * Ensure WSL is awake before running Docker commands.
	 * No-op in local mode. In WSL mode, runs a quick `echo ok` to wake
	 * the distro (or fail fast if WSL/distro is unavailable).
	 */
	async ensureWslReady(): Promise<void> {
		const { dockerMode, wslDistro } = this.getSettings();
		if (dockerMode !== "wsl") return;

		if (!VALID_DISTRO_NAME.test(wslDistro)) {
			throw new Error(
				`Invalid WSL distribution name '${wslDistro}'. Only alphanumeric characters, hyphens, underscores, and dots are allowed.`,
			);
		}

		const command = `wsl -d ${wslDistro} -- echo ok`;
		try {
			await exec(command, { timeout: PROBE_TIMEOUT, windowsHide: true });
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string };
			const combined = (err.stderr || "") + (err.message || "");

			if (combined.includes("is not recognized")) {
				throw new Error(
					"WSL is not available. Please ensure WSL is installed and configured.",
				);
			}
			if (combined.includes("No such distribution")) {
				throw new Error(
					`WSL distribution '${wslDistro}' not found. Please check your settings.`,
				);
			}
			throw new Error(`WSL is not responding: ${err.stderr || err.message}`);
		}
	}

	/**
	 * Force a clean recreate: `down` then `up -d`. Use this when you
	 * want to discard in-container runtime state (tmpfs, background
	 * processes, interactive apt-installed packages) or recover from
	 * a container whose state has drifted. Unlike `start()`, this
	 * always destroys and recreates regardless of config match.
	 */
	async restart(): Promise<string> {
		this.wslProbeCache = null;
		return this.withGuard(async () => {
			try {
				await this.run("docker compose down");
			} catch {
				/* may not be running */
			}
			return this.run("docker compose up -d");
		});
	}

	async enableFirewall(): Promise<string> {
		return this.withGuard(() =>
			this.run(
				`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh`,
			),
		);
	}

	async disableFirewall(): Promise<string> {
		return this.withGuard(() =>
			this.run(
				`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh --disable`,
			),
		);
	}

	/**
	 * Probe host-local ports for availability. Returns an array of ports
	 * already bound by a non-compose process. Used as a pre-flight check
	 * before `docker compose up -d`.
	 */
	async checkPortConflicts(ports: number[], host = "127.0.0.1"): Promise<number[]> {
		const conflicts: number[] = [];
		await Promise.all(
			ports.map(
				(port) =>
					new Promise<void>((resolve) => {
						const tester = createServer();
						tester.once("error", (err: NodeJS.ErrnoException) => {
							if (err.code === "EADDRINUSE") conflicts.push(port);
							resolve();
						});
						tester.once("listening", () => {
							tester.close(() => resolve());
						});
						tester.listen(port, host);
					}),
			),
		);
		return conflicts.sort((a, b) => a - b);
	}

	/** Returns the current container ID, or empty string if not running. */
	async getContainerId(): Promise<string> {
		try {
			const output = await this.run(`docker compose ps -q ${SERVICE_NAME}`, PROBE_TIMEOUT);
			return output.trim();
		} catch {
			return "";
		}
	}

	/**
	 * True if compose has any container for this project, regardless of state
	 * (running, exited, restarting, removing). Use this to detect a half-stopped
	 * container that still holds host port mappings while teardown completes.
	 */
	async hasAnyContainer(): Promise<boolean> {
		try {
			const output = await this.run(`docker compose ps -a -q ${SERVICE_NAME}`, PROBE_TIMEOUT);
			return output.trim().length > 0;
		} catch {
			return false;
		}
	}

	async firewallStatus(): Promise<boolean> {
		try {
			const output = await this.run(
				`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh --status`,
			);
			return output.trim() === "enabled";
		} catch {
			return false;
		}
	}

	async firewallSources(): Promise<string> {
		return this.run(
			`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh --list-sources`,
			PROBE_TIMEOUT,
		);
	}

	private tmuxExec(subcmd: string, suppressErrors = false): Promise<string> {
		return this.run(
			`docker compose exec --user claude ${SERVICE_NAME} tmux ${subcmd}`,
			PROBE_TIMEOUT,
			suppressErrors,
		);
	}

	async listSessions(): Promise<string[]> {
		try {
			const output = await this.tmuxExec(`list-sessions -F "#{session_name}"`, true);
			return output
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
		} catch (err) {
			const msg = errMsg(err);
			if (
				!msg.includes("No such file or directory") &&
				!msg.includes("no server running") &&
				!msg.includes("error connecting to")
			) {
				logger.warn("Docker", `listSessions failed: ${msg}`);
			}
			return [];
		}
	}

	/** List sessions with no attached clients — candidates for cleanup. */
	async listEmptySessions(): Promise<string[]> {
		try {
			const output = await this.tmuxExec(
				`list-sessions -F "#{session_name}:#{session_attached}"`,
				true,
			);
			return output
				.split("\n")
				.map((line) => line.trim())
				.filter((line) => line.endsWith(":0"))
				.map((line) => line.slice(0, -2));
		} catch {
			return [];
		}
	}

	async killSession(name: string): Promise<void> {
		assertSafeSessionName(name);
		await this.tmuxExec(`kill-session -t "${name}"`);
	}

	async renameSession(oldName: string, newName: string): Promise<void> {
		assertSafeSessionName(oldName);
		assertSafeSessionName(newName);
		await this.tmuxExec(`rename-session -t "${oldName}" "${newName}"`);
	}

	static parseIsRunning(statusOutput: string): boolean {
		return statusOutput.length > 0 && statusOutput.includes('"running"');
	}
}
