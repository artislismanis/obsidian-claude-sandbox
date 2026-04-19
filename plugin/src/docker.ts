import { exec as execCb, spawn } from "child_process";
import { networkInterfaces } from "os";
import { promisify } from "util";

const exec = promisify(execCb);

const VALID_DISTRO_NAME = /^[\w][\w.-]*$/;
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
	const cmdSafe = buildInnerCommand(composePath, dockerCmd, envVars).replace(/"/g, '\\"');
	return `wsl -d ${wslDistro} -- bash -c "${cmdSafe}"`;
}

export function buildLocalCommand(
	composePath: string,
	dockerCmd: string,
	envVars: Record<string, string> = {},
): string {
	const cmdSafe = buildInnerCommand(composePath, dockerCmd, envVars).replace(/"/g, '\\"');
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

// Returns the IP of the first Windows vEthernet WSL adapter, or undefined
// when not on Windows or when no WSL adapter is found.
function getWslHostIp(): string | undefined {
	if (process.platform !== "win32") return undefined;
	const nets = networkInterfaces();
	for (const [name, addrs] of Object.entries(nets)) {
		if (!name.toLowerCase().includes("wsl")) continue;
		const addr = addrs?.find((a) => a.family === "IPv4" && !a.internal);
		if (addr) return addr.address;
	}
	return undefined;
}

export class DockerManager {
	private getSettings: () => DockerManagerSettings;
	private busy = false;

	constructor(getSettings: () => DockerManagerSettings) {
		this.getSettings = getSettings;
	}

	isBusy(): boolean {
		return this.busy;
	}

	private async run(dockerCmd: string, timeout = EXEC_TIMEOUT): Promise<string> {
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

		const envVars: Record<string, string> = {};
		if (vaultPath) {
			envVars.PKM_VAULT_PATH = dockerMode === "wsl" ? windowsToWslPath(vaultPath) : vaultPath;
		}
		if (writeDir) {
			if (!isValidWriteDir(writeDir)) {
				throw new Error(
					"Invalid vault write directory. Must be a relative path without '..' components.",
				);
			}
			envVars.PKM_WRITE_DIR = writeDir;
		}
		if (ttydPort) {
			envVars.TTYD_PORT = String(ttydPort);
		}
		if (ttydBindAddress) {
			envVars.TTYD_BIND = ttydBindAddress;
		}
		if (memoryFileName) {
			envVars.MEMORY_FILE_NAME = memoryFileName;
		}
		if (allowedPrivateHosts) {
			if (!isValidPrivateHosts(allowedPrivateHosts)) {
				throw new Error(
					"Invalid allowed private hosts. Use comma-separated IPs or CIDRs (e.g. 192.168.1.100, 10.0.0.0/8).",
				);
			}
			envVars.ALLOWED_PRIVATE_HOSTS = allowedPrivateHosts;
		}
		if (additionalFirewallDomains) {
			if (!isValidDomainList(additionalFirewallDomains)) {
				throw new Error(
					"Invalid additional firewall domains. Use comma-separated domain names (e.g. api.atlassian.com, slack.com).",
				);
			}
			envVars.OAS_ALLOWED_DOMAINS = additionalFirewallDomains;
		}
		if (containerMemory) {
			if (!isValidMemory(containerMemory)) {
				throw new Error(
					"Invalid memory limit. Use a number with unit suffix (e.g. 4G, 512M, 1T).",
				);
			}
			envVars.CONTAINER_MEMORY = containerMemory;
		}
		if (containerCpus) {
			if (!isValidCpus(containerCpus)) {
				throw new Error("Invalid CPU limit. Use a number (e.g. 4, 2.5).");
			}
			envVars.CONTAINER_CPUS = containerCpus;
		}
		if (sudoPassword) {
			envVars.SUDO_PASSWORD = sudoPassword;
		}

		const { mcpToken, mcpPort } = this.getSettings();
		if (mcpToken) {
			envVars.OAS_MCP_TOKEN = mcpToken;
		}
		if (mcpPort) {
			envVars.OAS_MCP_PORT = String(mcpPort);
		}
		// On Windows, inject the actual Windows host IP so the container can
		// reach host.docker.internal correctly under Rancher Desktop / WSL2.
		// The Docker bridge address (172.17.x.x) or Rancher's internal DNS
		// (192.168.127.x) that host-gateway resolves to inside WSL2 is not
		// reachable from within the container. The vEthernet WSL adapter IP
		// (typically 172.20.x.1) is the correct gateway.
		const wslHostIp = getWslHostIp();
		if (wslHostIp) {
			envVars.OAS_HOST_IP = wslHostIp;
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

			// eslint-disable-next-line no-console
			console.error("[Agent Sandbox] Docker command failed:", detail);

			if (combined.includes("is not recognized")) {
				throw new Error(
					"WSL is not available. Please ensure WSL is installed and configured.",
				);
			}
			if (
				combined.includes("Cannot connect to the Docker daemon") ||
				combined.includes("//./pipe/docker_engine") ||
				combined.includes("The system cannot find the file specified")
			) {
				throw new Error("Docker is not running. Please start your Docker engine.");
			}
			if (combined.includes("No such distribution")) {
				throw new Error(
					`WSL distribution '${wslDistro}' not found. Check Settings > Docker.`,
				);
			}
			if (combined.includes("no configuration file provided")) {
				throw new Error(
					"docker-compose.yml not found. Check Settings > Docker Compose path.",
				);
			}
			if (combined.includes("No such file or directory")) {
				throw new Error(
					"Docker Compose directory not found. Check Settings > Docker Compose path.",
				);
			}
			if (err.killed || combined.includes("ETIMEDOUT") || combined.includes("timed out")) {
				throw new Error(
					"Docker is not responding. It may still be starting — try again in a moment.",
				);
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
			// Native Docker on Windows — use cmd.exe
			const escapedPath = composePath.replace(/"/g, '\\"');
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

	async listSessions(): Promise<string[]> {
		try {
			const output = await this.run(
				`docker compose exec --user claude ${SERVICE_NAME} tmux list-sessions -F "#{session_name}"`,
				PROBE_TIMEOUT,
			);
			return output
				.split("\n")
				.map((s) => s.trim())
				.filter(Boolean);
		} catch {
			return [];
		}
	}

	async renameSession(oldName: string, newName: string): Promise<void> {
		await this.run(
			`docker compose exec --user claude ${SERVICE_NAME} tmux rename-session -t "${oldName}" "${newName}"`,
			PROBE_TIMEOUT,
		);
	}

	static parseIsRunning(statusOutput: string): boolean {
		return statusOutput.length > 0 && statusOutput.includes('"running"');
	}
}
