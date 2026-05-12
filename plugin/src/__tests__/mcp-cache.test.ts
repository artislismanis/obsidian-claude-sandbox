import { describe, it, expect, vi, beforeEach } from "vitest";
import { VaultCache } from "../mcp-cache";

function createMockMetadataCache() {
	const listeners = new Map<string, Set<() => void>>();
	const refMap = new Map<object, { event: string; fn: () => void }>();
	return {
		on(event: string, fn: () => void) {
			if (!listeners.has(event)) listeners.set(event, new Set());
			listeners.get(event)!.add(fn);
			const ref = {};
			refMap.set(ref, { event, fn });
			return ref;
		},
		off(event: string, fn: () => void) {
			listeners.get(event)?.delete(fn);
		},
		offref(ref: object) {
			const entry = refMap.get(ref);
			if (!entry) return;
			listeners.get(entry.event)?.delete(entry.fn);
			refMap.delete(ref);
		},
		emit(event: string) {
			for (const fn of listeners.get(event) ?? []) fn();
		},
		listeners,
	};
}

describe("VaultCache", () => {
	let mockMeta: ReturnType<typeof createMockMetadataCache>;
	let cache: VaultCache;

	beforeEach(() => {
		mockMeta = createMockMetadataCache();
		cache = new VaultCache(mockMeta as never);
	});

	it("returns cached value on second call", () => {
		const compute = vi.fn(() => 42);
		expect(cache.get("key", compute)).toBe(42);
		expect(cache.get("key", compute)).toBe(42);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("invalidateAll clears all keys", () => {
		cache.get("a", () => 1);
		cache.get("b", () => 2);
		cache.invalidateAll();
		const compute = vi.fn(() => 99);
		expect(cache.get("a", compute)).toBe(99);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("does not subscribe to 'changed' events (too noisy to invalidate graph)", () => {
		// Earlier tests asserted "emitting 'changed' doesn't invalidate" by
		// emitting and checking the compute wasn't re-run — but if VaultCache
		// never registered a listener in the first place, that assertion is
		// trivially satisfied. Assert the contract directly: no 'changed'
		// listener exists. If a future refactor accidentally subscribes, this
		// catches it.
		expect(mockMeta.listeners.get("changed")?.size ?? 0).toBe(0);

		const compute = vi.fn(() => "val");
		cache.get("key", compute);
		mockMeta.emit("changed");
		cache.get("key", compute);
		expect(compute).toHaveBeenCalledTimes(1);
	});

	it("invalidates all keys on 'resolved' event", () => {
		const graphCompute = vi.fn(() => "graph-data");
		const otherCompute = vi.fn(() => "other-data");
		cache.get("graph", graphCompute);
		cache.get("other", otherCompute);

		mockMeta.emit("resolved");

		cache.get("graph", graphCompute);
		cache.get("other", otherCompute);
		expect(graphCompute).toHaveBeenCalledTimes(2);
		expect(otherCompute).toHaveBeenCalledTimes(2);
	});

	it("unregisters listeners on destroy", () => {
		cache.destroy();
		expect(mockMeta.listeners.get("changed")?.size ?? 0).toBe(0);
		expect(mockMeta.listeners.get("resolved")?.size ?? 0).toBe(0);
	});
});
