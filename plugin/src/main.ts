import type { WorkspaceLeaf } from "obsidian";
import { FileSystemAdapter, Menu, Modal, Notice, Plugin, debounce } from "obsidian";
import { existsSync as fsExistsSync } from "fs";
import { join as pathJoin } from "path";
import { BatchReviewModal, DiffReviewModal } from "./diff-review-modal";
import {
	type AgentSandboxSettings,
	DEFAULT_SETTINGS,
	AgentSandboxSettingTab,
	enabledTiersFromSettings,
} from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { FirewallStatusBar, StatusBarManager } from "./status-bar";
import type { ActivityPrefix } from "./terminal-view";
import { TerminalView, VIEW_TYPE_TERMINAL } from "./terminal-view";
import { isValidWriteDir } from "./validation";
import { ObsidianMcpServer, generateToken } from "./mcp-server";
import type { AgentStatus, PermissionTier } from "./mcp-tools";

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

import { parsePromptTemplate, substituteFilePlaceholder } from "./prompt-template";

const TOOLTIP_STOPPED = "Container is not running\nClick for options";
const HEALTH_POLL_INTERVAL = 30_000;
// Firewall can be toggled out-of-band (user runs init-firewall.sh in the
// container), so we refresh on user-visible events (hover, window focus) and
// keep this long safety-net poll to heal any missed transition.
const FIREWALL_REFRESH_INTERVAL = 5 * 60_000;
const FIREWALL_EVENT_THROTTLE = 10_000;

export default class AgentSandboxPlugin extends Plugin {
	settings: AgentSandboxSettings = { ...DEFAULT_SETTINGS };
	private docker!: DockerManager;
	private statusBar!: StatusBarManager;
	private firewallBar!: FirewallStatusBar;
	private statusBarEl: HTMLElement | null = null;
	private statusBarClickHandler: ((evt: MouseEvent) => void) | null = null;
	private healthPollId: number | null = null;
	private firewallPollId: number | null = null;
	private lastFirewallRefreshAt = 0;
	private mcpServer: ObsidianMcpServer | null = null;
	private lastKnownContainerId: string = "";

	private debouncedSaveSettings = debounce(
		async () => {
			await this.saveData(this.settings);
		},
		500,
		true,
	);

	async onload() {
		await this.loadSettings();
		this.addSettingTab(new AgentSandboxSettingTab(this.app, this));

		this.docker = new DockerManager(() => ({
			dockerMode: this.settings.dockerMode,
			composePath: this.settings.dockerComposeFilePath,
			wslDistro: this.settings.wslDistroName,
			vaultPath:
				this.app.vault.adapter instanceof FileSystemAdapter
					? this.app.vault.adapter.getBasePath()
					: undefined,
			writeDir: this.settings.vaultWriteDir,
			memoryFileName: this.settings.memoryFileName,
			ttydPort: this.settings.ttydPort,
			ttydBindAddress: this.settings.ttydBindAddress,
			allowedPrivateHosts: this.settings.allowedPrivateHosts,
			additionalFirewallDomains: this.settings.additionalFirewallDomains,
			containerMemory: this.settings.containerMemory,
			containerCpus: this.settings.containerCpus,
			sudoPassword: this.settings.sudoPassword,
			mcpToken: this.settings.mcpEnabled ? this.settings.mcpToken : undefined,
			mcpPort: this.settings.mcpEnabled ? this.settings.mcpPort : undefined,
		}));

		this.statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(this.statusBarEl);
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.statusBarClickHandler = (evt) => void this.showStatusMenu(evt);
		this.statusBarEl.addEventListener("click", this.statusBarClickHandler);

		const fwBarEl = this.addStatusBarItem();
		this.firewallBar = new FirewallStatusBar(fwBarEl, () => this.toggleFirewall());

		this.registerDomEvent(fwBarEl, "mouseenter", () => this.maybeRefreshFirewall());
		this.registerDomEvent(window, "focus", () => this.maybeRefreshFirewall());

		this.registerView(VIEW_TYPE_TERMINAL, (leaf: WorkspaceLeaf) => {
			const view = new TerminalView(leaf, () => ({
				ttydPort: this.settings.ttydPort,
				terminalTheme: this.settings.terminalTheme,
				terminalFont: this.settings.terminalFont,
				terminalFontSize: this.settings.terminalFontSize,
				terminalScrollback: this.settings.terminalScrollback,
				clipboardAutoCopy: this.settings.clipboardAutoCopy,
			}));
			view.onRenameSession = async () => {
				const oldName = (view.getState().sessionName as string) ?? "";
				const newName = await this.promptSessionName("Rename Session", oldName);
				if (!newName || newName === oldName) return;
				if (oldName) {
					try {
						await this.docker.renameSession(oldName, newName);
					} catch {
						new Notice("Failed to rename tmux session.");
						return;
					}
				}
				await leaf.setViewState({
					type: VIEW_TYPE_TERMINAL,
					state: { sessionName: newName },
				});
			};
			return view;
		});

		// Fast-fail (5s) probe keeps a missing WSL/Docker from blocking
		// vault load for the default 30s exec timeout.
		this.app.workspace.onLayoutReady(() => {
			void this.backgroundStartup();
		});

		this.addRibbonIcon("box", "Open Sandbox Terminal", () => {
			void this.openTerminalOrPromptStart();
		});

		this.addCommand({
			id: "open-claude-terminal",
			name: "Open Sandbox Terminal",
			callback: () => {
				void this.openTerminalOrPromptStart();
			},
		});

		this.addCommand({
			id: "sandbox-start-container",
			name: "Sandbox: Start Container",
			callback: () => this.startContainer(),
		});

		this.addCommand({
			id: "sandbox-stop-container",
			name: "Sandbox: Stop Container",
			callback: () => this.stopContainer(),
		});

		this.addCommand({
			id: "sandbox-container-status",
			name: "Sandbox: Container Status",
			callback: () => this.containerStatus(),
		});

		this.addCommand({
			id: "sandbox-restart-container",
			name: "Sandbox: Restart Container",
			callback: () => this.restartContainer(),
		});

		this.addCommand({
			id: "sandbox-toggle-firewall",
			name: "Sandbox: Toggle Firewall",
			callback: () => this.toggleFirewall(),
		});

		this.addCommand({
			id: "open-session",
			name: "Open Sandbox Session...",
			callback: async () => {
				const name = await this.promptSessionName("New Session");
				if (name) this.activateTerminalView(name);
			},
		});

		this.addCommand({
			id: "open-browser",
			name: "Open Sandbox in Browser",
			callback: () => {
				window.open(`http://localhost:${this.settings.ttydPort}`);
			},
		});

		this.addCommand({
			id: "sandbox-toggle-mcp",
			name: "Sandbox: Toggle MCP Server",
			callback: () => this.toggleMcpServer(),
		});

		this.addCommand({
			id: "sandbox-cleanup-sessions",
			name: "Sandbox: Clean up empty sessions",
			callback: () => void this.cleanupEmptySessions(),
		});

		// obsidian://agent-sandbox/open-terminal — activate or open a terminal tab
		this.registerObsidianProtocolHandler("agent-sandbox/open-terminal", async () => {
			if (!this.isContainerRunning()) {
				new Notice("Sandbox container is not running.");
				return;
			}
			await this.activateTerminalView();
		});

		// obsidian://agent-sandbox/analyze?path=<vault/path>&template=<name>
		this.registerObsidianProtocolHandler("agent-sandbox/analyze", async (params) => {
			const path = params.path;
			const templateName = params.template;
			if (!path) {
				new Notice("Analyze: missing 'path' parameter.");
				return;
			}
			await this.runAnalyze(path, templateName);
		});

		// File context menu → "Analyze in Sandbox" submenu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.settings.mcpEnabled) return;
				if (!("extension" in file)) return;
				menu.addItem((item) => {
					item.setTitle("Analyze in Sandbox").setIcon("bot");
					const submenu = (
						item as unknown as { setSubmenu?: () => { addItem: Menu["addItem"] } }
					).setSubmenu?.();
					const addTemplateItem = (
						target: { addItem: Menu["addItem"] },
						label: string,
						action: () => void,
					) => {
						target.addItem((sub) => sub.setTitle(label).onClick(action));
					};
					const container = submenu ?? menu;
					void this.loadPromptTemplates().then((templates) => {
						if (templates.length === 0) {
							addTemplateItem(
								container,
								"Custom prompt…",
								() => void this.runAnalyzeCustom(file.path),
							);
						} else {
							for (const t of templates) {
								addTemplateItem(
									container,
									t.label,
									() => void this.runAnalyze(file.path, t.name),
								);
							}
							addTemplateItem(
								container,
								"Custom prompt…",
								() => void this.runAnalyzeCustom(file.path),
							);
						}
					});
				});
			}),
		);

		if (this.settings.mcpEnabled) {
			void this.startMcpServer();
		}

		// Agent output sync — watch the vault write directory for new / modified
		// files and surface a non-intrusive Notice. Uses Obsidian's own vault
		// events so no node fs watcher is needed. Debounced to collapse bursts.
		this.registerEvent(
			this.app.vault.on("create", (file) => {
				if (!("extension" in file)) return;
				if (this.settings.agentOutputNotify === "off") return;
				if (!this.isInsideWriteDir(file.path)) return;
				this.queueAgentOutputNotice("created", file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => {
				if (this.settings.agentOutputNotify !== "new_or_modified") return;
				if (!this.isInsideWriteDir(file.path)) return;
				this.queueAgentOutputNotice("modified", file.path);
			}),
		);

		// Quick-Switcher-style picker for open sandbox sessions
		this.addCommand({
			id: "sandbox-switch-session",
			name: "Sandbox: Switch to Sandbox session…",
			callback: () => this.showSessionPicker(),
		});

		// Stop container on app quit (onunload only fires on plugin disable, not app exit)
		this.registerEvent(
			this.app.workspace.on("quit", (tasks) => {
				if (this.settings.autoStopContainer) {
					tasks.add(async () => {
						if (this.docker.isBusy()) {
							this.docker.stopDetached();
							return;
						}
						await Promise.race([
							this.docker.stop().catch(() => {}),
							new Promise((r) => setTimeout(r, 5000)),
						]);
					});
				}
			}),
		);
	}

	onunload() {
		this.stopHealthPoll();
		if (this.agentOutputDebounceId != null) {
			window.clearTimeout(this.agentOutputDebounceId);
			this.agentOutputDebounceId = null;
		}
		void this.mcpServer?.stop();
		void this.saveData(this.settings);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		this.firewallBar.destroy();
		if (this.statusBarEl && this.statusBarClickHandler) {
			this.statusBarEl.removeEventListener("click", this.statusBarClickHandler);
		}

		this.docker.stopDetached();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.mcpToken) {
			this.settings.mcpToken = generateToken();
			await this.saveData(this.settings);
		}
	}

	saveSettings() {
		this.debouncedSaveSettings();
	}

	isContainerRunning(): boolean {
		return this.statusBar.getState() === "running";
	}

	async firewallSources(): Promise<string> {
		return this.docker.firewallSources();
	}

	private async openTerminalOrPromptStart(): Promise<void> {
		if (this.isContainerRunning()) {
			await this.activateTerminalView();
			return;
		}
		const confirmed = await this.promptConfirm(
			"Start Container?",
			"The container is not running. Start it now?",
		);
		if (!confirmed) return;
		await this.startContainer();
		if (this.isContainerRunning()) {
			await this.activateTerminalView();
		}
	}

	private promptConfirm(title: string, message: string): Promise<boolean> {
		return new Promise((resolve) => {
			const modal = new Modal(this.app);
			modal.titleEl.setText(title);
			modal.contentEl.createEl("p", { text: message });
			modal.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
				div.createEl("button", { text: "Cancel", cls: "mod-muted" }, (btn) => {
					btn.addEventListener("click", () => {
						modal.close();
						resolve(false);
					});
				});
				div.createEl("button", { text: "Start", cls: "mod-cta" }, (btn) => {
					btn.addEventListener("click", () => {
						modal.close();
						resolve(true);
					});
				});
			});
			modal.onClose = () => resolve(false);
			modal.open();
		});
	}

	async activateTerminalView(
		sessionName?: string,
		initialPrompt?: string,
	): Promise<TerminalView | null> {
		const leaf = this.app.workspace.getLeaf("tab");
		await leaf.setViewState({
			type: VIEW_TYPE_TERMINAL,
			active: true,
			state: sessionName ? { sessionName } : {},
		});
		this.app.workspace.revealLeaf(leaf);
		const view = leaf.view instanceof TerminalView ? leaf.view : null;
		if (view && initialPrompt) view.queueInitialPrompt(initialPrompt);
		return view;
	}

	/**
	 * Load prompt templates from `workspace/.claude/prompts/*.md` (relative
	 * to this plugin's host-side location). Each file's first non-empty line
	 * before the `---` separator is the display label; the rest of the body
	 * is the prompt text with `{{file}}` as the file-path placeholder.
	 */
	async loadPromptTemplates(): Promise<{ name: string; label: string; body: string }[]> {
		const dir = this.resolvePromptsDir();
		if (!dir) return [];
		try {
			const fs = await import("fs/promises");
			const entries = await fs.readdir(dir).catch(() => [] as string[]);
			const out: { name: string; label: string; body: string }[] = [];
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
		if (!(this.app.vault.adapter instanceof FileSystemAdapter)) return null;
		// The prompts dir lives in the sandbox's workspace tree. Look for a
		// sibling `workspace/.claude/prompts` starting from the vault base
		// (matches the repo layout). Users without the repo layout can drop
		// templates in `<vault>/.claude/prompts/` as a fallback.
		const base = this.app.vault.adapter.getBasePath();
		const candidates = [
			pathJoin(base, ".claude", "prompts"),
			pathJoin(base, "..", "workspace", ".claude", "prompts"),
		];
		for (const c of candidates) {
			if (fsExistsSync(c)) return c;
		}
		return null;
	}

	async runAnalyze(vaultPath: string, templateName?: string): Promise<void> {
		if (!this.isContainerRunning()) {
			new Notice("Sandbox container is not running.");
			return;
		}
		const prompt = await this.buildPromptFromTemplate(vaultPath, templateName);
		if (!prompt) return;
		await this.activateTerminalView(undefined, prompt);
	}

	private async runAnalyzeCustom(vaultPath: string): Promise<void> {
		if (!this.isContainerRunning()) {
			new Notice("Sandbox container is not running.");
			return;
		}
		const modal = new Modal(this.app);
		modal.titleEl.setText("Analyze in Sandbox");
		modal.contentEl.createEl("p", {
			text: `Prompt for ${vaultPath} — @${vaultPath} will be appended automatically.`,
		});
		const input = modal.contentEl.createEl("textarea", {
			cls: "sandbox-modal-input-multiline",
		});
		input.placeholder = "e.g. Summarize this note in 3 bullet points";
		modal.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
			div.createEl("button", { text: "Cancel", cls: "mod-muted" }, (btn) => {
				btn.addEventListener("click", () => modal.close());
			});
			div.createEl("button", { text: "Run", cls: "mod-cta" }, (btn) => {
				btn.addEventListener("click", async () => {
					const body = input.value.trim();
					modal.close();
					if (!body) return;
					const prompt = `${body}\n\n(Context: @${vaultPath})`;
					await this.activateTerminalView(undefined, prompt);
				});
			});
		});
		modal.open();
		input.focus();
	}

	private async buildPromptFromTemplate(
		vaultPath: string,
		templateName?: string,
	): Promise<string | null> {
		if (!templateName) {
			return `Please analyze @${vaultPath}.`;
		}
		const templates = await this.loadPromptTemplates();
		const tmpl = templates.find((t) => t.name === templateName);
		if (!tmpl) {
			new Notice(`Unknown prompt template: ${templateName}`);
			return null;
		}
		return substituteFilePlaceholder(tmpl.body, vaultPath);
	}

	// ── Container actions ──────────────────────────────────

	private async startContainer(): Promise<void> {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		const conflicts = await this.checkStartupPortConflicts();
		if (conflicts.length > 0) {
			new Notice(
				`Port conflict: ${conflicts.join(", ")} already in use on 127.0.0.1. Stop the other process or change the port in settings.`,
				10000,
			);
			return;
		}
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: async () => {
				await this.ensureWriteDir();
				return this.docker.start();
			},
			postState: "running",
			successMsg: "Sandbox container started.",
			failurePrefix: "Failed to start container",
		});
		if (ok) {
			this.lastKnownContainerId = await this.docker.getContainerId();
			await this.applyFirewallAfterStart();
			this.startHealthPoll();
		}
	}

	private async stopContainer(): Promise<void> {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		await this.runDockerCommand({
			action: () => this.docker.stop(),
			postState: "stopped",
			successMsg: "Sandbox container stopped.",
			failurePrefix: "Failed to stop container",
		});
		this.firewallBar.setState("hidden");
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.stopHealthPoll();
		this.lastKnownContainerId = "";
	}

	async restartContainer(): Promise<void> {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: () => this.docker.restart(),
			postState: "running",
			successMsg: "Sandbox container restarted.",
			failurePrefix: "Failed to restart container",
		});
		if (ok) {
			this.lastKnownContainerId = await this.docker.getContainerId();
			await this.applyFirewallAfterStart();
			this.startHealthPoll();
		}
	}

	private async applyFirewallAfterStart(): Promise<void> {
		if (this.settings.autoEnableFirewall) {
			try {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
			} catch (error: unknown) {
				this.firewallBar.setState("disabled");
				new Notice(
					`Auto-enable firewall failed: ${toErrorMessage(error)}. You can enable it manually from the status bar.`,
				);
			}
		} else {
			await this.refreshFirewallStatus();
		}
		this.updateTooltip();
	}

	// ── Firewall ───────────────────────────────────────────

	private async toggleFirewall(): Promise<void> {
		if (this.firewallBar.getState() === "hidden") {
			new Notice("Container is not running. Start it first.");
			return;
		}
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return;
		}
		try {
			if (this.firewallBar.getState() === "enabled") {
				await this.docker.disableFirewall();
				this.firewallBar.setState("disabled");
				new Notice("Firewall disabled.");
			} else {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
				new Notice("Firewall enabled.");
			}
			this.updateTooltip();
		} catch (error: unknown) {
			new Notice(`Firewall toggle failed: ${toErrorMessage(error)}`);
		}
	}

	private async refreshFirewallStatus(): Promise<void> {
		try {
			const fwOn = await this.docker.firewallStatus();
			this.firewallBar.setState(fwOn ? "enabled" : "disabled");
		} catch {
			this.firewallBar.setState("hidden");
		}
		this.lastFirewallRefreshAt = Date.now();
	}

	/** Event-driven refresh — rate-limited to avoid exec spam on rapid focus/hover. */
	private maybeRefreshFirewall(): void {
		if (this.firewallBar.getState() === "hidden") return;
		if (Date.now() - this.lastFirewallRefreshAt < FIREWALL_EVENT_THROTTLE) return;
		void this.refreshFirewallStatus();
	}

	// ── MCP server ────────────────────────────────────────

	private getEnabledTiers(): Set<PermissionTier> {
		return enabledTiersFromSettings(this.settings);
	}

	async restartMcpIfRunning(): Promise<void> {
		if (!this.mcpServer?.isRunning()) return;
		await this.stopMcpServer();
		await this.startMcpServer();
	}

	private async startMcpServer(): Promise<void> {
		if (this.mcpServer?.isRunning()) return;
		try {
			const allowlist = this.settings.mcpPathAllowlist
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			const blocklist = this.settings.mcpPathBlocklist
				.split(",")
				.map((s) => s.trim())
				.filter(Boolean);
			this.mcpServer = new ObsidianMcpServer(this.app, {
				port: this.settings.mcpPort,
				token: this.settings.mcpToken,
				enabledTiers: this.getEnabledTiers(),
				getWriteDir: () => this.settings.vaultWriteDir,
				pathFilter:
					allowlist.length > 0 || blocklist.length > 0
						? { allowlist, blocklist }
						: undefined,
				hooks: {
					review: this.settings.mcpTierWriteReviewed
						? async (req) => new DiffReviewModal(this.app, req).review()
						: undefined,
					reviewBatch: this.settings.mcpTierWriteReviewed
						? async (req) => new BatchReviewModal(this.app, req).review()
						: undefined,
					onActivity: (update) => this.onAgentActivity(update),
				},
			});
			await this.mcpServer.start();
		} catch (error: unknown) {
			new Notice(`MCP server failed to start: ${toErrorMessage(error)}`);
		}
	}

	private async stopMcpServer(): Promise<void> {
		if (!this.mcpServer) return;
		await this.mcpServer.stop();
		this.mcpServer = null;
		this.clearAgentActivity();
	}

	private onAgentActivity(update: {
		sessionName: string;
		status: AgentStatus;
		detail?: string;
	}): void {
		const prefix: ActivityPrefix =
			update.status === "working"
				? "working"
				: update.status === "awaiting_input"
					? "awaiting_input"
					: null;

		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			const view = leaf.view as TerminalView;
			const sessionKey = view.getSessionName() ?? "__default__";
			if (sessionKey === update.sessionName) {
				view.setActivityPrefix(prefix);
			}
		}

		this.updateAttentionBadge();
	}

	private updateAttentionBadge(): void {
		const activity = this.mcpServer?.getActivity();
		if (!activity) {
			this.statusBar.setAttentionCount(0);
			return;
		}
		let count = 0;
		const waitingNames: string[] = [];
		for (const [name, entry] of activity) {
			if (entry.status === "awaiting_input") {
				count++;
				waitingNames.push(name === "__default__" ? "(unnamed)" : name);
			}
		}
		this.statusBar.setAttentionCount(count);
		if (count > 0 && this.statusBar.getState() === "running") {
			this.statusBar.setDetails(
				`Sandbox running. ${count} session(s) awaiting input: ${waitingNames.join(", ")}\nClick for options`,
			);
		}
	}

	private clearAgentActivity(): void {
		this.statusBar.setAttentionCount(0);
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL)) {
			(leaf.view as TerminalView).setActivityPrefix(null);
		}
	}

	private async toggleMcpServer(): Promise<void> {
		if (this.mcpServer?.isRunning()) {
			await this.stopMcpServer();
			this.settings.mcpEnabled = false;
			this.saveSettings();
			new Notice("MCP server stopped.");
		} else {
			this.settings.mcpEnabled = true;
			this.saveSettings();
			await this.startMcpServer();
			if (this.mcpServer?.isRunning()) {
				new Notice(`MCP server listening on port ${this.settings.mcpPort}.`);
			}
		}
	}

	// ── Status bar menu ────────────────────────────────────

	private async showStatusMenu(evt: MouseEvent): Promise<void> {
		const menu = new Menu();
		const busy = this.docker.isBusy();
		const running = this.statusBar.getState() === "running";

		menu.addItem((item) =>
			item
				.setTitle("Start Container")
				.setIcon("play")
				.setDisabled(busy)
				.onClick(() => this.startContainer()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Stop Container")
				.setIcon("square")
				.setDisabled(busy || !running)
				.onClick(() => this.stopContainer()),
		);
		menu.addItem((item) =>
			item
				.setTitle("Restart Container")
				.setIcon("refresh-cw")
				.setDisabled(busy || !running)
				.onClick(() => this.restartContainer()),
		);
		menu.addSeparator();

		const fwEnabled = this.firewallBar.getState() === "enabled";
		menu.addItem((item) =>
			item
				.setTitle(fwEnabled ? "Disable Firewall" : "Enable Firewall")
				.setIcon("shield")
				.setDisabled(busy || !running)
				.onClick(() => this.toggleFirewall()),
		);

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("New Terminal")
				.setIcon("terminal")
				.setDisabled(!running)
				.onClick(() => this.activateTerminalView()),
		);
		menu.addItem((item) =>
			item
				.setTitle("New Session...")
				.setIcon("plus")
				.setDisabled(!running)
				.onClick(async () => {
					const name = await this.promptSessionName("New Session");
					if (name) this.activateTerminalView(name);
				}),
		);

		if (running) {
			const sessions = await this.docker.listSessions();
			for (const name of sessions) {
				menu.addItem((item) =>
					item
						.setTitle(`Attach: ${name}`)
						.setIcon("arrow-right")
						.onClick(() => this.activateTerminalView(name)),
				);
			}
		}

		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle("Open in Browser")
				.setIcon("external-link")
				.setDisabled(!running)
				.onClick(() => window.open(`http://localhost:${this.settings.ttydPort}`)),
		);
		menu.addItem((item) =>
			item
				.setTitle("Check Status")
				.setIcon("activity")
				.onClick(() => this.containerStatus()),
		);

		menu.showAtMouseEvent(evt);
	}

	// ── Tooltip ────────────────────────────────────────────

	private updateTooltip(): void {
		const fwState = this.firewallBar.getState();
		const fwLabel =
			fwState === "enabled" ? "enabled" : fwState === "disabled" ? "disabled" : "n/a";
		const mcpRunning = this.mcpServer?.isRunning() ?? false;
		const mcpLabel = mcpRunning
			? `port ${this.settings.mcpPort}, ${this.mcpServer!.getToolCount()} tools`
			: "off";
		const lines = [
			"Container: running",
			`Port: ${this.settings.ttydPort}`,
			`Firewall: ${fwLabel}`,
			`MCP: ${mcpLabel}`,
			"",
			"Click for options",
		];
		this.statusBar.setDetails(lines.join("\n"));
	}

	// ── Background startup ────────────────────────────

	private async backgroundStartup(): Promise<void> {
		this.statusBar.setState("checking");
		this.statusBar.setDetails("Starting: checking Docker availability…");

		try {
			this.statusBar.setDetails("Starting: probing WSL (5s fast-fail)…");
			await this.docker.ensureWslReady();
		} catch (error: unknown) {
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`WSL error: ${msg}\nClick for options`);
			new Notice(`Sandbox: ${msg}`);
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			return;
		}

		try {
			this.statusBar.setDetails("Starting: probing container status…");
			const output = await this.docker.probeStatus();
			const isRunning = DockerManager.parseIsRunning(output);
			if (!isRunning) {
				this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			}
			await this.syncStatusBar(isRunning);

			if (this.settings.autoStartContainer && !isRunning) {
				this.statusBar.setDetails("Starting: docker compose up -d (auto-start)…");
				await this.startContainer();
			}

			this.startHealthPoll();
		} catch (error: unknown) {
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`Docker error: ${msg}\nClick for options`);
			new Notice(`Sandbox: ${msg}`);
		}
	}

	// ── Health poll ───────────────────────────────────

	private startHealthPoll(): void {
		this.stopHealthPoll();
		this.healthPollId = this.registerInterval(
			window.setInterval(() => void this.healthCheck(), HEALTH_POLL_INTERVAL),
		);
		this.startFirewallPoll();
	}

	private stopHealthPoll(): void {
		if (this.healthPollId != null) {
			window.clearInterval(this.healthPollId);
			this.healthPollId = null;
		}
		this.stopFirewallPoll();
	}

	private async healthCheck(): Promise<void> {
		if (this.docker.isBusy()) return;
		try {
			const output = await this.docker.probeStatus();
			const isRunning = DockerManager.parseIsRunning(output);
			await this.syncStatusBar(isRunning);
			if (isRunning) await this.checkContainerIdDrift();
		} catch (error: unknown) {
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`Docker error: ${msg}\nClick for options`);
			this.stopHealthPoll();
		}
	}

	private isInsideWriteDir(path: string): boolean {
		const dir = this.settings.vaultWriteDir || "agent-workspace";
		return path === dir || path.startsWith(dir + "/");
	}

	private agentOutputBuffer: { kind: "created" | "modified"; path: string }[] = [];
	private agentOutputDebounceId: number | null = null;
	private lastAgentOutputNoticeAt = 0;

	private queueAgentOutputNotice(kind: "created" | "modified", path: string): void {
		this.agentOutputBuffer.push({ kind, path });
		if (this.agentOutputDebounceId != null) return;
		this.agentOutputDebounceId = window.setTimeout(() => {
			this.agentOutputDebounceId = null;
			this.flushAgentOutputNotices();
		}, 2000);
	}

	private flushAgentOutputNotices(): void {
		const buf = this.agentOutputBuffer;
		this.agentOutputBuffer = [];
		if (buf.length === 0) return;
		const now = Date.now();
		if (now - this.lastAgentOutputNoticeAt < 5000) return;
		this.lastAgentOutputNoticeAt = now;
		if (buf.length === 1) {
			const { kind, path } = buf[0];
			new Notice(`Agent ${kind} ${path}`, 5000);
		} else {
			const createdCount = buf.filter((e) => e.kind === "created").length;
			const modifiedCount = buf.length - createdCount;
			const parts: string[] = [];
			if (createdCount > 0) parts.push(`${createdCount} created`);
			if (modifiedCount > 0) parts.push(`${modifiedCount} modified`);
			new Notice(`Agent output: ${parts.join(", ")}`, 5000);
		}
	}

	private showSessionPicker(): void {
		const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_TERMINAL);
		if (leaves.length === 0) {
			new Notice("No open sandbox terminals.");
			return;
		}
		const modal = new Modal(this.app);
		modal.titleEl.setText("Switch to Sandbox session");
		const input = modal.contentEl.createEl("input", {
			type: "text",
			cls: "sandbox-modal-filter",
		}) as HTMLInputElement;
		input.placeholder = "Filter sessions…";
		const list = modal.contentEl.createEl("div", { cls: "sandbox-modal-list" });

		const render = (filter: string) => {
			list.empty();
			const needle = filter.toLowerCase().trim();
			for (const leaf of leaves) {
				const view = leaf.view as TerminalView;
				const name = view.getSessionName() ?? "(unnamed)";
				const label = `Session: ${name}`;
				if (needle && !label.toLowerCase().includes(needle)) continue;
				const row = list.createEl("div", { cls: "sandbox-modal-row-clickable" });
				row.setText(label);
				row.addEventListener("click", () => {
					modal.close();
					this.app.workspace.setActiveLeaf(leaf, { focus: true });
					this.app.workspace.revealLeaf(leaf);
				});
			}
		};
		render("");
		input.addEventListener("input", () => render(input.value));
		modal.open();
		input.focus();
	}

	private async checkStartupPortConflicts(): Promise<number[]> {
		const ports = [this.settings.ttydPort];
		if (this.settings.mcpEnabled) ports.push(this.settings.mcpPort);
		return this.docker.checkPortConflicts(ports, this.settings.ttydBindAddress || "127.0.0.1");
	}

	private async checkContainerIdDrift(): Promise<void> {
		const current = await this.docker.getContainerId();
		if (!current) return;
		if (!this.lastKnownContainerId) {
			this.lastKnownContainerId = current;
			return;
		}
		if (current !== this.lastKnownContainerId) {
			new Notice(
				"Sandbox container was recreated outside the plugin. Terminal sessions may be disconnected; reopen to reconnect.",
			);
			this.lastKnownContainerId = current;
			this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		}
	}

	// ── Session prompt ─────────────────────────────────────

	private promptSessionName(title: string, defaultValue = ""): Promise<string | null> {
		return new Promise((resolve) => {
			let resolved = false;
			const modal = new Modal(this.app);
			modal.titleEl.setText(title);
			const input = modal.contentEl.createEl("input", {
				type: "text",
				placeholder: "e.g. work, research, debug",
				value: defaultValue,
			});
			input.addClass("sandbox-modal-input-full");
			input.addEventListener("keydown", (e) => {
				if (e.key === "Enter") {
					const val = input.value.trim();
					resolved = true;
					modal.close();
					resolve(val || null);
				}
				if (e.key === "Escape") {
					resolved = true;
					modal.close();
					resolve(null);
				}
			});
			modal.onClose = () => {
				if (!resolved) resolve(null);
			};
			modal.open();
			input.focus();
		});
	}

	// ── Helpers ────────────────────────────────────────────

	private async ensureWriteDir(): Promise<void> {
		const dir = this.settings.vaultWriteDir;
		if (!dir) return;
		if (!isValidWriteDir(dir)) {
			throw new Error("Invalid vault write directory.");
		}
		try {
			await this.app.vault.createFolder(dir);
		} catch (error: unknown) {
			const msg = toErrorMessage(error).toLowerCase();
			if (!msg.includes("exist")) throw error;
		}
	}

	private async runDockerCommand(opts: {
		preState?: ContainerState;
		action: () => Promise<string>;
		postState: ContainerState;
		successMsg: string;
		failurePrefix: string;
	}): Promise<boolean> {
		try {
			if (opts.preState) {
				this.statusBar.setState(opts.preState);
				this.statusBar.setDetails("Container is starting up...");
			}
			await opts.action();
			this.statusBar.setState(opts.postState);
			new Notice(opts.successMsg);
			return true;
		} catch (error: unknown) {
			this.statusBar.setState("error");
			const msg = toErrorMessage(error);
			this.statusBar.setDetails(`Container error: ${msg}\nClick for options`);
			new Notice(`${opts.failurePrefix}: ${msg}`);
			return false;
		}
	}

	private async cleanupEmptySessions(): Promise<void> {
		if (!this.isContainerRunning()) {
			new Notice("Sandbox container is not running.");
			return;
		}
		const candidates = await this.docker.listEmptySessions();
		if (candidates.length === 0) {
			new Notice("No empty tmux sessions to clean up.");
			return;
		}
		const modal = new Modal(this.app);
		modal.titleEl.setText("Clean up empty sessions");
		modal.contentEl.createEl("p", {
			text: `${candidates.length} session(s) have no attached clients. Kill the selected ones?`,
		});
		const selected = new Set(candidates);
		const list = modal.contentEl.createEl("ul", { cls: "sandbox-modal-check-list" });
		for (const name of candidates) {
			const row = list.createEl("li", { cls: "sandbox-modal-check-row" });
			const cb = row.createEl("input", { type: "checkbox" }) as HTMLInputElement;
			cb.checked = true;
			cb.addEventListener("change", () => {
				if (cb.checked) selected.add(name);
				else selected.delete(name);
			});
			row.createEl("span", { text: name });
		}
		modal.contentEl.createDiv({ cls: "modal-button-container" }, (div) => {
			div.createEl("button", { text: "Cancel", cls: "mod-muted" }, (btn) => {
				btn.addEventListener("click", () => modal.close());
			});
			div.createEl("button", { text: "Kill selected", cls: "mod-cta" }, (btn) => {
				btn.addEventListener("click", async () => {
					modal.close();
					const toKill = [...selected];
					let killed = 0;
					for (const name of toKill) {
						try {
							await this.docker.killSession(name);
							killed++;
						} catch {
							// swallow; report aggregate
						}
					}
					new Notice(`Killed ${killed}/${toKill.length} session(s).`);
				});
			});
		});
		modal.open();
	}

	private async containerStatus(): Promise<void> {
		try {
			const output = await this.docker.status();
			const isRunning = DockerManager.parseIsRunning(output);
			await this.syncStatusBar(isRunning);
			new Notice(isRunning ? "Container is running" : "Container is stopped");
			this.startHealthPoll();
		} catch (error: unknown) {
			this.statusBar.setState("error");
			new Notice(`Failed to get status: ${toErrorMessage(error)}`);
		}
	}

	private async syncStatusBar(isRunning: boolean): Promise<void> {
		const wasRunning = this.statusBar.getState() === "running";
		this.statusBar.setState(isRunning ? "running" : "stopped");
		if (isRunning) {
			if (!wasRunning) await this.refreshFirewallStatus();
			this.updateTooltip();
		} else {
			this.firewallBar.setState("hidden");
			this.statusBar.setDetails(TOOLTIP_STOPPED);
			this.stopFirewallPoll();
		}
	}

	private startFirewallPoll(): void {
		this.stopFirewallPoll();
		this.firewallPollId = this.registerInterval(
			window.setInterval(() => {
				if (this.firewallBar.getState() !== "hidden") void this.refreshFirewallStatus();
			}, FIREWALL_REFRESH_INTERVAL),
		);
	}

	private stopFirewallPoll(): void {
		if (this.firewallPollId != null) {
			window.clearInterval(this.firewallPollId);
			this.firewallPollId = null;
		}
	}
}
