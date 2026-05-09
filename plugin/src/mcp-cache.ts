import type { MetadataCache } from "obsidian";

export class VaultCache {
	private cache = new Map<string, unknown>();
	private metadataCache: MetadataCache;
	private unregister: (() => void)[] = [];

	constructor(metadataCache: MetadataCache) {
		this.metadataCache = metadataCache;

		// All cached values (graph, tag counts, property names) derive from
		// metadataCache. "resolved" fires after a batch of metadata updates,
		// so wholesale invalidation is correct and avoids per-key bookkeeping.
		const onResolved = () => this.invalidateAll();
		this.metadataCache.on("resolved", onResolved);
		this.unregister.push(() => this.metadataCache.off("resolved", onResolved));
	}

	get<T>(key: string, computeFn: () => T): T {
		if (this.cache.has(key)) return this.cache.get(key) as T;
		const value = computeFn();
		this.cache.set(key, value);
		return value;
	}

	invalidateAll(): void {
		this.cache.clear();
	}

	destroy(): void {
		for (const fn of this.unregister) fn();
		this.unregister = [];
		this.cache.clear();
	}
}
