import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { DnsCache } from "../../src/kernel/dns-cache.js";
import type { DnsResult } from "../../src/kernel/host-adapter.js";

describe("DnsCache", () => {
	let cache: DnsCache;

	beforeEach(() => {
		cache = new DnsCache();
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const result4: DnsResult = { address: "93.184.216.34", family: 4 };
	const result6: DnsResult = { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 };

	describe("lookup", () => {
		it("returns null on cache miss", () => {
			expect(cache.lookup("example.com", "A")).toBeNull();
		});

		it("returns cached result on hit", () => {
			cache.store("example.com", "A", result4);
			expect(cache.lookup("example.com", "A")).toEqual(result4);
		});

		it("returns null for different rrtype", () => {
			cache.store("example.com", "A", result4);
			expect(cache.lookup("example.com", "AAAA")).toBeNull();
		});

		it("returns null for different hostname", () => {
			cache.store("example.com", "A", result4);
			expect(cache.lookup("other.com", "A")).toBeNull();
		});

		it("distinguishes A vs AAAA for same hostname", () => {
			cache.store("example.com", "A", result4);
			cache.store("example.com", "AAAA", result6);
			expect(cache.lookup("example.com", "A")).toEqual(result4);
			expect(cache.lookup("example.com", "AAAA")).toEqual(result6);
		});
	});

	describe("TTL expiry", () => {
		it("returns null after TTL expires", () => {
			cache.store("example.com", "A", result4, 5000);
			expect(cache.lookup("example.com", "A")).toEqual(result4);

			// Advance past TTL
			vi.advanceTimersByTime(5000);
			expect(cache.lookup("example.com", "A")).toBeNull();
		});

		it("returns result just before TTL expires", () => {
			cache.store("example.com", "A", result4, 5000);
			vi.advanceTimersByTime(4999);
			expect(cache.lookup("example.com", "A")).toEqual(result4);
		});

		it("uses default TTL when none specified", () => {
			const shortCache = new DnsCache({ defaultTtlMs: 1000 });
			shortCache.store("example.com", "A", result4);

			vi.advanceTimersByTime(999);
			expect(shortCache.lookup("example.com", "A")).toEqual(result4);

			vi.advanceTimersByTime(1);
			expect(shortCache.lookup("example.com", "A")).toBeNull();
		});

		it("removes expired entry from cache on lookup", () => {
			cache.store("example.com", "A", result4, 1000);
			vi.advanceTimersByTime(1000);
			cache.lookup("example.com", "A"); // triggers removal
			expect(cache.size).toBe(0);
		});
	});

	describe("store", () => {
		it("overwrites existing entry", () => {
			cache.store("example.com", "A", result4);
			const newResult: DnsResult = { address: "1.2.3.4", family: 4 };
			cache.store("example.com", "A", newResult);
			expect(cache.lookup("example.com", "A")).toEqual(newResult);
		});

		it("refreshes TTL on overwrite", () => {
			cache.store("example.com", "A", result4, 2000);
			vi.advanceTimersByTime(1500);
			// Overwrite resets TTL
			cache.store("example.com", "A", result4, 2000);
			vi.advanceTimersByTime(1500);
			// 1500ms into second TTL — still valid
			expect(cache.lookup("example.com", "A")).toEqual(result4);
		});
	});

	describe("flush", () => {
		it("clears all entries", () => {
			cache.store("a.com", "A", result4);
			cache.store("b.com", "A", result4);
			cache.store("c.com", "AAAA", result6);
			expect(cache.size).toBe(3);

			cache.flush();
			expect(cache.size).toBe(0);
			expect(cache.lookup("a.com", "A")).toBeNull();
			expect(cache.lookup("b.com", "A")).toBeNull();
			expect(cache.lookup("c.com", "AAAA")).toBeNull();
		});

		it("allows new entries after flush", () => {
			cache.store("example.com", "A", result4);
			cache.flush();
			cache.store("example.com", "A", result6);
			expect(cache.lookup("example.com", "A")).toEqual(result6);
		});
	});

	describe("size", () => {
		it("starts at 0", () => {
			expect(cache.size).toBe(0);
		});

		it("increments on store", () => {
			cache.store("a.com", "A", result4);
			expect(cache.size).toBe(1);
			cache.store("b.com", "A", result4);
			expect(cache.size).toBe(2);
		});

		it("does not increment on overwrite", () => {
			cache.store("a.com", "A", result4);
			cache.store("a.com", "A", result6);
			expect(cache.size).toBe(1);
		});
	});
});
