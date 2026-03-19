import { execSync } from "node:child_process";
import * as http from "node:http";
import * as https from "node:https";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
	allowAllNetwork,
	NodeRuntime,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../../../src/index.js";
import type { NetworkAdapter } from "../../../src/types.js";
import type { StdioEvent } from "../../../src/shared/api-types.js";

// Generate self-signed CA + server cert with openssl
function generateCerts(): {
	caCert: string;
	caKey: string;
	serverCert: string;
	serverKey: string;
} {
	// Generate CA key + cert
	const caKey = execSync(
		"openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null",
		{ encoding: "utf-8" },
	);
	const caKeyFile = "/tmp/se-test-ca.key";
	const caCertFile = "/tmp/se-test-ca.crt";
	require("node:fs").writeFileSync(caKeyFile, caKey);
	execSync(
		`openssl req -new -x509 -key ${caKeyFile} -out ${caCertFile} -days 1 -subj "/CN=Test CA" 2>/dev/null`,
	);
	const caCert = require("node:fs").readFileSync(caCertFile, "utf-8");

	// Generate server key + CSR + cert signed by CA
	const serverKey = execSync(
		"openssl genpkey -algorithm RSA -pkeyopt rsa_keygen_bits:2048 2>/dev/null",
		{ encoding: "utf-8" },
	);
	const serverKeyFile = "/tmp/se-test-server.key";
	const serverCsrFile = "/tmp/se-test-server.csr";
	const serverCertFile = "/tmp/se-test-server.crt";
	require("node:fs").writeFileSync(serverKeyFile, serverKey);
	execSync(
		`openssl req -new -key ${serverKeyFile} -out ${serverCsrFile} -subj "/CN=localhost" 2>/dev/null`,
	);
	execSync(
		`openssl x509 -req -in ${serverCsrFile} -CA ${caCertFile} -CAkey ${caKeyFile} -CAcreateserial -out ${serverCertFile} -days 1 -extfile <(echo "subjectAltName=DNS:localhost,IP:127.0.0.1") 2>/dev/null`,
		{ shell: "/bin/bash" },
	);
	const serverCert = require("node:fs").readFileSync(serverCertFile, "utf-8");

	return { caCert, caKey, serverCert, serverKey };
}

// Network adapter that allows localhost (no SSRF blocking) and passes TLS options
function createTestNetworkAdapter(
	tlsOptions?: https.RequestOptions,
): NetworkAdapter {
	return {
		async fetch() {
			throw new Error("fetch not implemented in test adapter");
		},
		async dnsLookup(hostname: string) {
			return { address: "127.0.0.1", family: 4 };
		},
		async httpRequest(url, options) {
			return new Promise((resolve, reject) => {
				const urlObj = new URL(url);
				const isHttps = urlObj.protocol === "https:";
				const transport: typeof https = isHttps ? https : http;
				const reqOptions: https.RequestOptions = {
					hostname: urlObj.hostname,
					port: urlObj.port || (isHttps ? 443 : 80),
					path: urlObj.pathname + urlObj.search,
					method: options?.method || "GET",
					headers: options?.headers || {},
					...(isHttps && options?.rejectUnauthorized !== undefined && {
						rejectUnauthorized: options.rejectUnauthorized,
					}),
					...tlsOptions,
				};

				const req = transport.request(reqOptions, (res) => {
					const chunks: Buffer[] = [];
					res.on("data", (chunk: Buffer) => chunks.push(chunk));
					res.on("end", () => {
						const buffer = Buffer.concat(chunks);
						const headers: Record<string, string> = {};
						Object.entries(res.headers).forEach(([k, v]) => {
							if (typeof v === "string") headers[k] = v;
							else if (Array.isArray(v)) headers[k] = v.join(", ");
						});
						resolve({
							status: res.statusCode || 200,
							statusText: res.statusMessage || "OK",
							headers,
							body: buffer.toString("utf-8"),
							url,
						});
					});
					res.on("error", reject);
				});

				req.on("error", reject);
				if (options?.body) req.write(options.body);
				req.end();
			});
		},
	};
}

describe("HTTPS client and stream Transform/PassThrough in bridge", () => {
	let server: https.Server;
	let serverPort: number;
	let certs: ReturnType<typeof generateCerts>;
	const runtimes = new Set<NodeRuntime>();

	beforeAll(async () => {
		certs = generateCerts();

		server = https.createServer(
			{ key: certs.serverKey, cert: certs.serverCert },
			(req, res) => {
				res.writeHead(200, { "content-type": "text/plain" });
				res.end("https-ok");
			},
		);

		await new Promise<void>((resolve) => {
			server.listen(0, "127.0.0.1", () => resolve());
		});
		const addr = server.address();
		serverPort = typeof addr === "object" && addr ? addr.port : 0;
	});

	afterAll(async () => {
		await new Promise<void>((resolve) => server.close(() => resolve()));
	});

	afterEach(async () => {
		for (const runtime of runtimes) {
			try {
				await runtime.terminate();
			} catch {
				runtime.dispose();
			}
		}
		runtimes.clear();
	});

	function createRuntime(adapter: NetworkAdapter): NodeRuntime {
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

	// ---------------------------------------------------------------
	// HTTPS tests
	// ---------------------------------------------------------------

	it("HTTPS request to self-signed cert succeeds with rejectUnauthorized false", async () => {
		const events: StdioEvent[] = [];
		const adapter = createTestNetworkAdapter();
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
				const https = require('https');
				await new Promise((resolve, reject) => {
					const req = https.request({
						hostname: '127.0.0.1',
						port: ${serverPort},
						path: '/',
						method: 'GET',
						rejectUnauthorized: false,
					}, (res) => {
						let body = '';
						res.on('data', (chunk) => { body += chunk; });
						res.on('end', () => {
							console.log('status:' + res.statusCode);
							console.log('body:' + body);
							resolve();
						});
					});
					req.on('error', (err) => {
						console.error('req-error:' + err.message);
						reject(err);
					});
					req.end();
				});
			})();
		`);
		const stderr = events
			.filter((e) => e.channel === "stderr")
			.map((e) => e.message)
			.join("");
		if (result.code !== 0) {
			throw new Error(`exec failed (code ${result.code}): ${result.errorMessage}\nstderr: ${stderr}`);
		}
		const stdout = events
			.filter((e) => e.channel === "stdout")
			.map((e) => e.message)
			.join("");
		expect(stdout).toContain("status:200");
		expect(stdout).toContain("body:https-ok");
	}, 15_000);

	it("HTTPS request with valid cert chain succeeds", async () => {
		const events: StdioEvent[] = [];
		// Pass the CA cert to the adapter so Node.js trusts the server cert
		const adapter = createTestNetworkAdapter({ ca: certs.caCert });
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
				const https = require('https');
				await new Promise((resolve, reject) => {
					const req = https.request({
						hostname: '127.0.0.1',
						port: ${serverPort},
						path: '/',
						method: 'GET',
					}, (res) => {
						let body = '';
						res.on('data', (chunk) => { body += chunk; });
						res.on('end', () => {
							console.log('status:' + res.statusCode);
							console.log('body:' + body);
							resolve();
						});
					});
					req.on('error', (err) => {
						console.error('req-error:' + err.message);
						reject(err);
					});
					req.end();
				});
			})();
		`);
		const stderr = events
			.filter((e) => e.channel === "stderr")
			.map((e) => e.message)
			.join("");
		if (result.code !== 0) {
			throw new Error(`exec failed (code ${result.code}): ${result.errorMessage}\nstderr: ${stderr}`);
		}
		const stdout = events
			.filter((e) => e.channel === "stdout")
			.map((e) => e.message)
			.join("");
		expect(stdout).toContain("status:200");
		expect(stdout).toContain("body:https-ok");
	}, 15_000);

	// ---------------------------------------------------------------
	// stream.Transform test
	// ---------------------------------------------------------------

	it("stream.Transform pipes data correctly with uppercase transform", async () => {
		const events: StdioEvent[] = [];
		const runtime = new NodeRuntime({
			onStdio: (event) => events.push(event),
			systemDriver: createNodeDriver({}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
		});
		runtimes.add(runtime);

		const result = await runtime.exec(`
			const { Transform } = require('stream');

			const upperCase = new Transform({
				transform(chunk, encoding, callback) {
					this.push(chunk.toString().toUpperCase());
					callback();
				}
			});

			let output = '';
			upperCase.on('data', (chunk) => { output += chunk.toString(); });
			upperCase.on('end', () => {
				console.log('transform-result:' + output);
			});

			upperCase.write('hello ');
			upperCase.write('world');
			upperCase.end();
		`);

		expect(result.code).toBe(0);
		const stdout = events
			.filter((e) => e.channel === "stdout")
			.map((e) => e.message)
			.join("");
		expect(stdout).toContain("transform-result:HELLO WORLD");
	}, 15_000);

	// ---------------------------------------------------------------
	// stream.PassThrough test
	// ---------------------------------------------------------------

	it("stream.PassThrough pipes data through unchanged", async () => {
		const events: StdioEvent[] = [];
		const runtime = new NodeRuntime({
			onStdio: (event) => events.push(event),
			systemDriver: createNodeDriver({}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
		});
		runtimes.add(runtime);

		const result = await runtime.exec(`
			const { PassThrough } = require('stream');

			const pt = new PassThrough();
			let output = '';
			pt.on('data', (chunk) => { output += chunk.toString(); });
			pt.on('end', () => {
				console.log('passthrough-result:' + output);
			});

			pt.write('data: {"event":"message"}\\n\\n');
			pt.write('data: {"event":"done"}\\n\\n');
			pt.end();
		`);

		expect(result.code).toBe(0);
		const stdout = events
			.filter((e) => e.channel === "stdout")
			.map((e) => e.message)
			.join("");
		expect(stdout).toContain('passthrough-result:data: {"event":"message"}\n\ndata: {"event":"done"}\n\n');
	}, 15_000);

	// ---------------------------------------------------------------
	// SSE parsing with Transform
	// ---------------------------------------------------------------

	it("SSE parsing pattern works: Transform splits on data lines and emits parsed events", async () => {
		const events: StdioEvent[] = [];
		const runtime = new NodeRuntime({
			onStdio: (event) => events.push(event),
			systemDriver: createNodeDriver({}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
		});
		runtimes.add(runtime);

		const result = await runtime.exec(`
			const { Transform, PassThrough } = require('stream');

			// SSE parser Transform: splits incoming text on double-newline boundaries
			// and emits parsed JSON objects from 'data: ' lines
			const sseParser = new Transform({
				readableObjectMode: true,
				transform(chunk, encoding, callback) {
					this._buf = (this._buf || '') + chunk.toString();
					const parts = this._buf.split('\\n\\n');
					// Keep the last incomplete part in the buffer
					this._buf = parts.pop();
					for (const part of parts) {
						const lines = part.split('\\n');
						for (const line of lines) {
							if (line.startsWith('data: ')) {
								const payload = line.slice(6);
								if (payload === '[DONE]') {
									this.push({ done: true });
								} else {
									try {
										this.push(JSON.parse(payload));
									} catch (e) {
										// skip non-JSON data lines
									}
								}
							}
						}
					}
					callback();
				},
				flush(callback) {
					// Process any remaining buffer
					if (this._buf && this._buf.trim()) {
						const lines = this._buf.split('\\n');
						for (const line of lines) {
							if (line.startsWith('data: ')) {
								const payload = line.slice(6);
								if (payload === '[DONE]') {
									this.push({ done: true });
								} else {
									try {
										this.push(JSON.parse(payload));
									} catch (e) {}
								}
							}
						}
					}
					callback();
				}
			});

			// Simulate SSE stream source
			const source = new PassThrough();

			const parsed = [];
			source.pipe(sseParser);
			sseParser.on('data', (obj) => parsed.push(obj));
			sseParser.on('end', () => {
				console.log('sse-parsed:' + JSON.stringify(parsed));
			});

			// Write SSE-formatted chunks
			source.write('data: {"type":"content","text":"Hello"}\\n\\n');
			source.write('data: {"type":"content","text":" World"}\\n\\n');
			source.write('data: [DONE]\\n\\n');
			source.end();
		`);

		expect(result.code).toBe(0);
		const stdout = events
			.filter((e) => e.channel === "stdout")
			.map((e) => e.message)
			.join("");
		const match = stdout.match(/sse-parsed:(.+)/);
		expect(match).toBeTruthy();
		const parsed = JSON.parse(match![1]);
		expect(parsed).toEqual([
			{ type: "content", text: "Hello" },
			{ type: "content", text: " World" },
			{ done: true },
		]);
	}, 15_000);
});
