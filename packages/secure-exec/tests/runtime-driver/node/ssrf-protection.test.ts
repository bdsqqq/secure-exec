import { afterEach, describe, expect, it, vi } from "vitest";
import { createDefaultNetworkAdapter } from "../../../src/index.js";
import { isPrivateIp } from "../../../src/node/driver.js";

describe("SSRF protection", () => {
	// ---------------------------------------------------------------
	// isPrivateIp — unit coverage for all reserved ranges
	// ---------------------------------------------------------------

	describe("isPrivateIp", () => {
		it.each([
			["10.0.0.1", true],          // 10.0.0.0/8
			["10.255.255.255", true],
			["172.16.0.1", true],         // 172.16.0.0/12
			["172.31.255.255", true],
			["172.15.0.1", false],        // just below range
			["172.32.0.1", false],        // just above range
			["192.168.0.1", true],        // 192.168.0.0/16
			["192.168.255.255", true],
			["127.0.0.1", true],          // 127.0.0.0/8
			["127.255.255.255", true],
			["169.254.169.254", true],    // 169.254.0.0/16 (link-local / metadata)
			["169.254.0.1", true],
			["0.0.0.0", true],            // 0.0.0.0/8
			["224.0.0.1", true],          // multicast
			["239.255.255.255", true],
			["240.0.0.1", true],          // reserved
			["255.255.255.255", true],
			["8.8.8.8", false],           // public
			["1.1.1.1", false],
			["142.250.80.46", false],     // google
		])("IPv4 %s → %s", (ip, expected) => {
			expect(isPrivateIp(ip)).toBe(expected);
		});

		it.each([
			["::1", true],               // loopback
			["::", true],                // unspecified
			["fc00::1", true],            // ULA fc00::/7
			["fd12:3456::1", true],       // ULA fd
			["fe80::1", true],            // link-local
			["ff02::1", true],            // multicast
			["2607:f8b0:4004::1", false], // public (google)
		])("IPv6 %s → %s", (ip, expected) => {
			expect(isPrivateIp(ip)).toBe(expected);
		});

		it("detects IPv4-mapped IPv6 addresses", () => {
			expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
			expect(isPrivateIp("::ffff:169.254.169.254")).toBe(true);
			expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
		});
	});

	// ---------------------------------------------------------------
	// Network adapter SSRF blocking
	// ---------------------------------------------------------------

	describe("network adapter blocks private IPs", () => {
		const adapter = createDefaultNetworkAdapter();

		it("fetch blocks metadata endpoint 169.254.169.254", async () => {
			await expect(
				adapter.fetch("http://169.254.169.254/latest/meta-data/", {}),
			).rejects.toThrow(/SSRF blocked/);
		});

		it("fetch blocks 10.x private range", async () => {
			await expect(
				adapter.fetch("http://10.0.0.1/internal", {}),
			).rejects.toThrow(/SSRF blocked/);
		});

		it("fetch blocks 192.168.x private range", async () => {
			await expect(
				adapter.fetch("http://192.168.1.1/admin", {}),
			).rejects.toThrow(/SSRF blocked/);
		});

		it("httpRequest blocks metadata endpoint 169.254.169.254", async () => {
			await expect(
				adapter.httpRequest("http://169.254.169.254/latest/meta-data/", {}),
			).rejects.toThrow(/SSRF blocked/);
		});

		it("httpRequest blocks localhost", async () => {
			await expect(
				adapter.httpRequest("http://127.0.0.1:9999/", {}),
			).rejects.toThrow(/SSRF blocked/);
		});

		it("fetch allows data: URLs (no network)", async () => {
			const result = await adapter.fetch("data:text/plain,ssrf-test-ok", {});
			expect(result.ok).toBe(true);
			expect(result.body).toContain("ssrf-test-ok");
		});
	});

	// ---------------------------------------------------------------
	// Redirect-to-private-IP blocking
	// ---------------------------------------------------------------

	describe("redirect to private IP is blocked", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		it("fetch blocks 302 redirect to private IP", async () => {
			// Mock global fetch to simulate a 302 redirect to a private IP
			const originalFetch = globalThis.fetch;
			const mockFetch = vi.fn().mockResolvedValueOnce(
				new Response(null, {
					status: 302,
					headers: { location: "http://169.254.169.254/latest/meta-data/" },
				}),
			);
			vi.stubGlobal("fetch", mockFetch);

			const adapter = createDefaultNetworkAdapter();
			// Use a public-looking IP so the initial check passes
			await expect(
				adapter.fetch("http://8.8.8.8/redirect", {}),
			).rejects.toThrow(/SSRF blocked/);

			vi.stubGlobal("fetch", originalFetch);
		});

		it("fetch blocks 307 redirect to 10.x range", async () => {
			const originalFetch = globalThis.fetch;
			const mockFetch = vi.fn().mockResolvedValueOnce(
				new Response(null, {
					status: 307,
					headers: { location: "http://10.0.0.1/internal-api" },
				}),
			);
			vi.stubGlobal("fetch", mockFetch);

			const adapter = createDefaultNetworkAdapter();
			await expect(
				adapter.fetch("http://8.8.8.8/redirect", {}),
			).rejects.toThrow(/SSRF blocked/);

			vi.stubGlobal("fetch", originalFetch);
		});
	});

	// ---------------------------------------------------------------
	// DNS rebinding — documented as known limitation
	// ---------------------------------------------------------------

	describe("DNS rebinding", () => {
		it("known limitation: DNS rebinding after initial check is not blocked at the adapter level", () => {
			// DNS rebinding attacks involve a hostname that resolves to a safe public IP
			// on the first lookup (passing the SSRF check) but resolves to a private IP on
			// the subsequent connection. Fully mitigating this requires either:
			//   - Pinning the resolved IP for the connection (not possible with native fetch)
			//   - Using a custom DNS resolver with caching and TTL enforcement
			//
			// This is documented as a known limitation. The pre-flight DNS check still
			// provides defense in depth against most SSRF vectors including direct IP
			// access, redirect-based attacks, and static DNS entries.
			expect(true).toBe(true);
		});
	});
});
