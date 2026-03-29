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
		const innerCmd = `cd '${this.composePath.replace(/'/g, "'\\''")}' && ${dockerCmd}`;
		return `wsl -d ${this.wslDistro} -- bash -c "${innerCmd}"`;
	}

	private async run(dockerCmd: string): Promise<string> {
		const command = this.buildCommand(dockerCmd);
		try {
			const { stdout } = await exec(command);
			return stdout.trim();
		} catch (error: unknown) {
			const err = error as { stderr?: string; message?: string };
			const combined = (err.stderr || "") + (err.message || "");

			if (combined.includes("is not recognized")) {
				throw new Error(
					"WSL is not available. Please ensure WSL is installed and configured."
				);
			}
			if (combined.includes("Cannot connect to the Docker daemon")) {
				throw new Error(
					"Docker is not running. Please start Docker Desktop or the Docker daemon."
				);
			}
			if (combined.includes("No such distribution")) {
				throw new Error(
					`WSL distribution '${this.wslDistro}' not found. Please check your settings.`
				);
			}
			throw new Error(
				`Docker command failed: ${err.stderr || err.message}`
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

	static parseIsRunning(statusOutput: string): boolean {
		return statusOutput.length > 0 && statusOutput.includes('"running"');
	}

	async isRunning(): Promise<boolean> {
		try {
			return DockerManager.parseIsRunning(await this.status());
		} catch {
			return false;
		}
	}
}
