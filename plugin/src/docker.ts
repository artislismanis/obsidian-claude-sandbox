import { exec as execCb, spawn } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);

const VALID_DISTRO_NAME = /^[\w][\w.-]*$/;
const EXEC_TIMEOUT = 30_000;
const SERVICE_NAME = "sandbox";

import type { DockerMode } from "./settings";
import { isValidWriteDir, isValidPrivateHosts, isValidMemory, isValidCpus } from "./validation";

// Re-export validators so existing imports from docker.ts keep working
export {
	isValidWriteDir,
	isValidPrivateHosts,
	isValidMemory,
	isValidCpus,
	isValidBindAddress,
} from "./validation";

export interface DockerManagerSettings {
	dockerMode: DockerMode;
	composePath: string;
	wslDistro: string;
	vaultPath?: string;
	writeDir?: string;
	ttydPort?: number;
	ttydBindAddress?: string;
	ttydUsername?: string;
	ttydPassword?: string;
	allowedPrivateHosts?: string;
	containerMemory?: string;
	containerCpus?: string;
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

export class DockerManager {
	private getSettings: () => DockerManagerSettings;
	private busy = false;

	constructor(getSettings: () => DockerManagerSettings) {
		this.getSettings = getSettings;
	}

	isBusy(): boolean {
		return this.busy;
	}

	private async run(dockerCmd: string): Promise<string> {
		const {
			dockerMode,
			composePath,
			wslDistro,
			vaultPath,
			writeDir,
			ttydPort,
			ttydBindAddress,
			ttydUsername,
			ttydPassword,
			allowedPrivateHosts,
			containerMemory,
			containerCpus,
		} = this.getSettings();

		if (!composePath) {
			throw new Error(
				"Docker Compose path not configured. Set it in Settings > Agent Sandbox.",
			);
		}

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
		if (ttydUsername) {
			envVars.TTYD_USER = ttydUsername;
		}
		if (ttydBindAddress) {
			envVars.TTYD_BIND = ttydBindAddress;
		}
		if (ttydPassword) {
			envVars.TTYD_PASSWORD = ttydPassword;
		}
		if (allowedPrivateHosts) {
			if (!isValidPrivateHosts(allowedPrivateHosts)) {
				throw new Error(
					"Invalid allowed private hosts. Use comma-separated IPs or CIDRs (e.g. 192.168.1.100, 10.0.0.0/8).",
				);
			}
			envVars.ALLOWED_PRIVATE_HOSTS = allowedPrivateHosts;
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

		const command =
			dockerMode === "wsl"
				? buildWslCommand(composePath, wslDistro, dockerCmd, envVars)
				: buildLocalCommand(composePath, dockerCmd, envVars);
		try {
			const { stdout } = await exec(command, { timeout: EXEC_TIMEOUT });
			return stdout.trim();
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string };
			const combined = (err.stderr || "") + (err.message || "");

			if (combined.includes("is not recognized")) {
				throw new Error(
					"WSL is not available. Please ensure WSL is installed and configured.",
				);
			}
			if (combined.includes("Cannot connect to the Docker daemon")) {
				throw new Error(
					"Docker is not running. Please start Docker Desktop or the Docker daemon.",
				);
			}
			if (combined.includes("No such distribution")) {
				throw new Error(
					`WSL distribution '${wslDistro}' not found. Please check your settings.`,
				);
			}
			throw new Error(`Docker command failed: ${err.stderr || err.message}`);
		}
	}

	/** Wraps run() with a busy guard to prevent concurrent docker operations. */
	private async guardedRun(dockerCmd: string): Promise<string> {
		if (this.busy) {
			throw new Error("Another container operation is in progress. Please wait.");
		}
		this.busy = true;
		try {
			return await this.run(dockerCmd);
		} finally {
			this.busy = false;
		}
	}

	async start(): Promise<string> {
		if (this.busy) {
			throw new Error("Another container operation is in progress. Please wait.");
		}
		this.busy = true;
		try {
			// Stop first to ensure env vars (PKM_VAULT_PATH) are fresh
			try {
				await this.run("docker compose down");
			} catch {
				/* may not be running */
			}
			return await this.run("docker compose up -d");
		} finally {
			this.busy = false;
		}
	}

	async stop(): Promise<string> {
		return this.guardedRun("docker compose down");
	}

	/** Fire-and-forget stop that survives parent process exit. */
	stopDetached(): void {
		const { dockerMode, composePath, wslDistro } = this.getSettings();
		if (!composePath) return;

		let shell: string;
		let args: string[];
		if (dockerMode === "wsl") {
			// On Windows, spawn wsl.exe directly (no bash available on host)
			const escapedPath = composePath.replace(/'/g, "'\\''");
			const innerCmd = `cd '${escapedPath}' && docker compose down`;
			shell = "wsl";
			args = ["-d", wslDistro, "--", "bash", "-c", innerCmd];
		} else {
			const command = buildLocalCommand(composePath, "docker compose down");
			shell = "bash";
			args = ["-c", command];
		}

		const child = spawn(shell, args, {
			detached: true,
			stdio: "ignore",
		});
		child.unref();
	}

	async status(): Promise<string> {
		return this.run("docker compose ps --format json");
	}

	/** Delegates to start() which does down+up to pick up fresh env vars. */
	async restart(): Promise<string> {
		return this.start();
	}

	async enableFirewall(): Promise<string> {
		return this.guardedRun(
			`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh`,
		);
	}

	async disableFirewall(): Promise<string> {
		return this.guardedRun(
			`docker compose exec --user root ${SERVICE_NAME} /usr/local/bin/init-firewall.sh --disable`,
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

	static parseIsRunning(statusOutput: string): boolean {
		return statusOutput.length > 0 && statusOutput.includes('"running"');
	}
}
