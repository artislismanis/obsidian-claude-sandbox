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

// The test container's Claude auth lives in this external volume.
// It persists across `compose down -v` because it is declared external in
// docker-compose.test.yml. Seed it once via `docker exec -it oas-test-sandbox claude`.
const TEST_CLAUDE_VOLUME = "oas-test-claude-config";

/**
 * Ensure the external claude-config volume exists. Called by globalSetup before
 * compose up so Docker does not reject the external volume reference.
 * docker volume create is idempotent — exits 0 if the volume already exists.
 */
export function ensureTestClaudeVolume(): void {
	try {
		execSync(`docker volume create ${TEST_CLAUDE_VOLUME}`, { stdio: "pipe" });
	} catch {
		// already exists or docker unavailable — both handled downstream
	}
}

/**
 * Returns true if the test container's claude-config volume has been
 * authenticated (i.e. the sign-in was done via `docker exec … claude`).
 * Uses a disposable alpine container to peek inside the volume without
 * requiring the test container to be running.
 */
export function hasTestClaudeAuth(): boolean {
	try {
		const out = execSync(
			`docker run --rm -v ${TEST_CLAUDE_VOLUME}:/auth:ro alpine sh -c "ls -A /auth | head -1"`,
			{ stdio: "pipe", timeout: 15000 },
		);
		return out.toString().trim().length > 0;
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
	//
	// Run as `claude` (non-root) to match how ttyd sessions run in prod.
	// Claude Code refuses to run as root ("cannot be used with root/sudo
	// privileges"), and this also catches any bugs where the plugin
	// assumes root privileges it shouldn't have.
	return execSync(`docker exec -i -u claude oas-test-sandbox ${cmd}`, execOpts).toString().trim();
}

/**
 * Run a command inside the container as root. Needed for tests that
 * exercise root-only operations like iptables (firewall) or that
 * deliberately test the sudo gate.
 */
export function containerExecRoot(cmd: string): string {
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

/** Like httpPost but also returns response headers. Used for MCP session init. */
export function httpPostFull(
	url: string,
	body: unknown,
	headers: Record<string, string> = {},
): Promise<{ status: number; body: string; headers: Record<string, string> }> {
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
				const resHeaders: Record<string, string> = {};
				for (const [k, v] of Object.entries(res.headers)) {
					if (v !== undefined)
						resHeaders[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
				}
				res.on("data", (chunk: Buffer) => (buf += chunk.toString()));
				res.on("end", () =>
					resolve({ status: res.statusCode ?? 0, body: buf, headers: resHeaders }),
				);
			},
		);
		req.on("error", reject);
		req.write(data);
		req.end();
	});
}

// ── MCP session helpers ────────────────────────────────────────────────────

export interface McpSession {
	sessionId: string;
	url: string;
	token: string;
}

/** Send the MCP initialize handshake and return a session ready for further calls. */
export async function mcpInitialize(port: number, token: string): Promise<McpSession> {
	const url = `http://127.0.0.1:${port}/mcp`;
	const res = await httpPostFull(
		url,
		{
			jsonrpc: "2.0",
			id: 1,
			method: "initialize",
			params: {
				protocolVersion: "2025-03-26",
				capabilities: {},
				clientInfo: { name: "integration-test", version: "1.0" },
			},
		},
		{ Authorization: `Bearer ${token}` },
	);
	return { sessionId: res.headers["mcp-session-id"] ?? "", url, token };
}

/** Send a JSON-RPC request on an established MCP session. Returns the parsed envelope. */
export async function mcpRequest(
	session: McpSession,
	method: string,
	params?: unknown,
): Promise<unknown> {
	const headers: Record<string, string> = { Authorization: `Bearer ${session.token}` };
	if (session.sessionId) headers["Mcp-Session-Id"] = session.sessionId;
	const res = await httpPost(
		session.url,
		{ jsonrpc: "2.0", id: Date.now(), method, params },
		headers,
	);
	return parseJsonOrSse(res.body);
}
