import { execSync, type ExecSyncOptions } from "child_process";
import { resolve } from "path";
import * as http from "http";

export const COMPOSE_FILE = resolve(__dirname, "../docker-compose.test.yml");
export const VAULT_DIR = resolve(__dirname, "../fixtures/vault");
export const TTYD_PORT = 17681;
export const MCP_PORT = 38080;
export const MCP_TOKEN = "integration-test-token";

const execOpts: ExecSyncOptions = {
	stdio: "pipe",
	env: {
		...process.env,
		PKM_VAULT_PATH: VAULT_DIR,
		PKM_WRITE_DIR: "agent-workspace",
		TEST_HOST_TTYD_PORT: String(TTYD_PORT),
		CONTAINER_MEMORY: "4G",
		CONTAINER_CPUS: "2",
		OAS_MCP_TOKEN: MCP_TOKEN,
		OAS_MCP_PORT: String(MCP_PORT),
	},
};

function compose(cmd: string): string {
	return execSync(`docker compose -f "${COMPOSE_FILE}" ${cmd}`, execOpts).toString().trim();
}

export function isDockerAvailable(): boolean {
	try {
		execSync("docker info", { stdio: "pipe", timeout: 5000 });
		return true;
	} catch {
		return false;
	}
}

export function isImageBuilt(): boolean {
	try {
		const output = execSync("docker images oas-sandbox:latest --format '{{.ID}}'", {
			stdio: "pipe",
		});
		return output.toString().trim().length > 0;
	} catch {
		return false;
	}
}

// Docker Compose prefixes volumes with the project name. The live compose
// project is named `oas` (see container/docker-compose.yml), so the volume
// declared as `oas-claude-config` ends up as `oas_oas-claude-config`.
const LIVE_CLAUDE_VOLUME = "oas_oas-claude-config";
const TEST_CLAUDE_VOLUME = "oas-test_oas-test-claude-config";

/**
 * Returns true if the live oas project's claude-config volume exists.
 * Tests can opt-in to reusing its Claude subscription auth via seedClaudeAuth().
 */
export function hasLiveClaudeAuth(): boolean {
	try {
		execSync(`docker volume inspect ${LIVE_CLAUDE_VOLUME}`, { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

/**
 * Copy the live project's claude-config volume into the test project's
 * claude-config volume so Claude Code inside the test container is
 * already authenticated. Idempotent. Returns true on success.
 *
 * The test volume is torn down by containerDown() (docker compose down -v),
 * so the seeded auth never leaks back to the live volume.
 */
export function seedClaudeAuth(): boolean {
	if (!hasLiveClaudeAuth()) return false;
	try {
		execSync(`docker volume create ${TEST_CLAUDE_VOLUME}`, { stdio: "pipe" });
	} catch {
		// already exists, fine
	}
	try {
		execSync(
			`docker run --rm ` +
				`-v ${LIVE_CLAUDE_VOLUME}:/src:ro ` +
				`-v ${TEST_CLAUDE_VOLUME}:/dst ` +
				`alpine sh -c "cp -a /src/. /dst/"`,
			{ stdio: "pipe" },
		);
		return true;
	} catch {
		return false;
	}
}

function forceCleanup(): void {
	// Nuclear cleanup — ignores errors because any of these may not exist
	try {
		execSync("docker rm -f oas-test-sandbox", { stdio: "pipe" });
	} catch {
		/* ok */
	}
	try {
		execSync("docker network rm oas-test_default", { stdio: "pipe" });
	} catch {
		/* ok */
	}
	try {
		compose("down -v --remove-orphans");
	} catch {
		/* ok */
	}
}

export function containerUp(): void {
	forceCleanup();
	let lastErr: unknown;
	for (let attempt = 1; attempt <= 3; attempt++) {
		try {
			compose("up -d");
			return;
		} catch (err) {
			lastErr = err;
			forceCleanup();
			// Brief pause before retry — Docker state may be settling
			try {
				execSync("sleep 1", { stdio: "pipe" });
			} catch {
				/* ok */
			}
		}
	}
	throw lastErr;
}

export function containerDown(): void {
	forceCleanup();
}

export function containerExec(cmd: string): string {
	// Use `docker exec` directly rather than `docker compose exec`.
	// Direct exec is faster and avoids docker-compose's internal exec-id
	// tracking, which was producing spurious "No such exec instance"
	// errors in fast-running test suites.
	return execSync(`docker exec -i oas-test-sandbox ${cmd}`, execOpts).toString().trim();
}

export function containerLogs(): string {
	try {
		return execSync("docker logs --tail 50 oas-test-sandbox", { stdio: "pipe" }).toString();
	} catch {
		return "(no logs available)";
	}
}

export async function waitForHealth(
	url: string,
	timeoutMs = 30000,
	intervalMs = 500,
): Promise<void> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		try {
			const status = await httpGet(url);
			if (status >= 200 && status < 400) return;
		} catch {
			// not ready yet
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	let diag = "";
	try {
		diag = "\n\n--- container logs ---\n" + containerLogs();
	} catch {
		diag = "\n(could not fetch container logs)";
	}
	try {
		const ps = compose("ps --format json");
		diag += "\n\n--- container status ---\n" + ps;
	} catch {
		// best effort
	}
	throw new Error(`Health check timeout for ${url} after ${timeoutMs}ms${diag}`);
}

export function httpGet(url: string): Promise<number> {
	return new Promise((resolve, reject) => {
		http.get(url, (res) => resolve(res.statusCode ?? 0)).on("error", reject);
	});
}

/**
 * Parse a response body that may be JSON or SSE (Server-Sent Events).
 * MCP Streamable HTTP may return either format; SSE looks like:
 *   event: message
 *   data: {"jsonrpc":"2.0", ...}
 */
export function parseJsonOrSse(body: string): unknown {
	const trimmed = body.trim();
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return JSON.parse(trimmed);
	}
	// SSE: find the first `data: ` line and parse its payload as JSON
	const match = trimmed.match(/^data:\s*(.+)$/m);
	if (match) return JSON.parse(match[1]);
	throw new Error(`Cannot parse response body: ${body.slice(0, 200)}`);
}

export function httpPost(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string }> {
	const data = JSON.stringify(body);
	const parsed = new URL(url);
	return new Promise((resolve, reject) => {
		const req = http.request(
			{
				hostname: parsed.hostname,
				port: parsed.port,
				path: parsed.pathname,
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					Accept: "application/json, text/event-stream",
					...headers,
				},
			},
			(res: http.IncomingMessage) => {
				let buf = "";
				res.on("data", (chunk: Buffer) => (buf += chunk.toString()));
				res.on("end", () => resolve({ status: res.statusCode ?? 0, body: buf }));
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}
