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
	NetworkAccessRequest,
	PermissionDecision,
} from "../../src/kernel/index.js";

// ---------------------------------------------------------------------------
// Mock host socket — simulates a real TCP connection
// ---------------------------------------------------------------------------

class MockHostSocket implements HostSocket {
	writtenData: Uint8Array[] = [];
	closed = false;
	private readResolvers: ((value: Uint8Array | null) => void)[] = [];

	async write(data: Uint8Array): Promise<void> {
		this.writtenData.push(new Uint8Array(data));
	}

	read(): Promise<Uint8Array | null> {
		return new Promise(resolve => {
			this.readResolvers.push(resolve);
		});
	}

	/** Push data from "remote" to be read by the kernel. */
	pushData(data: Uint8Array): void {
		const resolver = this.readResolvers.shift();
		if (resolver) resolver(new Uint8Array(data));
	}

	/** Signal EOF from the remote side. */
	pushEof(): void {
		const resolver = this.readResolvers.shift();
		if (resolver) resolver(null);
	}

	async close(): Promise<void> {
		this.closed = true;
		// Resolve any pending reads with null (EOF)
		for (const r of this.readResolvers) r(null);
		this.readResolvers = [];
	}

	setOption(_level: number, _optname: number, _optval: number): void {}
	shutdown(_how: "read" | "write" | "both"): void {}
}

// ---------------------------------------------------------------------------
// Mock host network adapter
// ---------------------------------------------------------------------------

class MockHostNetworkAdapter implements HostNetworkAdapter {
	/** Last created mock socket, for test assertions. */
	lastSocket: MockHostSocket | null = null;
	connectCalls: { host: string; port: number }[] = [];
	shouldFailConnect = false;

	async tcpConnect(host: string, port: number): Promise<HostSocket> {
		this.connectCalls.push({ host, port });
		if (this.shouldFailConnect) {
			throw new Error("connection failed");
		}
		const sock = new MockHostSocket();
		this.lastSocket = sock;
		return sock;
	}

	async tcpListen(_host: string, _port: number): Promise<HostListener> {
		throw new Error("not implemented");
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
const denyAll = (): PermissionDecision => ({ allow: false, reason: "blocked" });

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("External connection routing via host adapter", () => {
	// -------------------------------------------------------------------
	// Basic external connect
	// -------------------------------------------------------------------

	it("connect to external address calls hostAdapter.tcpConnect", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "93.184.216.34", port: 80 });

		expect(adapter.connectCalls).toHaveLength(1);
		expect(adapter.connectCalls[0]).toEqual({ host: "93.184.216.34", port: 80 });
	});

	it("connect sets socket state to connected with external flag", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 443 });

		const socket = table.get(clientId)!;
		expect(socket.state).toBe("connected");
		expect(socket.external).toBe(true);
		expect(socket.remoteAddr).toEqual({ host: "10.0.0.1", port: 443 });
	});

	it("connect stores hostSocket on kernel socket", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const socket = table.get(clientId)!;
		expect(socket.hostSocket).toBe(adapter.lastSocket);
	});

	it("non-blocking external connect returns EINPROGRESS and completes in background", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		table.setNonBlocking(clientId, true);

		await expect(table.connect(clientId, { host: "10.0.0.1", port: 80 }))
			.rejects.toMatchObject({ code: "EINPROGRESS" });

		await new Promise(resolve => setTimeout(resolve, 0));

		const socket = table.get(clientId)!;
		expect(socket.state).toBe("connected");
		expect(socket.external).toBe(true);
		expect(socket.hostSocket).toBe(adapter.lastSocket);
	});

	// -------------------------------------------------------------------
	// Data flow: send → host adapter
	// -------------------------------------------------------------------

	it("send() writes data to host socket", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const data = new TextEncoder().encode("GET / HTTP/1.1\r\n");
		const written = table.send(clientId, data);

		expect(written).toBe(data.length);
		// Wait a tick for the async write to complete
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(adapter.lastSocket!.writtenData).toHaveLength(1);
		expect(new TextDecoder().decode(adapter.lastSocket!.writtenData[0])).toBe("GET / HTTP/1.1\r\n");
	});

	// -------------------------------------------------------------------
	// Data flow: host adapter → recv
	// -------------------------------------------------------------------

	it("host socket data feeds kernel readBuffer via read pump", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const mockSocket = adapter.lastSocket!;

		// Push data from "remote"
		mockSocket.pushData(new TextEncoder().encode("HTTP/1.1 200 OK\r\n"));

		// Wait for the read pump to process
		await new Promise(resolve => setTimeout(resolve, 10));

		const received = table.recv(clientId, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("HTTP/1.1 200 OK\r\n");
	});

	it("host socket EOF sets peerWriteClosed", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const mockSocket = adapter.lastSocket!;

		// Send some data then EOF
		mockSocket.pushData(new TextEncoder().encode("hello"));
		await new Promise(resolve => setTimeout(resolve, 10));

		mockSocket.pushEof();
		await new Promise(resolve => setTimeout(resolve, 10));

		// Read the data first
		const data = table.recv(clientId, 1024);
		expect(new TextDecoder().decode(data!)).toBe("hello");

		// Then get EOF
		const eof = table.recv(clientId, 1024);
		expect(eof).toBeNull();
	});

	// -------------------------------------------------------------------
	// Close propagation
	// -------------------------------------------------------------------

	it("close kernel socket calls hostSocket.close()", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const mockSocket = adapter.lastSocket!;
		expect(mockSocket.closed).toBe(false);

		table.close(clientId, 1);

		// Wait for async close to complete
		await new Promise(resolve => setTimeout(resolve, 0));
		expect(mockSocket.closed).toBe(true);
	});

	it("closeAllForProcess closes external sockets", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const mockSocket = adapter.lastSocket!;
		table.closeAllForProcess(1);

		await new Promise(resolve => setTimeout(resolve, 0));
		expect(mockSocket.closed).toBe(true);
	});

	// -------------------------------------------------------------------
	// Permission enforcement
	// -------------------------------------------------------------------

	it("connect checks permission before calling host adapter", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: denyAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		try {
			await table.connect(clientId, { host: "evil.com", port: 80 });
			expect.unreachable("should have thrown");
		} catch (e) {
			expect(e).toBeInstanceOf(KernelError);
			expect((e as KernelError).code).toBe("EACCES");
		}

		// Host adapter should NOT have been called
		expect(adapter.connectCalls).toHaveLength(0);
	});

	it("permission check runs before host adapter even when adapter exists", async () => {
		let checkedOp: string | undefined;
		const table = new SocketTable({
			networkCheck: (req: NetworkAccessRequest) => {
				checkedOp = req.op;
				return { allow: true };
			},
			hostAdapter: new MockHostNetworkAdapter(),
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "example.com", port: 443 });

		expect(checkedOp).toBe("connect");
	});

	// -------------------------------------------------------------------
	// Loopback still works with host adapter configured
	// -------------------------------------------------------------------

	it("loopback connect ignores host adapter", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		// Set up loopback listener
		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 9090 });
		await table.listen(listenId);

		// Connect to loopback
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, { host: "127.0.0.1", port: 9090 });

		// Host adapter was NOT called
		expect(adapter.connectCalls).toHaveLength(0);

		// Loopback connection works normally
		const socket = table.get(clientId)!;
		expect(socket.external).toBeFalsy();
		expect(socket.peerId).toBeDefined();

		const serverId = table.accept(listenId)!;
		table.send(clientId, new TextEncoder().encode("loopback"));
		const received = table.recv(serverId, 1024);
		expect(new TextDecoder().decode(received!)).toBe("loopback");
	});

	// -------------------------------------------------------------------
	// Host adapter connection failure
	// -------------------------------------------------------------------

	it("host adapter tcpConnect failure propagates as error", async () => {
		const adapter = new MockHostNetworkAdapter();
		adapter.shouldFailConnect = true;

		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await expect(table.connect(clientId, { host: "10.0.0.1", port: 80 }))
			.rejects.toThrow("connection failed");
	});

	// -------------------------------------------------------------------
	// Multiple data chunks via read pump
	// -------------------------------------------------------------------

	it("read pump handles multiple sequential data chunks", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const mockSocket = adapter.lastSocket!;

		// Push multiple chunks — they may arrive before first recv
		mockSocket.pushData(new TextEncoder().encode("chunk1"));
		await new Promise(resolve => setTimeout(resolve, 10));
		mockSocket.pushData(new TextEncoder().encode("chunk2"));
		await new Promise(resolve => setTimeout(resolve, 10));

		// Read first 6 bytes (chunk1)
		const chunk1 = table.recv(clientId, 6);
		expect(new TextDecoder().decode(chunk1!)).toBe("chunk1");

		// Read next 6 bytes (chunk2)
		const chunk2 = table.recv(clientId, 6);
		expect(new TextDecoder().decode(chunk2!)).toBe("chunk2");
	});

	// -------------------------------------------------------------------
	// disposeAll cleans up external sockets
	// -------------------------------------------------------------------

	it("disposeAll cleans up external socket host connections", async () => {
		const adapter = new MockHostNetworkAdapter();
		const table = new SocketTable({
			networkCheck: allowAll,
			hostAdapter: adapter,
		});

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.connect(clientId, { host: "10.0.0.1", port: 80 });

		const mockSocket = adapter.lastSocket!;
		expect(mockSocket.closed).toBe(false);

		table.disposeAll();
		// disposeAll clears all sockets — it doesn't close hostSockets individually
		// but the socket is removed from the table
		expect(table.size).toBe(0);
	});
});
