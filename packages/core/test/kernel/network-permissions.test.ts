import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_UNIX,
	AF_INET,
	SOCK_DGRAM,
	SOCK_STREAM,
	KernelError,
} from "../../src/kernel/index.js";
import type {
	HostListener,
	Kernel,
	NetworkAccessRequest,
	PermissionDecision,
	HostNetworkAdapter,
	HostSocket,
	HostUdpSocket,
	DnsResult,
	DriverProcess,
} from "../../src/kernel/index.js";
import { createTestKernel } from "./helpers.js";

// ---------------------------------------------------------------------------
// Permission policy helpers
// ---------------------------------------------------------------------------

/** Deny everything — no network ops allowed. */
const denyAll = (): PermissionDecision => ({ allow: false, reason: "blocked" });

/** Allow everything. */
const allowAll = (): PermissionDecision => ({ allow: true });

/** Allow only connect to specific hostnames. */
function allowHosts(...hosts: string[]) {
	return (req: NetworkAccessRequest): PermissionDecision => {
		if (req.op === "connect" && req.hostname && hosts.includes(req.hostname)) {
			return { allow: true };
		}
		if (req.op === "listen") {
			return { allow: true };
		}
		return { allow: false, reason: `host not in allow-list` };
	};
}

/** Allow listen only on specific ports. */
function allowListenPorts(...ports: number[]) {
	return (req: NetworkAccessRequest): PermissionDecision => {
		if (req.op === "listen") {
			return { allow: true };
		}
		if (req.op === "connect") {
			return { allow: true };
		}
		return { allow: false };
	};
}

/** Deny listen, allow connect. */
const denyListen = (req: NetworkAccessRequest): PermissionDecision => {
	if (req.op === "listen") return { allow: false, reason: "listen denied" };
	return { allow: true };
};

/** Deny connect, allow listen. */
const denyConnect = (req: NetworkAccessRequest): PermissionDecision => {
	if (req.op === "connect") return { allow: false, reason: "connect denied" };
	return { allow: true };
};

// ---------------------------------------------------------------------------
// Helper: create a loopback listener
// ---------------------------------------------------------------------------
async function createListener(table: SocketTable, port: number) {
	const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
	await table.bind(id, { host: "0.0.0.0", port });
	await table.listen(id);
	return id;
}

function createMockHostSocket(): HostSocket {
	return {
		async write() {},
		async read() {
			return null;
		},
		async close() {},
		setOption() {},
		shutdown() {},
	};
}

function createMockHostUdpSocket(): HostUdpSocket {
	return {
		async recv() {
			return new Promise<{
				data: Uint8Array;
				remoteAddr: { host: string; port: number };
			}>(() => {});
		},
		async close() {},
	};
}

function createMockHostListener(port: number): HostListener {
	return {
		port,
		async accept() {
			return new Promise<HostSocket>(() => {});
		},
		async close() {},
	};
}

function createMockHostAdapter(
	overrides?: Partial<HostNetworkAdapter>,
): HostNetworkAdapter {
	return {
		async tcpConnect() {
			return createMockHostSocket();
		},
		async tcpListen(_host: string, port: number) {
			return createMockHostListener(port);
		},
		async udpBind() {
			return createMockHostUdpSocket();
		},
		async udpSend() {},
		async dnsLookup(): Promise<DnsResult> {
			return { address: "127.0.0.1", family: 4 };
		},
		...overrides,
	};
}

function createMockDriverProcess(): DriverProcess {
	let resolveExit: (code: number) => void;
	const exitPromise = new Promise<number>((resolve) => {
		resolveExit = resolve;
	});

	return {
		writeStdin() {},
		closeStdin() {},
		kill(signal) {
			resolveExit(128 + signal);
		},
		wait() {
			return exitPromise;
		},
		onStdout: null,
		onStderr: null,
		onExit: null,
	};
}

function registerKernelPid(kernel: Kernel, ppid = 0): number {
	const internal = kernel as any;
	const pid = internal.processTable.allocatePid();
	internal.processTable.register(
		pid,
		"test",
		"test",
		[],
		{
			pid,
			ppid,
			env: {},
			cwd: "/",
			fds: { stdin: 0, stdout: 1, stderr: 2 },
		},
		createMockDriverProcess(),
	);
	return pid;
}

describe("Network permissions", () => {
	// -------------------------------------------------------------------
	// checkNetworkPermission (public method)
	// -------------------------------------------------------------------

	describe("checkNetworkPermission()", () => {
		it("throws EACCES when no policy is configured", () => {
			const table = new SocketTable();
			expect(() =>
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 }),
			).toThrow(KernelError);
			try {
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 });
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
			}
		});

		it("throws EACCES when policy denies", () => {
			const table = new SocketTable({ networkCheck: denyAll });
			expect(() =>
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 }),
			).toThrow(KernelError);
			try {
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 });
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
				expect((e as KernelError).message).toContain("blocked");
			}
		});

		it("passes when policy allows", () => {
			const table = new SocketTable({ networkCheck: allowAll });
			expect(() =>
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 }),
			).not.toThrow();
		});

		it("includes hostname in request passed to checker", () => {
			let captured: NetworkAccessRequest | undefined;
			const table = new SocketTable({
				networkCheck: (req) => {
					captured = req;
					return { allow: true };
				},
			});
			table.checkNetworkPermission("connect", {
				host: "example.com",
				port: 443,
			});
			expect(captured?.op).toBe("connect");
			expect(captured?.hostname).toBe("example.com");
		});
	});

	// -------------------------------------------------------------------
	// connect() — loopback always allowed
	// -------------------------------------------------------------------

	describe("connect() — loopback always allowed", () => {
		it("allows loopback connect even when external connect is denied", async () => {
			const table = new SocketTable({ networkCheck: denyConnect });
			const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(listenId, { host: "0.0.0.0", port: 7070 });
			await table.listen(listenId);

			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			// Should NOT throw — loopback is always allowed
			await table.connect(clientId, { host: "127.0.0.1", port: 7070 });

			const serverId = table.accept(listenId);
			expect(serverId).not.toBeNull();
		});

		it("allows loopback data exchange when external connect is denied", async () => {
			const table = new SocketTable({ networkCheck: denyConnect });
			const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(listenId, { host: "0.0.0.0", port: 7071 });
			await table.listen(listenId);

			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.connect(clientId, { host: "127.0.0.1", port: 7071 });
			const serverId = table.accept(listenId)!;

			const data = new TextEncoder().encode("hello");
			table.send(clientId, data);
			const received = table.recv(serverId, 1024);
			expect(received).not.toBeNull();
			expect(new TextDecoder().decode(received!)).toBe("hello");
		});
	});

	describe("AF_UNIX sockets stay in-kernel", () => {
		it("allows Unix bind/listen/connect without a network permission policy", async () => {
			const table = new SocketTable();
			const listenId = table.create(AF_UNIX, SOCK_STREAM, 0, 1);
			await table.bind(listenId, { path: "/tmp/kernel.sock" });
			await table.listen(listenId);

			const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
			await table.connect(clientId, { path: "/tmp/kernel.sock" });

			const serverId = table.accept(listenId);
			expect(serverId).not.toBeNull();
		});
	});

	// -------------------------------------------------------------------
	// connect() — external addresses check permission
	// -------------------------------------------------------------------

	describe("connect() — external addresses", () => {
		it("throws EACCES for external connect with deny-all policy", async () => {
			const table = new SocketTable({ networkCheck: denyAll });
			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			try {
				await table.connect(clientId, { host: "93.184.216.34", port: 80 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(KernelError);
				expect((e as KernelError).code).toBe("EACCES");
			}
		});

		it("throws ECONNREFUSED for external connect with allow-all policy (no host adapter)", async () => {
			const table = new SocketTable({ networkCheck: allowAll });
			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			// Permission passes, but no host adapter → ECONNREFUSED
			try {
				await table.connect(clientId, { host: "93.184.216.34", port: 80 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(KernelError);
				expect((e as KernelError).code).toBe("ECONNREFUSED");
			}
		});

		it("allow-list permits specific hosts", async () => {
			const table = new SocketTable({
				networkCheck: allowHosts("api.example.com"),
			});

			// Allowed host — passes permission but no adapter → ECONNREFUSED
			const s1 = table.create(AF_INET, SOCK_STREAM, 0, 1);
			try {
				await table.connect(s1, { host: "api.example.com", port: 443 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as KernelError).code).toBe("ECONNREFUSED");
			}

			// Denied host — EACCES
			const s2 = table.create(AF_INET, SOCK_STREAM, 0, 1);
			try {
				await table.connect(s2, { host: "evil.example.com", port: 443 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
			}
		});

		it("throws EACCES for external connect when no policy is configured", async () => {
			const table = new SocketTable();
			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			try {
				await table.connect(clientId, { host: "93.184.216.34", port: 80 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
			}
		});
	});

	// -------------------------------------------------------------------
	// listen() — permission check
	// -------------------------------------------------------------------

	describe("listen() — permission check", () => {
		it("throws EACCES when listen is denied", async () => {
			const table = new SocketTable({ networkCheck: denyListen });
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(id, { host: "0.0.0.0", port: 8080 });
			try {
				await table.listen(id);
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(KernelError);
				expect((e as KernelError).code).toBe("EACCES");
				expect((e as KernelError).message).toContain("listen denied");
			}
		});

		it("allows listen when policy permits", async () => {
			const table = new SocketTable({ networkCheck: allowAll });
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(id, { host: "0.0.0.0", port: 8080 });
			await table.listen(id);
			expect(table.get(id)!.state).toBe("listening");
		});

		it("throws EACCES for listen when no policy is configured", async () => {
			const table = new SocketTable();
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(id, { host: "0.0.0.0", port: 8080 });
			await expect(table.listen(id)).rejects.toMatchObject({ code: "EACCES" });
		});

		it("passes local address to permission checker", async () => {
			let captured: NetworkAccessRequest | undefined;
			const table = new SocketTable({
				networkCheck: (req) => {
					captured = req;
					return { allow: true };
				},
			});
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(id, { host: "0.0.0.0", port: 9090 });
			await table.listen(id);
			expect(captured?.op).toBe("listen");
			expect(captured?.hostname).toBe("0.0.0.0");
		});
	});

	// -------------------------------------------------------------------
	// send() — external socket permission check
	// -------------------------------------------------------------------

	describe("send() — external socket permission check", () => {
		it("throws EACCES on send to external socket when no policy is configured", () => {
			const hostSocketWrites: Uint8Array[] = [];
			const table = new SocketTable({
				hostAdapter: createMockHostAdapter(),
			});

			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			const sock = table.get(id)!;
			sock.state = "connected";
			sock.external = true;
			sock.remoteAddr = { host: "evil.com", port: 80 };
			sock.hostSocket = {
				async write(data: Uint8Array) {
					hostSocketWrites.push(data);
				},
				async read() {
					return null;
				},
				async close() {},
				setOption() {},
				shutdown() {},
			};

			expect(() => table.send(id, new Uint8Array([1, 2, 3]))).toThrow(
				KernelError,
			);
			expect(hostSocketWrites).toHaveLength(0);
		});

		it("throws EACCES on send to external socket when denied", () => {
			const table = new SocketTable({ networkCheck: denyConnect });

			// Create a socket and manually mark it as externally connected
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			const sock = table.get(id)!;
			sock.state = "connected";
			sock.external = true;
			sock.remoteAddr = { host: "evil.com", port: 80 };
			sock.peerId = undefined;

			try {
				table.send(id, new Uint8Array([1, 2, 3]));
				expect.unreachable("should have thrown");
			} catch (e) {
				expect(e).toBeInstanceOf(KernelError);
				expect((e as KernelError).code).toBe("EACCES");
			}
		});

		it("allows send on loopback socket regardless of connect policy", async () => {
			const table = new SocketTable({ networkCheck: denyConnect });
			const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(listenId, { host: "0.0.0.0", port: 7075 });
			await table.listen(listenId);

			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.connect(clientId, { host: "127.0.0.1", port: 7075 });

			// Loopback socket — external flag not set
			const client = table.get(clientId)!;
			expect(client.external).toBeFalsy();

			const data = new TextEncoder().encode("ok");
			expect(() => table.send(clientId, data)).not.toThrow();
		});
	});

	// -------------------------------------------------------------------
	// sendTo() — external socket permission check
	// -------------------------------------------------------------------

	describe("sendTo() — external socket permission check", () => {
		it("throws EACCES on external sendTo when no policy is configured", () => {
			let udpSendCalls = 0;
			const table = new SocketTable({
				hostAdapter: createMockHostAdapter({
					async udpSend() {
						udpSendCalls += 1;
					},
				}),
			});

			const id = table.create(AF_INET, SOCK_DGRAM, 0, 1);
			const sock = table.get(id)!;
			sock.state = "bound";
			sock.hostUdpSocket = createMockHostUdpSocket();

			expect(() =>
				table.sendTo(id, new Uint8Array([1, 2, 3]), 0, {
					host: "8.8.8.8",
					port: 53,
				}),
			).toThrow(KernelError);
			expect(udpSendCalls).toBe(0);
		});
	});

	// -------------------------------------------------------------------
	// external listen() — host-backed listen still checks permission
	// -------------------------------------------------------------------

	describe("listen() — external host-backed listen", () => {
		it("throws EACCES before touching the host adapter when no policy is configured", async () => {
			let listenCalls = 0;
			const table = new SocketTable({
				hostAdapter: createMockHostAdapter({
					async tcpListen(host: string, port: number) {
						listenCalls += 1;
						return createMockHostListener(port);
					},
				}),
			});

			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(id, { host: "0.0.0.0", port: 8082 });
			await expect(
				table.listen(id, 128, { external: true }),
			).rejects.toMatchObject({
				code: "EACCES",
			});
			expect(listenCalls).toBe(0);
		});
	});

	// -------------------------------------------------------------------
	// Integration: deny-by-default end-to-end
	// -------------------------------------------------------------------

	describe("deny-by-default end-to-end", () => {
		it("blocks external connect, allows loopback connect+send+recv", async () => {
			const table = new SocketTable({ networkCheck: denyConnect });

			// Set up a loopback listener
			const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(listenId, { host: "0.0.0.0", port: 7080 });
			await table.listen(listenId);

			// Loopback connect — always allowed
			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.connect(clientId, { host: "127.0.0.1", port: 7080 });
			const serverId = table.accept(listenId)!;

			// Data exchange works on loopback
			table.send(clientId, new TextEncoder().encode("ping"));
			const pong = table.recv(serverId, 1024);
			expect(new TextDecoder().decode(pong!)).toBe("ping");

			// External connect — blocked by policy
			const extId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			try {
				await table.connect(extId, { host: "8.8.8.8", port: 53 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
			}
		});
	});

	// -------------------------------------------------------------------
	// createKernel() — kernel wiring for network permissions
	// -------------------------------------------------------------------

	describe("createKernel() network permission wiring", () => {
		it("denies external connect by default when kernel permissions omit network", async () => {
			const { kernel } = await createTestKernel({ permissions: {} });
			const clientPid = registerKernelPid(kernel);
			const clientId = kernel.socketTable.create(
				AF_INET,
				SOCK_STREAM,
				0,
				clientPid,
			);

			await expect(
				kernel.socketTable.connect(clientId, {
					host: "93.184.216.34",
					port: 80,
				}),
			).rejects.toMatchObject({ code: "EACCES" });

			await kernel.dispose();
		});

		it("denies listen by default when kernel permissions omit network", async () => {
			const { kernel } = await createTestKernel({ permissions: {} });
			const listenPid = registerKernelPid(kernel);
			const listenId = kernel.socketTable.create(
				AF_INET,
				SOCK_STREAM,
				0,
				listenPid,
			);
			await kernel.socketTable.bind(listenId, { host: "0.0.0.0", port: 9090 });

			await expect(kernel.socketTable.listen(listenId)).rejects.toMatchObject({
				code: "EACCES",
			});

			await kernel.dispose();
		});

		it("still allows loopback routing when the kernel policy only denies external connect", async () => {
			const { kernel } = await createTestKernel({
				permissions: { network: denyConnect },
			});
			const serverPid = registerKernelPid(kernel);
			const clientPid = registerKernelPid(kernel);

			const listenId = kernel.socketTable.create(
				AF_INET,
				SOCK_STREAM,
				0,
				serverPid,
			);
			await kernel.socketTable.bind(listenId, { host: "0.0.0.0", port: 9091 });
			await kernel.socketTable.listen(listenId);

			const clientId = kernel.socketTable.create(
				AF_INET,
				SOCK_STREAM,
				0,
				clientPid,
			);
			await kernel.socketTable.connect(clientId, {
				host: "127.0.0.1",
				port: 9091,
			});
			const serverId = kernel.socketTable.accept(listenId);

			expect(serverId).not.toBeNull();
			kernel.socketTable.send(clientId, new TextEncoder().encode("loopback"));
			const received = kernel.socketTable.recv(serverId!, 1024);
			expect(new TextDecoder().decode(received!)).toBe("loopback");

			await kernel.dispose();
		});
	});
});
