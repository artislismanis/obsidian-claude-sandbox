import type { EventRef, MetadataCache } from "obsidian";

export class VaultCache {
	private cache = new Map<string, unknown>();
	private metadataCache: MetadataCache;
	private eventRefs: EventRef[] = [];

	constructor(metadataCache: MetadataCache) {
		this.metadataCache = metadataCache;

		// All cached values (graph, tag counts, property names) derive from
		// metadataCache. "resolved" fires after a batch of metadata updates,
		// so wholesale invalidation is correct and avoids per-key bookkeeping.
		// Use EventRef + offref (Obsidian's recommended pattern) instead of
		// raw on/off — the matching offref pairs by ref identity rather than
		// by callback identity, so it survives any internal wrapping the API
		// does on its handlers.
		this.eventRefs.push(this.metadataCache.on("resolved", () => this.invalidateAll()));
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
		for (const ref of this.eventRefs) this.metadataCache.offref(ref);
		this.eventRefs = [];
		this.cache.clear();
	}
}
