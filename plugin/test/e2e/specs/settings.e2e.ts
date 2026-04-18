import { browser, expect, $, $$ } from "@wdio/globals";
import { describe, it, before, after } from "mocha";
import { obsidianPage } from "wdio-obsidian-service";

const PLUGIN_ID = "obsidian-agent-sandbox";

// WebdriverIO's text-match selector (=text) is not valid CSS and cannot be
// nested inside :has(). Use full-document XPath that resolves in a single
// query (no chaining) to avoid stale-element races on re-renders.
const SI = (name: string) =>
	`//div[contains(concat(" ",normalize-space(@class)," ")," setting-item ") and ` +
	`descendant::*[contains(@class,"setting-item-name") and normalize-space(.)="${name}"]]`;

function settingInput(name: string) {
	return $(`${SI(name)}//input[@type="text"]`);
}
function settingDescription(name: string) {
	return $(`${SI(name)}//*[contains(@class,"setting-item-description")]`);
}

async function openPluginSettings(): Promise<void> {
	await browser.executeObsidianCommand("app:open-settings");
	const tab = $(".vertical-tab-nav-item*=Agent Sandbox");
	await tab.waitForExist({ timeout: 5000 });
	await tab.click();
}

async function switchTab(label: string): Promise<void> {
	const tab = $(`.sandbox-settings-tab=${label}`);
	await tab.waitForExist({ timeout: 3000 });
	await tab.click();
}

async function closeSettings(): Promise<void> {
	await browser.keys("Escape");
	await browser.pause(300);
}

describe("Settings — validation and warnings", function () {
	before(async function () {
		await obsidianPage.resetVault();
	});

	describe("General tab", function () {
		it("shows restart labels on restart-needing settings", async function () {
			await openPluginSettings();
			await switchTab("General");

			const descriptions = $$(".setting-item-description");
			const texts: string[] = [];
			for (const d of await descriptions.getElements()) {
				texts.push(await d.getText());
			}
			const restartTexts = texts.filter((t) => t.includes("Requires restart"));
			expect(restartTexts.length).toBeGreaterThanOrEqual(3);
		});

		it("auto-start and auto-stop do NOT have restart labels", async function () {
			const descriptions = $$(".setting-item-description");
			const texts: string[] = [];
			for (const d of await descriptions.getElements()) {
				texts.push(await d.getText());
			}

			const autoStartDesc = texts.find((t) => t.includes("Start the container when"));
			expect(autoStartDesc).toBeDefined();
			expect(autoStartDesc).not.toContain("Requires restart");
		});
	});

	describe("Terminal tab", function () {
		it("port field shows restart label", async function () {
			await openPluginSettings();
			await switchTab("Terminal");

			const portDesc = $(".setting-item-description*=host port mapped");
			await expect(portDesc).toExist();
			expect(await portDesc.getText()).toContain("Requires restart");
		});

		it("font size validates range 8-32", async function () {
			const fontSizeInput = settingInput("Font size");
			await fontSizeInput.waitForExist({ timeout: 3000 });

			await fontSizeInput.setValue("50");
			await browser.pause(200);
			expect(await fontSizeInput.getAttribute("class")).toContain("sandbox-input-error");

			await fontSizeInput.setValue("14");
			await browser.pause(200);
			expect(await fontSizeInput.getAttribute("class")).not.toContain("sandbox-input-error");
		});

		it("scrollback validates range 100-100000", async function () {
			const scrollInput = settingInput("Scrollback");
			await scrollInput.waitForExist({ timeout: 3000 });

			await scrollInput.setValue("50");
			await browser.pause(200);
			expect(await scrollInput.getAttribute("class")).toContain("sandbox-input-error");

			await scrollInput.setValue("10000");
			await browser.pause(200);
			expect(await scrollInput.getAttribute("class")).not.toContain("sandbox-input-error");
		});

		it("bind address 0.0.0.0 shows security warning", async function () {
			const bindInput = settingInput("Bind address");
			await bindInput.waitForExist({ timeout: 3000 });
			await bindInput.setValue("0.0.0.0");
			await browser.pause(500);

			const desc = settingDescription("Bind address");
			expect(await desc.getText()).toContain("Warning");

			await bindInput.setValue("127.0.0.1");
			await browser.pause(500);
			expect(await desc.getText()).not.toContain("Warning");
		});

		it("theme and font have no restart labels", async function () {
			const themeDesc = settingDescription("Terminal theme");
			await expect(themeDesc).toExist();
			expect(await themeDesc.getText()).not.toContain("Requires restart");
		});
	});

	describe("MCP tab", function () {
		it("default tier values: Read on, Write scoped on, others off", async function () {
			await openPluginSettings();
			await switchTab("MCP");

			const values = await browser.executeObsidian(({ app }) => {
				const plugins = (
					app as unknown as {
						plugins: {
							plugins: Record<
								string,
								{
									settings: {
										mcpTierRead: boolean;
										mcpTierWriteScoped: boolean;
										mcpTierWriteVault: boolean;
										mcpTierNavigate: boolean;
										mcpTierManage: boolean;
									};
								}
							>;
						};
					}
				).plugins.plugins;
				const s = plugins["obsidian-agent-sandbox"]?.settings;
				return s
					? {
							read: s.mcpTierRead,
							writeScoped: s.mcpTierWriteScoped,
							writeVault: s.mcpTierWriteVault,
							navigate: s.mcpTierNavigate,
							manage: s.mcpTierManage,
						}
					: null;
			});

			expect(values).not.toBeNull();
			expect(values!.read).toBe(true);
			expect(values!.writeScoped).toBe(true);
			expect(values!.writeVault).toBe(false);
			expect(values!.navigate).toBe(false);
			expect(values!.manage).toBe(false);
		});

		it("token regenerate produces a new value", async function () {
			const tokenBefore = await browser.executeObsidian(({ app }) => {
				const plugins = (
					app as unknown as {
						plugins: {
							plugins: Record<string, { settings: { mcpToken: string } }>;
						};
					}
				).plugins.plugins;
				return plugins["obsidian-agent-sandbox"]?.settings?.mcpToken ?? "";
			});

			const regenButton = $("button=Regenerate");
			await regenButton.waitForExist({ timeout: 3000 });
			await regenButton.click();
			await browser.pause(500);

			const tokenAfter = await browser.executeObsidian(({ app }) => {
				const plugins = (
					app as unknown as {
						plugins: {
							plugins: Record<string, { settings: { mcpToken: string } }>;
						};
					}
				).plugins.plugins;
				return plugins["obsidian-agent-sandbox"]?.settings?.mcpToken ?? "";
			});

			expect(tokenAfter).not.toBe(tokenBefore);
			expect(tokenAfter).toMatch(/^[a-f0-9]{32}$/);
		});

		it("port validation rejects invalid values", async function () {
			const portInput = settingInput("MCP port");
			await portInput.waitForExist({ timeout: 3000 });

			await portInput.setValue("abc");
			await browser.pause(200);
			expect(await portInput.getAttribute("class")).toContain("sandbox-input-error");

			await portInput.setValue("28080");
			await browser.pause(200);
			expect(await portInput.getAttribute("class")).not.toContain("sandbox-input-error");
		});
	});

	after(async function () {
		await closeSettings();
	});
});

describe("Settings — persistence and lifecycle", function () {
	// reloadObsidian() copies the vault fresh from the original fixture source on
	// every call, discarding any data.json written during the session. There is no
	// supported way to reload Obsidian in-place within wdio-obsidian-service without
	// patching the harness. The save/load round-trip is covered by the debounce
	// logic (unit tests) and by loadSettings() reading data.json on startup.
	it.skip("settings persist across Obsidian reload", async function () {
		await browser.executeObsidian(({ app }) => {
			const p = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{ settings: { terminalFontSize: number }; saveData: (d: unknown) => Promise<void> }
						>;
					};
				}
			).plugins.plugins["obsidian-agent-sandbox"];
			if (p) {
				p.settings.terminalFontSize = 18;
				void p.saveData(p.settings);
			}
		});
		await browser.pause(300);
		await browser.reloadObsidian();

		const fontSize = await browser.executeObsidian(({ app }) => {
			const plugins = (
				app as unknown as {
					plugins: {
						plugins: Record<string, { settings: { terminalFontSize: number } }>;
					};
				}
			).plugins.plugins;
			return plugins["obsidian-agent-sandbox"]?.settings?.terminalFontSize ?? 0;
		});

		expect(fontSize).toBe(18);

		// Reset
		await browser.executeObsidian(({ app }) => {
			const plugins = (
				app as unknown as {
					plugins: {
						plugins: Record<
							string,
							{
								settings: Record<string, unknown>;
								saveData: (d: unknown) => Promise<void>;
							}
						>;
					};
				}
			).plugins.plugins;
			const p = plugins["obsidian-agent-sandbox"];
			if (p) {
				p.settings.terminalFontSize = 14;
				void p.saveData(p.settings);
			}
		});
	});

	// wdio-obsidian-service loads the plugin from memory, not from disk files.
	// After disablePlugin(), main.js is absent when enablePlugin() tries to
	// reload it, so re-enable always fails in this harness. Skip rather than
	// maintain a test that can never pass in this environment.
	it.skip("plugin survives disable/enable cycle", async function () {
		await obsidianPage.disablePlugin(PLUGIN_ID);
		await browser.pause(1000);
		await obsidianPage.enablePlugin(PLUGIN_ID);
		await browser.pause(1000);

		const loaded = await browser.executeObsidian(({ app }) => {
			return (
				app as unknown as { plugins: { enabledPlugins: Set<string> } }
			).plugins.enabledPlugins.has("obsidian-agent-sandbox");
		});
		expect(loaded).toBe(true);
	});
});
