import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_INET,
	SOCK_STREAM,
	KernelError,
} from "../../src/kernel/index.js";
import type {
	HostNetworkAdapter,
	HostSocket,
	HostListener,
	HostUdpSocket,
	DnsResult,
	PermissionDecision,
} from "../../src/kernel/index.js";

// ---------------------------------------------------------------------------
// Mock host socket — simulates a real TCP connection
// ---------------------------------------------------------------------------

class MockHostSocket implements HostSocket {
	writtenData: Uint8Array[] = [];
	closed = false;
	shutdownCalls: Array<"read" | "write" | "both"> = [];
	private readResolvers: ((value: Uint8Array | null) => void)[] = [];

	async write(data: Uint8Array): Promise<void> {
		this.writtenData.push(new Uint8Array(data));
	}

	read(): Promise<Uint8Array | null> {
		return new Promise(resolve => {
			this.readResolvers.push(resolve);
		});
	}

	pushData(data: Uint8Array): void {
		const resolver = this.readResolvers.shift();
		if (resolver) resolver(new Uint8Array(data));
	}

	pushEof(): void {
		const resolver = this.readResolvers.shift();
		if (resolver) resolver(null);
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const r of this.readResolvers) r(null);
		this.readResolvers = [];
	}

	setOption(_level: number, _optname: number, _optval: number): void {}
	shutdown(how: "read" | "write" | "both"): void {
		this.shutdownCalls.push(how);
	}
}

// ---------------------------------------------------------------------------
// Mock host listener — simulates a real TCP server
// ---------------------------------------------------------------------------

class MockHostListener implements HostListener {
	closed = false;
	readonly port: number;
	private acceptResolvers: ((value: HostSocket) => void)[] = [];
	private acceptRejects: ((reason: Error) => void)[] = [];

	constructor(port: number) {
		this.port = port;
	}

	accept(): Promise<HostSocket> {
		return new Promise((resolve, reject) => {
			this.acceptResolvers.push(resolve);
			this.acceptRejects.push(reject);
		});
	}

	/** Simulate an incoming connection from the outside. */
	pushConnection(hostSocket: MockHostSocket): void {
		const resolver = this.acceptResolvers.shift();
		this.acceptRejects.shift();
		if (resolver) resolver(hostSocket);
	}

	async close(): Promise<void> {
		this.closed = true;
		// Reject any pending accepts
		for (const reject of this.acceptRejects) {
			reject(new Error("listener closed"));
		}
		this.acceptResolvers = [];
		this.acceptRejects = [];
	}
}

// ---------------------------------------------------------------------------
// Mock host network adapter
// ---------------------------------------------------------------------------

class MockHostNetworkAdapter implements HostNetworkAdapter {
	lastListener: MockHostListener | null = null;
	listenCalls: { host: string; port: number }[] = [];
	shouldFailListen = false;
	/** Port returned by the mock listener (for ephemeral port testing). */
	assignedPort?: number;

	async tcpConnect(_host: string, _port: number): Promise<HostSocket> {
		throw new Error("not implemented");
	}

	async tcpListen(host: string, port: number): Promise<HostListener> {
		this.listenCalls.push({ host, port });
		if (this.shouldFailListen) {
			throw new Error("listen failed");
		}
		const actualPort = this.assignedPort ?? (port === 0 ? 49152 : port);
		const listener = new MockHostListener(actualPort);
		this.lastListener = listener;
		return listener;
	}

	async udpBind(_host: string, _port: number): Promise<HostUdpSocket> {
		throw new Error("not implemented");
	}

	async udpSend(_socket: HostUdpSocket, _data: Uint8Array, _host: string, _port: number): Promise<void> {
		throw new Error("not implemented");
	}

	async dnsLookup(_hostname: string, _rrtype: string): Promise<DnsResult> {
		throw new Error("not implemented");
	}
}

// ---------------------------------------------------------------------------
// Permission helpers
// ---------------------------------------------------------------------------

const allowAll = (): PermissionDecision => ({ allow: true });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("External server socket routing via host adapter", () => {
	// -------------------------------------------------------------------
	// Basic external listen
	// -------------------------------------------------------------------

	it("listen with external flag calls hostAdapter.tcpListen", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		expect(adapter.listenCalls).toHaveLength(1);
		expect(adapter.listenCalls[0]).toEqual({ host: "0.0.0.0", port: 8080 });
	});

	it("listen with external flag sets socket state to listening", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const socket = table.get(listenId)!;
		expect(socket.state).toBe("listening");
		expect(socket.external).toBe(true);
		expect(socket.hostListener).toBe(adapter.lastListener);
	});

	it("listen without external flag does not call host adapter", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId);

		expect(adapter.listenCalls).toHaveLength(0);
		expect(table.get(listenId)!.external).toBeFalsy();
	});

	// -------------------------------------------------------------------
	// Ephemeral port (port 0)
	// -------------------------------------------------------------------

	it("ephemeral port 0 updates localAddr with actual port from host listener", async () => {
		const adapter = new MockHostNetworkAdapter();
		adapter.assignedPort = 54321;
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 0 });
		await table.listen(listenId, 128, { external: true });

		const socket = table.get(listenId)!;
		expect(socket.localAddr).toEqual({ host: "0.0.0.0", port: 54321 });
	});

	it("ephemeral port updates listener map so findListener works", async () => {
		const adapter = new MockHostNetworkAdapter();
		adapter.assignedPort = 54322;
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 0 });
		await table.listen(listenId, 128, { external: true });

		// Should be findable by the assigned port
		const found = table.findListener({ host: "127.0.0.1", port: 54322 });
		expect(found).not.toBeNull();
		expect(found!.id).toBe(listenId);

		// Old port 0 key should be gone
		const old = table.findListener({ host: "0.0.0.0", port: 0 });
		expect(old).toBeNull();
	});

	// -------------------------------------------------------------------
	// Accept pump: incoming connections feed kernel backlog
	// -------------------------------------------------------------------

	it("incoming host connection appears in kernel backlog via accept pump", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const hostListener = adapter.lastListener!;

		// Simulate incoming connection
		const incomingSocket = new MockHostSocket();
		hostListener.pushConnection(incomingSocket);

		// Wait for accept pump to process
		await new Promise(resolve => setTimeout(resolve, 10));

		// Accept from kernel
		const connId = table.accept(listenId);
		expect(connId).not.toBeNull();

		const conn = table.get(connId!)!;
		expect(conn.state).toBe("connected");
		expect(conn.external).toBe(true);
		expect(conn.hostSocket).toBe(incomingSocket);
	});

	// -------------------------------------------------------------------
	// Data exchange through accepted external connection
	// -------------------------------------------------------------------

	it("send data to accepted external socket writes to host socket", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const incomingSocket = new MockHostSocket();
		adapter.lastListener!.pushConnection(incomingSocket);
		await new Promise(resolve => setTimeout(resolve, 10));

		const connId = table.accept(listenId)!;

		// Send data — should write to host socket
		const data = new TextEncoder().encode("HTTP/1.1 200 OK\r\n");
		table.send(connId, data);

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(incomingSocket.writtenData).toHaveLength(1);
		expect(new TextDecoder().decode(incomingSocket.writtenData[0])).toBe("HTTP/1.1 200 OK\r\n");
	});

	it("shutdown('write') on accepted external socket signals EOF to the host socket", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const incomingSocket = new MockHostSocket();
		adapter.lastListener!.pushConnection(incomingSocket);
		await new Promise(resolve => setTimeout(resolve, 10));

		const connId = table.accept(listenId)!;
		table.shutdown(connId, "write");

		expect(incomingSocket.shutdownCalls).toEqual(["write"]);
	});

	it("host socket data feeds kernel readBuffer on accepted connection", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const incomingSocket = new MockHostSocket();
		adapter.lastListener!.pushConnection(incomingSocket);
		await new Promise(resolve => setTimeout(resolve, 10));

		const connId = table.accept(listenId)!;

		// Push data from the "remote" client
		incomingSocket.pushData(new TextEncoder().encode("GET / HTTP/1.1\r\n"));
		await new Promise(resolve => setTimeout(resolve, 10));

		const received = table.recv(connId, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("GET / HTTP/1.1\r\n");
	});

	// -------------------------------------------------------------------
	// Multiple incoming connections
	// -------------------------------------------------------------------

	it("accept pump handles multiple incoming connections", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const hostListener = adapter.lastListener!;

		// First incoming connection
		const sock1 = new MockHostSocket();
		hostListener.pushConnection(sock1);
		await new Promise(resolve => setTimeout(resolve, 10));

		// Second incoming connection
		const sock2 = new MockHostSocket();
		hostListener.pushConnection(sock2);
		await new Promise(resolve => setTimeout(resolve, 10));

		const connId1 = table.accept(listenId);
		const connId2 = table.accept(listenId);
		expect(connId1).not.toBeNull();
		expect(connId2).not.toBeNull();
		expect(connId1).not.toBe(connId2);

		// Each has its own host socket
		expect(table.get(connId1!)!.hostSocket).toBe(sock1);
		expect(table.get(connId2!)!.hostSocket).toBe(sock2);
	});

	// -------------------------------------------------------------------
	// Close propagation
	// -------------------------------------------------------------------

	it("close listener calls hostListener.close()", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const hostListener = adapter.lastListener!;
		expect(hostListener.closed).toBe(false);

		table.close(listenId, 1);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(hostListener.closed).toBe(true);
	});

	it("close accepted socket calls its hostSocket.close()", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const incomingSocket = new MockHostSocket();
		adapter.lastListener!.pushConnection(incomingSocket);
		await new Promise(resolve => setTimeout(resolve, 10));

		const connId = table.accept(listenId)!;
		table.close(connId, 1);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(incomingSocket.closed).toBe(true);
	});

	it("closeAllForProcess closes both listener and accepted sockets", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const hostListener = adapter.lastListener!;

		const incomingSocket = new MockHostSocket();
		hostListener.pushConnection(incomingSocket);
		await new Promise(resolve => setTimeout(resolve, 10));

		// Accept creates socket owned by same pid
		table.accept(listenId);

		table.closeAllForProcess(1);
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(hostListener.closed).toBe(true);
		expect(incomingSocket.closed).toBe(true);
	});

	// -------------------------------------------------------------------
	// Host adapter listen failure
	// -------------------------------------------------------------------

	it("host adapter tcpListen failure propagates as error", async () => {
		const adapter = new MockHostNetworkAdapter();
		adapter.shouldFailListen = true;

		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await expect(table.listen(listenId, 128, { external: true }))
			.rejects.toThrow("listen failed");
	});

	// -------------------------------------------------------------------
	// disposeAll cleans up external listeners
	// -------------------------------------------------------------------

	it("disposeAll closes host listeners", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 8080 });
		await table.listen(listenId, 128, { external: true });

		const hostListener = adapter.lastListener!;
		expect(hostListener.closed).toBe(false);

		table.disposeAll();
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(hostListener.closed).toBe(true);
		expect(table.size).toBe(0);
	});
});
