// Typings for the plugin instance when accessed via browser.executeObsidian.
// Lets us write: plugins["obsidian-agent-sandbox"].settings.mcpEnabled
import type AgentSandboxPlugin from "../../src/main";

declare module "wdio-obsidian-service" {
	interface InstalledPlugins {
		"obsidian-agent-sandbox": AgentSandboxPlugin;
	}
}
