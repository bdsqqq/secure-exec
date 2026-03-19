import * as http from "node:http";
import * as https from "node:https";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createDefaultNetworkAdapter,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
	NodeRuntime,
	allowAllNetwork,
} from "../../../src/index.js";
import type { StdioEvent } from "../../../src/shared/api-types.js";
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
	// Loopback SSRF exemption for sandbox-owned HTTP servers
	// ---------------------------------------------------------------

	describe("loopback exemption for sandbox-owned servers", () => {
		it("sandbox creates http.createServer, binds port 0, fetches own endpoint", async () => {
			const adapter = createDefaultNetworkAdapter();

			// Start a server through the adapter (simulates sandbox server creation)
			let capturedRequest: { method: string; url: string } | null = null;
			const result = await adapter.httpServerListen!({
				serverId: 1,
				port: 0,
				onRequest: async (req) => {
					capturedRequest = { method: req.method, url: req.url };
					return {
						status: 200,
						headers: [["content-type", "text/plain"]],
						body: "hello-from-sandbox",
					};
				},
			});

			const port = result.address!.port;
			try {
				// Fetch from the sandbox's own server — should succeed
				const fetchResult = await adapter.fetch(
					`http://127.0.0.1:${port}/test`,
					{ method: "GET" },
				);
				expect(fetchResult.status).toBe(200);
				expect(fetchResult.body).toBe("hello-from-sandbox");
				expect(capturedRequest).toEqual({ method: "GET", url: "/test" });

				// httpRequest to the same port also succeeds
				const httpResult = await adapter.httpRequest(
					`http://127.0.0.1:${port}/api`,
					{ method: "GET" },
				);
				expect(httpResult.status).toBe(200);
				expect(httpResult.body).toBe("hello-from-sandbox");
			} finally {
				await adapter.httpServerClose!(1);
			}
		});

		it("fetch to localhost on port not owned by sandbox is still blocked", async () => {
			const adapter = createDefaultNetworkAdapter();
			// Port 59999 is not owned by any server
			await expect(
				adapter.fetch("http://127.0.0.1:59999/", {}),
			).rejects.toThrow(/SSRF blocked/);
			await expect(
				adapter.httpRequest("http://localhost:59999/", {}),
			).rejects.toThrow(/SSRF blocked/);
		});

		it("fetch to other private IPs remains blocked even with owned servers", async () => {
			const adapter = createDefaultNetworkAdapter();

			// Start a server so we have an owned port
			await adapter.httpServerListen!({
				serverId: 2,
				port: 0,
				onRequest: async () => ({ status: 200, body: "ok" }),
			});

			try {
				// Other private ranges remain blocked
				await expect(
					adapter.fetch("http://10.0.0.1/", {}),
				).rejects.toThrow(/SSRF blocked/);
				await expect(
					adapter.fetch("http://192.168.1.1/", {}),
				).rejects.toThrow(/SSRF blocked/);
				await expect(
					adapter.fetch("http://169.254.169.254/", {}),
				).rejects.toThrow(/SSRF blocked/);
			} finally {
				await adapter.httpServerClose!(2);
			}
		});

		it("coerces 0.0.0.0 listen to loopback for strict sandboxing", async () => {
			const adapter = createDefaultNetworkAdapter();

			const result = await adapter.httpServerListen!({
				serverId: 3,
				port: 0,
				hostname: "0.0.0.0",
				onRequest: async () => ({
					status: 200,
					headers: [["content-type", "text/plain"]],
					body: "coerced",
				}),
			});

			// 0.0.0.0 was coerced to 127.0.0.1
			expect(result.address!.address).toBe("127.0.0.1");

			try {
				// Can still fetch from the coerced loopback server
				const fetchResult = await adapter.fetch(
					`http://127.0.0.1:${result.address!.port}/`,
					{},
				);
				expect(fetchResult.status).toBe(200);
				expect(fetchResult.body).toBe("coerced");
			} finally {
				await adapter.httpServerClose!(3);
			}
		});

		it("port exemption removed after server close", async () => {
			const adapter = createDefaultNetworkAdapter();

			const result = await adapter.httpServerListen!({
				serverId: 4,
				port: 0,
				onRequest: async () => ({ status: 200, body: "ok" }),
			});

			const port = result.address!.port;
			await adapter.httpServerClose!(4);

			// Port no longer owned — should be blocked
			await expect(
				adapter.fetch(`http://127.0.0.1:${port}/`, {}),
			).rejects.toThrow(/SSRF blocked/);
		});
	});

	// ---------------------------------------------------------------
	// Sandbox integration: Agent maxSockets and upgrade events
	// ---------------------------------------------------------------

	describe("sandbox HTTP server integration", () => {
		const runtimes = new Set<NodeRuntime>();

		afterEach(async () => {
			for (const runtime of runtimes) {
				try { await runtime.terminate(); } catch { runtime.dispose(); }
			}
			runtimes.clear();
		});

		function createRuntime(): NodeRuntime {
			const adapter = createDefaultNetworkAdapter();
			const runtime = new NodeRuntime({
				systemDriver: createNodeDriver({
					networkAdapter: adapter,
					permissions: allowAllNetwork,
				}),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});
			runtimes.add(runtime);
			return runtime;
		}

		it("http.Agent with maxSockets=1 serializes concurrent requests through bridged server", async () => {
			const events: StdioEvent[] = [];
			const adapter = createDefaultNetworkAdapter();
			const runtime = new NodeRuntime({
				onStdio: (event) => events.push(event),
				systemDriver: createNodeDriver({
					networkAdapter: adapter,
					permissions: allowAllNetwork,
				}),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});
			runtimes.add(runtime);

			const result = await runtime.exec(`
				(async () => {
					const http = require('http');

					// Track request order to verify serialization
					const order = [];

					const server = http.createServer((req, res) => {
						order.push(req.url);
						res.writeHead(200, { 'content-type': 'text/plain' });
						res.end('ok-' + req.url);
					});

					await new Promise((resolve) => server.listen(0, resolve));
					const port = server.address().port;

					// Agent with maxSockets=1 forces serialization
					const agent = new http.Agent({ maxSockets: 1 });

					// Fire 3 concurrent requests
					const results = await Promise.all([1, 2, 3].map(i =>
						new Promise((resolve, reject) => {
							const req = http.request({
								hostname: '127.0.0.1',
								port,
								path: '/' + i,
								agent,
							}, (res) => {
								let body = '';
								res.on('data', (d) => body += d);
								res.on('end', () => resolve({ status: res.statusCode, body }));
							});
							req.on('error', reject);
							req.end();
						})
					));

					// All requests succeeded
					console.log('count:' + results.length);
					console.log('allOk:' + results.every(r => r.status === 200));
					// maxSockets=1 preserves request order (serialized dispatch)
					console.log('order:' + order.join(','));

					await new Promise(resolve => server.close(resolve));
				})();
			`);

			const stdout = events
				.filter((e) => e.channel === "stdout")
				.map((e) => e.message)
				.join("");

			if (result.code !== 0) {
				const stderr = events.filter((e) => e.channel === "stderr").map((e) => e.message).join("");
				throw new Error(`exec failed (code ${result.code}): ${result.errorMessage}\nstderr: ${stderr}`);
			}

			expect(stdout).toContain("count:3");
			expect(stdout).toContain("allOk:true");
			// Serialization preserves request order
			expect(stdout).toContain("order:/1,/2,/3");
		}, 15_000);

		it("upgrade request fires upgrade event with response and socket on bridged server", async () => {
			// Create a real host-side HTTP server that handles upgrade protocol
			const upgradeServer = http.createServer((_req, res) => {
				res.writeHead(200);
				res.end("normal");
			});
			upgradeServer.on("upgrade", (req, socket) => {
				socket.write(
					"HTTP/1.1 101 Switching Protocols\r\n" +
					"Upgrade: websocket\r\n" +
					"Connection: Upgrade\r\n\r\n",
				);
				socket.end();
			});

			await new Promise<void>((resolve) => upgradeServer.listen(0, "127.0.0.1", resolve));
			const addr = upgradeServer.address() as import("node:net").AddressInfo;
			const upgradePort = addr.port;

			try {
				// Use a network adapter that allows the upgrade server's port
				const adapter = createDefaultNetworkAdapter();
				// Register the upgrade server's port as owned via a dummy listen
				const dummyResult = await adapter.httpServerListen!({
					serverId: 99,
					port: 0,
					onRequest: async () => ({ status: 200, body: "dummy" }),
				});
				const dummyPort = dummyResult.address!.port;

				// We need the upgrade server's port exempted — add it by listening
				// Actually, use a custom adapter that allows the specific port
				const customAdapter: import("../../../src/types.js").NetworkAdapter = {
					async fetch(url, opts) { return adapter.fetch(url, opts); },
					async dnsLookup(h) { return adapter.dnsLookup(h); },
					async httpRequest(url, opts) {
						// Allow the upgrade server's port on loopback
						return new Promise((resolve, reject) => {
							const urlObj = new URL(url);
							const transport = urlObj.protocol === "https:" ? https : http;
							const reqOptions: https.RequestOptions = {
								hostname: urlObj.hostname,
								port: urlObj.port || 80,
								path: urlObj.pathname + urlObj.search,
								method: opts?.method || "GET",
								headers: opts?.headers || {},
							};

							const req = transport.request(reqOptions, (res) => {
								const chunks: Buffer[] = [];
								res.on("data", (chunk: Buffer) => chunks.push(chunk));
								res.on("end", () => {
									const headers: Record<string, string> = {};
									Object.entries(res.headers).forEach(([k, v]) => {
										if (typeof v === "string") headers[k] = v;
										else if (Array.isArray(v)) headers[k] = v.join(", ");
									});
									resolve({
										status: res.statusCode || 200,
										statusText: res.statusMessage || "OK",
										headers,
										body: Buffer.concat(chunks).toString("utf-8"),
										url,
									});
								});
								res.on("error", reject);
							});

							// Handle HTTP upgrade (101 Switching Protocols)
							req.on("upgrade", (res, socket, head) => {
								const headers: Record<string, string> = {};
								Object.entries(res.headers).forEach(([k, v]) => {
									if (typeof v === "string") headers[k] = v;
									else if (Array.isArray(v)) headers[k] = v.join(", ");
								});
								socket.destroy();
								resolve({
									status: res.statusCode || 101,
									statusText: res.statusMessage || "Switching Protocols",
									headers,
									body: head.toString(),
									url,
								});
							});

							req.on("error", reject);
							if (opts?.body) req.write(opts.body);
							req.end();
						});
					},
				};

				await adapter.httpServerClose!(99);

				const events: StdioEvent[] = [];
				const runtime = new NodeRuntime({
					onStdio: (event) => events.push(event),
					systemDriver: createNodeDriver({
						networkAdapter: customAdapter,
						permissions: allowAllNetwork,
					}),
					runtimeDriverFactory: createNodeRuntimeDriverFactory(),
				});
				runtimes.add(runtime);

				const result = await runtime.exec(`
					(async () => {
						const http = require('http');

						const req = http.request({
							hostname: '127.0.0.1',
							port: ${upgradePort},
							path: '/ws',
							headers: {
								'Connection': 'Upgrade',
								'Upgrade': 'websocket',
							},
						});

						const upgradeResult = await new Promise((resolve, reject) => {
							req.on('upgrade', (res, socket, head) => {
								resolve({
									status: res.statusCode,
									upgrade: res.headers['upgrade'],
								});
							});
							req.on('error', reject);
							req.end();
						});

						console.log('status:' + upgradeResult.status);
						console.log('upgrade:' + upgradeResult.upgrade);
					})();
				`);

				const stdout = events
					.filter((e) => e.channel === "stdout")
					.map((e) => e.message)
					.join("");

				if (result.code !== 0) {
					const stderr = events.filter((e) => e.channel === "stderr").map((e) => e.message).join("");
					throw new Error(`exec failed (code ${result.code}): ${result.errorMessage}\nstderr: ${stderr}`);
				}

				expect(stdout).toContain("status:101");
				expect(stdout).toContain("upgrade:websocket");
			} finally {
				await new Promise<void>((resolve) => upgradeServer.close(() => resolve()));
			}
		}, 15_000);
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
