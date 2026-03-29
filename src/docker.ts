import { exec as execCb } from "child_process";
import { promisify } from "util";

const exec = promisify(execCb);

interface DockerManagerSettings {
	composePath: string;
	wslDistro: string;
}

export class DockerManager {
	private composePath: string;
	private wslDistro: string;

	constructor(settings: DockerManagerSettings) {
		this.composePath = settings.composePath;
		this.wslDistro = settings.wslDistro;
	}

	private buildCommand(dockerCmd: string): string {
		const innerCmd = `cd ${this.composePath} && ${dockerCmd}`;
		return `wsl -d ${this.wslDistro} -- bash -c "${innerCmd}"`;
	}

	private async run(dockerCmd: string): Promise<string> {
		const command = this.buildCommand(dockerCmd);
		try {
			const { stdout } = await exec(command);
			return stdout.trim();
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string };
			const stderr = err.stderr || "";
			const message = err.message || "";

			if (
				stderr.includes("is not recognized") ||
				message.includes("is not recognized")
			) {
				throw new Error(
					"WSL is not available. Please ensure WSL is installed and configured."
				);
			}
			if (
				stderr.includes("Cannot connect to the Docker daemon") ||
				message.includes("Cannot connect to the Docker daemon")
			) {
				throw new Error(
					"Docker is not running. Please start Docker Desktop or the Docker daemon."
				);
			}
			if (
				stderr.includes("No such distribution") ||
				message.includes("No such distribution")
			) {
				throw new Error(
					`WSL distribution '${this.wslDistro}' not found. Please check your settings.`
				);
			}
			throw new Error(
				`Docker command failed: ${stderr || message}`
			);
		}
	}

	async start(): Promise<string> {
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

	async isRunning(): Promise<boolean> {
		try {
			const output = await this.run("docker compose ps --format json");
			return output.length > 0 && output.includes('"running"');
		} catch {
			return false;
		}
	}
}
