const PREFIX = "[Agent Sandbox]";

type LogLevel = "debug" | "info" | "warn" | "error";

let currentLevel: LogLevel = "info";

const LEVELS: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

export function setLogLevel(level: LogLevel): void {
	currentLevel = level;
}

function shouldLog(level: LogLevel): boolean {
	return LEVELS[level] >= LEVELS[currentLevel];
}

function fmt(component: string, msg: string): string {
	return `${PREFIX} [${component}] ${msg}`;
}

export const logger = {
	debug(component: string, msg: string, ...args: unknown[]): void {
		if (shouldLog("debug"))
			// eslint-disable-next-line no-console
			console.debug(fmt(component, msg), ...args);
	},
	info(component: string, msg: string, ...args: unknown[]): void {
		if (shouldLog("info"))
			// eslint-disable-next-line no-console
			console.info(fmt(component, msg), ...args);
	},
	warn(component: string, msg: string, ...args: unknown[]): void {
		if (shouldLog("warn"))
			// eslint-disable-next-line no-console
			console.warn(fmt(component, msg), ...args);
	},
	error(component: string, msg: string, ...args: unknown[]): void {
		if (shouldLog("error"))
			// eslint-disable-next-line no-console
			console.error(fmt(component, msg), ...args);
	},
};
