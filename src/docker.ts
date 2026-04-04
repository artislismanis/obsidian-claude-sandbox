import { exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);

const VALID_DISTRO_NAME = /^[\w][\w.-]*$/;
const EXEC_TIMEOUT = 30_000;

export interface DockerManagerSettings {
	composePath: string;
	wslDistro: string;
	vaultPath?: string;
}

export function windowsToWslPath(windowsPath: string): string {
	const match = windowsPath.match(/^([A-Za-z]):[/\\]/);
	if (!match) return windowsPath;
	const driveLetter = match[1].toLowerCase();
	const rest = windowsPath.slice(3).replace(/\\/g, "/");
	return `/mnt/${driveLetter}/${rest}`;
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
	const escapedPath = composePath.replace(/'/g, "'\\''");

	const envPrefix = Object.entries(envVars)
		.map(([key, value]) => {
			const escapedValue = value.replace(/'/g, "'\\''");
			return `${key}='${escapedValue}'`;
		})
		.join(" ");
	const envPart = envPrefix ? `export ${envPrefix} && ` : "";

	const innerCmd = `${envPart}cd '${escapedPath}' && ${dockerCmd}`;
	const cmdSafe = innerCmd.replace(/"/g, '\\"');
	return `wsl -d ${wslDistro} -- bash -c "${cmdSafe}"`;
}

export class DockerManager {
	private getSettings: () => DockerManagerSettings;

	constructor(getSettings: () => DockerManagerSettings) {
		this.getSettings = getSettings;
	}

	private async run(dockerCmd: string): Promise<string> {
		const { composePath, wslDistro, vaultPath } = this.getSettings();

		const envVars: Record<string, string> = {};
		if (vaultPath) {
			envVars.PKM_VAULT_PATH = windowsToWslPath(vaultPath);
		}

		const command = buildWslCommand(composePath, wslDistro, dockerCmd, envVars);
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

	async start(): Promise<string> {
		// Stop first to ensure env vars (PKM_VAULT_PATH) are fresh
		try {
			await this.run("docker compose down");
		} catch {
			/* may not be running */
		}
		return this.run("docker compose up -d");
	}

	async stop(): Promise<string> {
		return this.run("docker compose down");
	}

	async status(): Promise<string> {
		return this.run("docker compose ps --format json");
	}

	async restart(): Promise<string> {
		return this.run("docker compose restart");
	}

	static parseIsRunning(statusOutput: string): boolean {
		return statusOutput.length > 0 && statusOutput.includes('"running"');
	}
}
