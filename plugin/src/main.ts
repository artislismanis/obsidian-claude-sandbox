import type { TFile, WorkspaceLeaf } from "obsidian";
import { Menu, Notice, Plugin, debounce } from "obsidian";
import { getVaultBasePath } from "./obsidian-internals";
import { confirmModal, inputModal } from "./modals";
import { BatchReviewModal, DiffReviewModal } from "./diff-review-modal";
import { AnalyzeManager } from "./analyze";
import {
	type AgentSandboxSettings,
	DEFAULT_SETTINGS,
	AgentSandboxSettingTab,
	enabledTiersFromSettings,
} from "./settings";
import { DockerManager } from "./docker";
import type { ContainerState } from "./status-bar";
import { FirewallStatusBar, StatusBarManager } from "./status-bar";
import {
	TerminalView,
	VIEW_TYPE_TERMINAL,
	formatConnectionLog,
	getTerminalConnectionLog,
} from "./terminal-view";
import { isValidWriteDir, splitCsv } from "./validation";
import { setLogLevel, logger, errMsg } from "./logger";
import { ObsidianMcpServer, generateToken } from "./mcp-server";
import { reviewsRequired } from "./permission-tiers";
import { ActivityUi, AgentOutputNotifier } from "./activity";
import { showSessionCleanup, showSessionPicker } from "./session-ui";

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
	private healthPollId: number | null = null;
	private firewallPollId: number | null = null;
	private lastFirewallRefreshAt = 0;
	private mcpServer: ObsidianMcpServer | null = null;
	private lastKnownContainerId: string = "";
	private activityUi!: ActivityUi;
	private agentOutput!: AgentOutputNotifier;
	private analyze!: AnalyzeManager;

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
			vaultPath: getVaultBasePath(this.app) ?? undefined,
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

		const statusBarEl = this.addStatusBarItem();
		this.statusBar = new StatusBarManager(statusBarEl);
		this.statusBar.setDetails(TOOLTIP_STOPPED);
		this.registerDomEvent(statusBarEl, "click", (evt) => void this.showStatusMenu(evt));

		this.activityUi = new ActivityUi(this.app, this.statusBar, () =>
			this.mcpServer?.getActivity(),
		);
		this.agentOutput = new AgentOutputNotifier(
			() => this.settings.agentOutputNotify,
			() => this.settings.vaultWriteDir,
		);
		this.analyze = new AnalyzeManager({
			app: this.app,
			isContainerRunning: () => this.isContainerRunning(),
			activateTerminalView: (sessionName, initialPrompt) =>
				this.activateTerminalView(sessionName, initialPrompt),
		});
		void this.analyze.prewarm();

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
			id: "sandbox-copy-terminal-connection-log",
			name: "Sandbox: Copy terminal connection log",
			callback: async () => {
				const events = getTerminalConnectionLog();
				if (events.length === 0) {
					new Notice("No terminal connection events recorded yet.");
					return;
				}
				const text = formatConnectionLog(events);
				await navigator.clipboard.writeText(text);
				logger.info("Terminal", `Connection log (${events.length} events):\n${text}`);
				new Notice(`Copied ${events.length} terminal connection events to clipboard.`);
			},
		});

		this.addCommand({
			id: "sandbox-cleanup-sessions",
			name: "Sandbox: Clean up empty sessions",
			callback: () =>
				void showSessionCleanup(
					this.app,
					{
						listEmptySessions: () => this.docker.listEmptySessions(),
						killSession: (name) => this.docker.killSession(name),
					},
					() => this.isContainerRunning(),
				),
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
			if (!path) {
				new Notice("Analyze: missing 'path' parameter.");
				return;
			}
			await this.analyze.runAnalyze(path, params.template);
		});

		// File context menu → "Analyze in Sandbox" submenu
		this.registerEvent(
			this.app.workspace.on("file-menu", (menu, file) => {
				if (!this.settings.mcpEnabled) return;
				if (!("extension" in file)) return;
				this.analyze.attachFileMenu(menu, file as TFile);
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
				this.agentOutput.onCreate(file.path);
			}),
		);
		this.registerEvent(
			this.app.vault.on("modify", (file) => this.agentOutput.onModify(file.path)),
		);

		// Quick-Switcher-style picker for open sandbox sessions
		this.addCommand({
			id: "sandbox-switch-session",
			name: "Sandbox: Switch to Sandbox session…",
			callback: () => showSessionPicker(this.app),
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
		this.agentOutput?.dispose();
		void this.mcpServer?.stop();
		// Cancel any pending debounced save so the explicit one below isn't
		// overwritten by a stale trailing call.
		this.debouncedSaveSettings.cancel?.();
		void this.saveData(this.settings);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_TERMINAL);
		this.firewallBar.destroy();

		this.docker.stopDetached();
	}

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
		if (!this.settings.mcpToken) {
			this.settings.mcpToken = generateToken();
			await this.saveData(this.settings);
		}
		setLogLevel(this.settings.logLevel);
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
		const confirmed = await confirmModal(this.app, {
			title: "Start Container?",
			message: "The container is not running. Start it now?",
			ctaLabel: "Start",
		});
		if (!confirmed) return;
		logger.info("Plugin", "Auto-starting container from terminal prompt");
		await this.startContainer();
		if (this.isContainerRunning()) {
			logger.info("Plugin", "Container started — opening terminal");
			await this.activateTerminalView();
		} else {
			logger.warn("Plugin", "Container not running after startContainer — skipping terminal");
		}
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

	// ── Container actions ──────────────────────────────────

	private guardBusy(): boolean {
		if (this.docker.isBusy()) {
			new Notice("Another container operation is in progress.");
			return true;
		}
		return false;
	}

	private async startContainer(): Promise<void> {
		if (this.guardBusy()) return;
		let conflicts = await this.checkStartupPortConflicts();
		if (conflicts.length > 0) {
			// A previous `docker compose down` started by plugin disable may still
			// be tearing the container down — it no longer reports as "running"
			// but its host port mapping is still held. Treat any compose-managed
			// container (running or not) as ours and run `down` to finish cleanup.
			const stale = await this.docker.probeStatus();
			const isRunning = DockerManager.parseIsRunning(stale);
			const hasContainer = isRunning || (await this.docker.hasAnyContainer());
			if (hasContainer) {
				logger.info(
					"Plugin",
					`Port conflict from ${isRunning ? "running" : "half-stopped"} sandbox container — running compose down before retry`,
				);
				// Show the hourglass during cleanup so the status bar reflects
				// the in-progress work rather than staying on "Stopped" while
				// the toast disappears.
				this.statusBar.setState("starting");
				this.statusBar.setDetails(
					"Waiting for previous container to shut down before starting...",
				);
				new Notice("Cleaning up previous sandbox container...");
				try {
					await this.docker.stop();
				} catch (error: unknown) {
					logger.warn(
						"Plugin",
						"compose down during port-conflict recovery failed",
						error,
					);
				}
				conflicts = await this.checkStartupPortConflicts();
				if (conflicts.length > 0) {
					this.statusBar.setState("stopped");
					this.statusBar.setDetails(TOOLTIP_STOPPED);
				}
			}
			if (conflicts.length > 0) {
				new Notice(
					`Port conflict: ${conflicts.join(", ")} already in use on 127.0.0.1. Stop the other process or change the port in settings.`,
					10000,
				);
				return;
			}
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
		if (ok) await this.postStartTasks();
	}

	private async postStartTasks(): Promise<void> {
		this.lastKnownContainerId = await this.docker.getContainerId();
		await this.applyFirewallAfterStart();
		this.startHealthPoll();
	}

	private async stopContainer(): Promise<void> {
		if (this.guardBusy()) return;
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
		if (this.guardBusy()) return;
		const ok = await this.runDockerCommand({
			preState: "starting",
			action: () => this.docker.restart(),
			postState: "running",
			successMsg: "Sandbox container restarted.",
			failurePrefix: "Failed to restart container",
		});
		if (ok) await this.postStartTasks();
	}

	private async applyFirewallAfterStart(): Promise<void> {
		if (this.settings.autoEnableFirewall) {
			try {
				await this.docker.enableFirewall();
				this.firewallBar.setState("enabled");
			} catch (error: unknown) {
				this.firewallBar.setState("disabled");
				new Notice(
					`Auto-enable firewall failed: ${errMsg(error)}. You can enable it manually from the status bar.`,
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
		if (this.guardBusy()) return;
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
			new Notice(`Firewall toggle failed: ${errMsg(error)}`);
		}
	}

	private async refreshFirewallStatus(): Promise<void> {
		const status = await this.docker.firewallStatus();
		this.firewallBar.setState(status === "unavailable" ? "hidden" : status);
		this.lastFirewallRefreshAt = Date.now();
	}

	/** Event-driven refresh — rate-limited to avoid exec spam on rapid focus/hover. */
	private maybeRefreshFirewall(): void {
		if (this.firewallBar.getState() === "hidden") return;
		if (Date.now() - this.lastFirewallRefreshAt < FIREWALL_EVENT_THROTTLE) return;
		void this.refreshFirewallStatus();
	}

	// ── MCP server ────────────────────────────────────────

	// Serialise MCP lifecycle ops so a rapid toggle/restart sequence can't
	// leave a dangling server (start firing while a prior stop is still
	// shutting down, or a restart racing against a toggle).
	private mcpQueue: Promise<void> = Promise.resolve();
	private async queueMcpOp(op: () => Promise<void>): Promise<void> {
		const next = this.mcpQueue.then(op, op);
		this.mcpQueue = next;
		return next;
	}

	async restartMcpIfRunning(): Promise<void> {
		await this.queueMcpOp(async () => {
			if (!this.mcpServer?.isRunning()) return;
			await this.stopMcpServer();
			await this.startMcpServer();
		});
	}

	/** Apply a new mcpEnabled value to the running server (start or stop). */
	async applyMcpEnabled(enabled: boolean): Promise<void> {
		await this.queueMcpOp(async () => {
			if (enabled && !this.mcpServer?.isRunning()) {
				await this.startMcpServer();
			} else if (!enabled && this.mcpServer?.isRunning()) {
				await this.stopMcpServer();
			}
		});
	}

	private async startMcpServer(): Promise<void> {
		if (this.mcpServer?.isRunning()) return;
		try {
			const allowlist = splitCsv(this.settings.mcpPathAllowlist);
			const blocklist = splitCsv(this.settings.mcpPathBlocklist);
			this.mcpServer = new ObsidianMcpServer(this.app, {
				port: this.settings.mcpPort,
				token: this.settings.mcpToken,
				enabledTiers: enabledTiersFromSettings(this.settings),
				getWriteDir: () => this.settings.vaultWriteDir,
				pathFilter:
					allowlist.length > 0 || blocklist.length > 0
						? { allowlist, blocklist }
						: undefined,
				hooks: {
					review: reviewsRequired(this.settings.mcpVaultWrites)
						? async (req) => new DiffReviewModal(this.app, req).review()
						: undefined,
					reviewBatch: reviewsRequired(this.settings.mcpVaultWrites)
						? async (req) => new BatchReviewModal(this.app, req).review()
						: undefined,
					onActivity: (update) => this.activityUi.route(update),
				},
				toolTimeoutMs: this.settings.mcpToolTimeout * 1000,
				reviewTimeoutMs: this.settings.mcpReviewTimeout * 1000,
			});
			await this.mcpServer.start();
		} catch (error: unknown) {
			new Notice(`MCP server failed to start: ${errMsg(error)}`);
		}
	}

	private async stopMcpServer(): Promise<void> {
		if (!this.mcpServer) return;
		await this.mcpServer.stop();
		this.mcpServer = null;
		this.activityUi.clear();
	}

	private async toggleMcpServer(): Promise<void> {
		await this.queueMcpOp(async () => {
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
		});
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
				.setDisabled(busy || running)
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
		this.statusBar.setRunningTooltipContext({
			port: this.settings.ttydPort,
			firewall: this.firewallBar.getState(),
			mcp: {
				running: this.mcpServer?.isRunning() ?? false,
				port: this.settings.mcpPort,
				toolCount: this.mcpServer?.getToolCount() ?? 0,
			},
		});
	}

	// ── Background startup ────────────────────────────

	private async backgroundStartup(): Promise<void> {
		this.statusBar.setState("checking");
		this.statusBar.setDetails("Starting: checking Docker availability…");

		try {
			this.statusBar.setDetails("Starting: probing WSL (5s fast-fail)…");
			await this.docker.ensureWslReady();
		} catch (error: unknown) {
			this.reportContainerError({ detailsPrefix: "WSL error", error, notice: true });
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
			this.reportContainerError({ detailsPrefix: "Docker error", error, notice: true });
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
			this.reportContainerError({ detailsPrefix: "Docker error", error });
			this.stopHealthPoll();
		}
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
		return inputModal(this.app, {
			title,
			placeholder: "e.g. work, research, debug",
			defaultValue,
			multiline: false,
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
			const msg = errMsg(error).toLowerCase();
			if (!msg.includes("exist")) throw error;
		}
	}

	/**
	 * Funnel for "container/docker/wsl call failed" status updates.
	 * Sets state=error, details=`<prefix>: <msg>\nClick for options`, and
	 * optionally raises a Notice (`true` → `Sandbox: <msg>`; string → `<string>: <msg>`).
	 */
	private reportContainerError(opts: {
		detailsPrefix: string;
		error: unknown;
		notice?: string | true;
	}): void {
		this.statusBar.setState("error");
		const msg = errMsg(opts.error);
		this.statusBar.setDetails(`${opts.detailsPrefix}: ${msg}\nClick for options`);
		if (opts.notice === true) {
			new Notice(`Sandbox: ${msg}`);
		} else if (typeof opts.notice === "string") {
			new Notice(`${opts.notice}: ${msg}`);
		}
	}

	private async runDockerCommand(opts: {
		preState?: ContainerState;
		preDetails?: string;
		action: () => Promise<string>;
		postState: ContainerState;
		successMsg: string;
		failurePrefix: string;
	}): Promise<boolean> {
		try {
			if (opts.preState) {
				this.statusBar.setState(opts.preState);
				// Honour caller-supplied details (e.g. "Waiting for previous
				// container to shut down...") instead of clobbering with a generic.
				this.statusBar.setDetails(opts.preDetails ?? "Container is starting up...");
			}
			await opts.action();
			this.statusBar.setState(opts.postState);
			new Notice(opts.successMsg);
			return true;
		} catch (error: unknown) {
			this.reportContainerError({
				detailsPrefix: "Container error",
				error,
				notice: opts.failurePrefix,
			});
			return false;
		}
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
			new Notice(`Failed to get status: ${errMsg(error)}`);
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
