/** "Analyze in Sandbox": URI handlers, file-menu submenu, prompt-template loader. */

import type { App, Menu, TFile } from "obsidian";
import { Notice } from "obsidian";
import { inputModal } from "./modals";
import * as fs from "fs/promises";
import { join as pathJoin } from "path";
import { getVaultBasePath, tryOpenSubmenu } from "./obsidian-internals";
import { parsePromptTemplate, substituteFilePlaceholder } from "./prompt-template";

export interface PromptTemplate {
	name: string;
	label: string;
	body: string;
}

/** What the plugin needs to give us to drive the Analyze flow. */
export interface AnalyzeHost {
	app: App;
	isContainerRunning: () => boolean;
	activateTerminalView: (sessionName?: string, initialPrompt?: string) => Promise<unknown>;
}

export class AnalyzeManager {
	private cachedTemplates: PromptTemplate[] | null = null;
	private lastRefreshAt = 0;

	constructor(private host: AnalyzeHost) {}

	/**
	 * Load prompt templates from `.claude/prompts/*.md` (vault root) or the
	 * repo sibling `workspace/.claude/prompts/`. First non-empty line before
	 * `---` is the label; body can contain `{{file}}` placeholders.
	 * Result cached after first call — call {@link refreshTemplates} to
	 * invalidate.
	 */
	async loadTemplates(): Promise<PromptTemplate[]> {
		if (this.cachedTemplates) return this.cachedTemplates;
		const loaded = await this.readTemplatesFromDisk();
		this.cachedTemplates = loaded;
		return loaded;
	}

	/** Invalidate the template cache — picked up on next loadTemplates call. */
	refreshTemplates(): void {
		this.cachedTemplates = null;
	}

	/** Preload and cache templates — call at plugin init to remove the menu race. */
	async prewarm(): Promise<void> {
		this.cachedTemplates = await this.readTemplatesFromDisk();
	}

	private async readTemplatesFromDisk(): Promise<PromptTemplate[]> {
		const base = getVaultBasePath(this.host.app);
		if (!base) return [];
		const candidates = [
			pathJoin(base, ".claude", "prompts"),
			pathJoin(base, "..", "workspace", ".claude", "prompts"),
		];
		// fs/promises is statically imported at the top — using a dynamic import
		// here used to fail at runtime in Obsidian's renderer with
		// "Failed to resolve module specifier 'fs/promises'", silently breaking
		// the prewarm path on every plugin load.
		// Try each candidate; first successful readdir wins. Skip the prior
		// existsSync gate — readdir's ENOENT path serves the same purpose
		// without two extra stat calls per attempt.
		for (const dir of candidates) {
			let entries: string[];
			try {
				entries = await fs.readdir(dir);
			} catch {
				continue;
			}
			// Parallelise reads — the loop was previously sequential, so a
			// directory of N templates served N round trips of stat+read
			// where one Promise.all batch handles them concurrently. Each
			// per-file try/catch returns null on failure so unreadable
			// templates are skipped without poisoning the whole batch.
			const mdEntries = entries.filter((e) => e.endsWith(".md"));
			const settled = await Promise.all(
				mdEntries.map(async (entry): Promise<PromptTemplate | null> => {
					try {
						const content = await fs.readFile(pathJoin(dir, entry), "utf-8");
						const [label, body] = parsePromptTemplate(content, entry);
						return { name: entry.replace(/\.md$/, ""), label, body };
					} catch {
						return null;
					}
				}),
			);
			const out = settled.filter((t): t is PromptTemplate => t !== null);
			return out.sort((a, b) => a.label.localeCompare(b.label));
		}
		return [];
	}

	/** Open a terminal + start Claude with a templated (or default) prompt. */
	async runAnalyze(vaultPath: string, templateName?: string): Promise<void> {
		if (!this.host.isContainerRunning()) {
			new Notice("Sandbox container is not running.");
			return;
		}
		const prompt = await this.buildPrompt(vaultPath, templateName);
		if (!prompt) return;
		await this.host.activateTerminalView(undefined, prompt);
	}

	/** Modal-input fallback for when no templates are configured. */
	async runAnalyzeCustom(vaultPath: string): Promise<void> {
		if (!this.host.isContainerRunning()) {
			new Notice("Sandbox container is not running.");
			return;
		}
		const body = await inputModal(this.host.app, {
			title: "Analyze in Sandbox",
			message: `Prompt for ${vaultPath} — @${vaultPath} will be appended automatically.`,
			placeholder: "e.g. Summarize this note in 3 bullet points",
			ctaLabel: "Run",
		});
		if (!body) return;
		const prompt = `${body}\n\n(Context: @${vaultPath})`;
		await this.host.activateTerminalView(undefined, prompt);
	}

	/**
	 * Append an "Analyze in Sandbox" submenu to an Obsidian file menu.
	 * Uses the cached template list (pre-populated by {@link prewarm}) to
	 * build submenu items synchronously — no async race against menu render.
	 * Kicks off a refresh in the background so subsequent menu opens reflect
	 * new / removed templates.
	 */
	attachFileMenu(menu: Menu, file: TFile): void {
		const templates = this.cachedTemplates ?? [];
		// Refresh in the background for the next open, but rate-limit so
		// successive right-clicks don't N+1 the filesystem. The user can force
		// a fresh read via the explicit refresh path (plugin reload / setting).
		const REFRESH_INTERVAL_MS = 30_000;
		const now = Date.now();
		if (now - this.lastRefreshAt > REFRESH_INTERVAL_MS) {
			this.lastRefreshAt = now;
			void this.readTemplatesFromDisk().then((fresh) => (this.cachedTemplates = fresh));
		}

		menu.addItem((item) => {
			item.setTitle("Analyze in Sandbox").setIcon("bot");
			const submenu = tryOpenSubmenu(item);
			const container: Pick<Menu, "addItem"> = submenu ?? menu;
			if (templates.length === 0) {
				container.addItem((sub) =>
					sub.setTitle("Custom prompt…").onClick(() => this.runAnalyzeCustom(file.path)),
				);
				return;
			}
			for (const t of templates) {
				container.addItem((sub) =>
					sub.setTitle(t.label).onClick(() => void this.runAnalyze(file.path, t.name)),
				);
			}
			container.addItem((sub) =>
				sub.setTitle("Custom prompt…").onClick(() => this.runAnalyzeCustom(file.path)),
			);
		});
	}

	private async buildPrompt(vaultPath: string, templateName?: string): Promise<string | null> {
		if (!templateName) {
			return `Please analyze @${vaultPath}.`;
		}
		const templates = await this.loadTemplates();
		const tmpl = templates.find((t) => t.name === templateName);
		if (!tmpl) {
			new Notice(`Unknown prompt template: ${templateName}`);
			return null;
		}
		return substituteFilePlaceholder(tmpl.body, vaultPath);
	}
}
