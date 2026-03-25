import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_INET,
	SOCK_STREAM,
	KernelError,
} from "../../src/kernel/index.js";
import type {
	NetworkAccessRequest,
	PermissionDecision,
} from "../../src/kernel/index.js";

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

describe("Network permissions", () => {
	// -------------------------------------------------------------------
	// checkNetworkPermission (public method)
	// -------------------------------------------------------------------

	describe("checkNetworkPermission()", () => {
		it("throws EACCES when no policy is configured", () => {
			const table = new SocketTable();
			expect(() => table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 }))
				.toThrow(KernelError);
			try {
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 });
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
			}
		});

		it("throws EACCES when policy denies", () => {
			const table = new SocketTable({ networkCheck: denyAll });
			expect(() => table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 }))
				.toThrow(KernelError);
			try {
				table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 });
			} catch (e) {
				expect((e as KernelError).code).toBe("EACCES");
				expect((e as KernelError).message).toContain("blocked");
			}
		});

		it("passes when policy allows", () => {
			const table = new SocketTable({ networkCheck: allowAll });
			expect(() => table.checkNetworkPermission("connect", { host: "1.2.3.4", port: 80 }))
				.not.toThrow();
		});

		it("includes hostname in request passed to checker", () => {
			let captured: NetworkAccessRequest | undefined;
			const table = new SocketTable({
				networkCheck: (req) => { captured = req; return { allow: true }; },
			});
			table.checkNetworkPermission("connect", { host: "example.com", port: 443 });
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

		it("no policy = no enforcement for external connect", async () => {
			// Without networkCheck, connect() behaves as before (ECONNREFUSED)
			const table = new SocketTable();
			const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
			try {
				await table.connect(clientId, { host: "93.184.216.34", port: 80 });
				expect.unreachable("should have thrown");
			} catch (e) {
				expect((e as KernelError).code).toBe("ECONNREFUSED");
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

		it("no policy = no enforcement for listen", async () => {
			const table = new SocketTable();
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.bind(id, { host: "0.0.0.0", port: 8080 });
			await table.listen(id);
		});

		it("passes local address to permission checker", async () => {
			let captured: NetworkAccessRequest | undefined;
			const table = new SocketTable({
				networkCheck: (req) => { captured = req; return { allow: true }; },
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
});
