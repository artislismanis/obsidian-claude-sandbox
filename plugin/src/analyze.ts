/**
 * "Analyze in Sandbox" plumbing — URI handlers, file-menu submenu, prompt
 * template loading, and the custom-prompt modal. Kept out of main.ts so the
 * plugin entry doesn't carry filesystem / file-menu wiring inline.
 */

import type { App, Menu, TFile } from "obsidian";
import { FileSystemAdapter, Notice } from "obsidian";
import { inputModal } from "./modals";
import { existsSync as fsExistsSync } from "fs";
import { join as pathJoin } from "path";
import { tryOpenSubmenu } from "./obsidian-internals";
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
		const dir = this.resolvePromptsDir();
		if (!dir) return [];
		try {
			const fs = await import("fs/promises");
			const entries = await fs.readdir(dir).catch(() => [] as string[]);
			const out: PromptTemplate[] = [];
			for (const entry of entries) {
				if (!entry.endsWith(".md")) continue;
				const content = await fs.readFile(pathJoin(dir, entry), "utf-8");
				const [label, body] = parsePromptTemplate(content, entry);
				out.push({ name: entry.replace(/\.md$/, ""), label, body });
			}
			return out.sort((a, b) => a.label.localeCompare(b.label));
		} catch {
			return [];
		}
	}

	private resolvePromptsDir(): string | null {
		const adapter = this.host.app.vault.adapter;
		if (!(adapter instanceof FileSystemAdapter)) return null;
		const base = adapter.getBasePath();
		const candidates = [
			pathJoin(base, ".claude", "prompts"),
			pathJoin(base, "..", "workspace", ".claude", "prompts"),
		];
		for (const c of candidates) {
			if (fsExistsSync(c)) return c;
		}
		return null;
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
		// Refresh in the background for the next open; don't block this render.
		void this.readTemplatesFromDisk().then((fresh) => (this.cachedTemplates = fresh));

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
