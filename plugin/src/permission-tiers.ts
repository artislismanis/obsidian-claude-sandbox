import type { PermissionTier } from "./mcp-tools";

/** MCP tiers enabled automatically when the server is on. */
export const ALWAYS_ON_TIERS: readonly PermissionTier[] = ["read", "writeScoped", "agent"];

/**
 * Generic over the settings-key type so consumers in this file (no Obsidian
 * deps) can use a plain string, while `settings.ts` re-binds it to
 * `keyof AgentSandboxSettings` for type-safe indexing.
 */
export interface TierDef<K extends string = string> {
	tier: PermissionTier;
	settingKey: K;
	name: string;
	desc: string;
}

/** MCP tiers gated behind per-tier user toggles. Write tiers are handled
 * separately via a single dropdown (see VaultWriteMode) so Reviewed and Full
 * are mutually exclusive. */
export const GATED_TIERS: readonly TierDef[] = [
	{
		tier: "navigate",
		settingKey: "mcpTierNavigate",
		name: "Navigate",
		desc: "Open files and affect what you see in the Obsidian editor.",
	},
	{
		tier: "manage",
		settingKey: "mcpTierManage",
		name: "Manage",
		desc: "Rename, move, and delete files with automatic link updates. Allows structural changes to your vault.",
	},
	{
		tier: "extensions",
		settingKey: "mcpTierExtensions",
		name: "Extensions",
		desc: "Access third-party plugin APIs (Dataview, Templater, Tasks, Canvas). Requires target plugins to be installed.",
	},
];

/** Vault-wide write mode — mutually exclusive choice between no vault-wide
 * writes (scoped only), reviewed writes (diff modal per change), or full
 * unrestricted writes. Rendered as a dropdown in settings. */
export type VaultWriteMode = "none" | "reviewed" | "full";

export function vaultWriteTiers(mode: VaultWriteMode): PermissionTier[] {
	if (mode === "reviewed") return ["writeReviewed"];
	if (mode === "full") return ["writeVault"];
	return [];
}

/** Single source of truth for "should reviews fire?" derived from VaultWriteMode. */
export function reviewsRequired(mode: VaultWriteMode): boolean {
	return mode === "reviewed";
}
