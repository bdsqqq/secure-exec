import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_INET,
	SOCK_DGRAM,
	SOCK_STREAM,
	MSG_PEEK,
	MSG_DONTWAIT,
	MAX_DATAGRAM_SIZE,
	MAX_UDP_QUEUE_DEPTH,
	KernelError,
	type InetAddr,
	type HostNetworkAdapter,
	type HostSocket,
	type HostListener,
	type HostUdpSocket,
	type DnsResult,
} from "../../src/kernel/index.js";

// ---------------------------------------------------------------------------
// Mock host adapter for external UDP tests
// ---------------------------------------------------------------------------

class MockHostUdpSocket implements HostUdpSocket {
	private pending: Array<{ data: Uint8Array; remoteAddr: { host: string; port: number } }> = [];
	private waiters: Array<{
		resolve: (val: { data: Uint8Array; remoteAddr: { host: string; port: number } }) => void;
		reject: (err: Error) => void;
	}> = [];
	closed = false;

	async recv(): Promise<{ data: Uint8Array; remoteAddr: { host: string; port: number } }> {
		if (this.closed) throw new Error("socket closed");
		if (this.pending.length > 0) {
			return this.pending.shift()!;
		}
		return new Promise((resolve, reject) => {
			this.waiters.push({ resolve, reject });
		});
	}

	async close(): Promise<void> {
		this.closed = true;
		for (const w of this.waiters) {
			w.reject(new Error("socket closed"));
		}
		this.waiters.length = 0;
	}

	/** Push a datagram into the mock (simulates incoming external data). */
	pushDatagram(data: Uint8Array, host: string, port: number): void {
		const dgram = { data, remoteAddr: { host, port } };
		if (this.waiters.length > 0) {
			this.waiters.shift()!.resolve(dgram);
		} else {
			this.pending.push(dgram);
		}
	}
}

class MockHostNetworkAdapter implements HostNetworkAdapter {
	sentDatagrams: Array<{ data: Uint8Array; host: string; port: number }> = [];
	mockUdpSocket = new MockHostUdpSocket();

	async tcpConnect(): Promise<HostSocket> { throw new Error("not implemented"); }
	async tcpListen(): Promise<HostListener> { throw new Error("not implemented"); }
	async udpBind(): Promise<HostUdpSocket> { return this.mockUdpSocket; }
	async udpSend(_socket: HostUdpSocket, data: Uint8Array, host: string, port: number): Promise<void> {
		this.sentDatagrams.push({ data: new Uint8Array(data), host, port });
	}
	async dnsLookup(): Promise<DnsResult> { throw new Error("not implemented"); }
}

// ---------------------------------------------------------------------------
// Helper: create a SocketTable with a bound UDP socket
// ---------------------------------------------------------------------------

async function setupUdpSocket(port: number, host = "0.0.0.0") {
	const table = new SocketTable();
	const id = table.create(AF_INET, SOCK_DGRAM, 0, /* pid */ 1);
	const addr: InetAddr = { host, port };
	await table.bind(id, addr);
	return { table, id, addr };
}

describe("UDP sockets (SOCK_DGRAM)", () => {
	// -------------------------------------------------------------------
	// Basic sendTo / recvFrom
	// -------------------------------------------------------------------

	it("sendTo delivers datagram to loopback-bound UDP socket", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		await table.bind(sendId, { host: "127.0.0.1", port: 5001 });

		const data = new TextEncoder().encode("hello udp");
		const written = table.sendTo(sendId, data, 0, addr);
		expect(written).toBe(data.length);

		const result = table.recvFrom(recvId, 1024);
		expect(result).not.toBeNull();
		expect(new TextDecoder().decode(result!.data)).toBe("hello udp");
		expect(result!.srcAddr).toEqual({ host: "127.0.0.1", port: 5001 });
	});

	it("recvFrom returns srcAddr from unbound sender (ephemeral)", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		// Not bound — srcAddr defaults to 127.0.0.1:0

		table.sendTo(sendId, new TextEncoder().encode("anon"), 0, addr);
		const result = table.recvFrom(recvId, 1024);
		expect(result).not.toBeNull();
		expect(result!.srcAddr).toEqual({ host: "127.0.0.1", port: 0 });
	});

	it("bidirectional UDP exchange", async () => {
		const { table, id: sock1 } = await setupUdpSocket(5000, "127.0.0.1");
		const sock2 = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		const addr2: InetAddr = { host: "127.0.0.1", port: 5001 };
		await table.bind(sock2, addr2);

		// sock1 → sock2
		table.sendTo(sock1, new TextEncoder().encode("ping"), 0, addr2);
		const r1 = table.recvFrom(sock2, 1024);
		expect(new TextDecoder().decode(r1!.data)).toBe("ping");

		// sock2 → sock1
		table.sendTo(sock2, new TextEncoder().encode("pong"), 0, { host: "127.0.0.1", port: 5000 });
		const r2 = table.recvFrom(sock1, 1024);
		expect(new TextDecoder().decode(r2!.data)).toBe("pong");
	});

	// -------------------------------------------------------------------
	// Message boundary preservation
	// -------------------------------------------------------------------

	it("message boundaries preserved: two sends produce two recvs", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);

		const msg1 = new Uint8Array(100).fill(1);
		const msg2 = new Uint8Array(100).fill(2);
		table.sendTo(sendId, msg1, 0, addr);
		table.sendTo(sendId, msg2, 0, addr);

		const r1 = table.recvFrom(recvId, 1024);
		const r2 = table.recvFrom(recvId, 1024);
		expect(r1!.data.length).toBe(100);
		expect(r1!.data[0]).toBe(1);
		expect(r2!.data.length).toBe(100);
		expect(r2!.data[0]).toBe(2);
	});

	it("datagram truncated when maxBytes < datagram size", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);

		table.sendTo(sendId, new Uint8Array([1, 2, 3, 4, 5]), 0, addr);

		const result = table.recvFrom(recvId, 3);
		expect(result!.data).toEqual(new Uint8Array([1, 2, 3]));

		// Remainder is discarded (not a second datagram)
		const next = table.recvFrom(recvId, 1024);
		expect(next).toBeNull();
	});

	// -------------------------------------------------------------------
	// Silent drop semantics
	// -------------------------------------------------------------------

	it("sendTo to unbound port is silently dropped", () => {
		const table = new SocketTable();
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 1);

		// No socket bound on port 9999 — send should succeed (return bytes) but data is dropped
		const written = table.sendTo(sendId, new TextEncoder().encode("void"), 0, {
			host: "127.0.0.1", port: 9999,
		});
		expect(written).toBe(4);
	});

	it("sendTo drops silently when queue depth exceeds limit", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);

		// Fill the queue
		for (let i = 0; i < MAX_UDP_QUEUE_DEPTH; i++) {
			table.sendTo(sendId, new Uint8Array([i]), 0, addr);
		}

		// This should be silently dropped
		const written = table.sendTo(sendId, new Uint8Array([0xff]), 0, addr);
		expect(written).toBe(1);

		// Queue has exactly MAX_UDP_QUEUE_DEPTH items
		const sock = table.get(recvId)!;
		expect(sock.datagramQueue.length).toBe(MAX_UDP_QUEUE_DEPTH);
	});

	// -------------------------------------------------------------------
	// Max datagram size
	// -------------------------------------------------------------------

	it("sendTo rejects datagrams exceeding MAX_DATAGRAM_SIZE", () => {
		const table = new SocketTable();
		const id = table.create(AF_INET, SOCK_DGRAM, 0, 1);
		const bigData = new Uint8Array(MAX_DATAGRAM_SIZE + 1);

		expect(() => table.sendTo(id, bigData, 0, { host: "127.0.0.1", port: 5000 }))
			.toThrow(KernelError);
		try {
			table.sendTo(id, bigData, 0, { host: "127.0.0.1", port: 5000 });
		} catch (e) {
			expect((e as KernelError).code).toBe("EMSGSIZE");
		}
	});

	it("sendTo accepts datagram at exactly MAX_DATAGRAM_SIZE", async () => {
		const { table, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		const data = new Uint8Array(MAX_DATAGRAM_SIZE);
		const written = table.sendTo(sendId, data, 0, addr);
		expect(written).toBe(MAX_DATAGRAM_SIZE);
	});

	// -------------------------------------------------------------------
	// sendTo copies data
	// -------------------------------------------------------------------

	it("sendTo copies data so mutations don't affect kernel buffer", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);

		const buf = new Uint8Array([1, 2, 3]);
		table.sendTo(sendId, buf, 0, addr);
		buf[0] = 99;

		const result = table.recvFrom(recvId, 1024);
		expect(result!.data[0]).toBe(1);
	});

	// -------------------------------------------------------------------
	// recvFrom returns null when no data
	// -------------------------------------------------------------------

	it("recvFrom returns null when no datagrams queued", async () => {
		const { table, id } = await setupUdpSocket(5000);
		const result = table.recvFrom(id, 1024);
		expect(result).toBeNull();
	});

	// -------------------------------------------------------------------
	// Flags: MSG_PEEK, MSG_DONTWAIT
	// -------------------------------------------------------------------

	it("MSG_PEEK reads datagram without consuming it", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		table.sendTo(sendId, new TextEncoder().encode("peek"), 0, addr);

		const peeked = table.recvFrom(recvId, 1024, MSG_PEEK);
		expect(new TextDecoder().decode(peeked!.data)).toBe("peek");

		// Datagram still there
		const consumed = table.recvFrom(recvId, 1024);
		expect(new TextDecoder().decode(consumed!.data)).toBe("peek");

		// Now empty
		expect(table.recvFrom(recvId, 1024)).toBeNull();
	});

	it("MSG_DONTWAIT throws EAGAIN when no data", async () => {
		const { table, id } = await setupUdpSocket(5000);
		expect(() => table.recvFrom(id, 1024, MSG_DONTWAIT)).toThrow(KernelError);
		try {
			table.recvFrom(id, 1024, MSG_DONTWAIT);
		} catch (e) {
			expect((e as KernelError).code).toBe("EAGAIN");
		}
	});

	// -------------------------------------------------------------------
	// Type enforcement
	// -------------------------------------------------------------------

	it("sendTo on SOCK_STREAM socket throws EINVAL", () => {
		const table = new SocketTable();
		const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
		expect(() => table.sendTo(id, new Uint8Array([1]), 0, { host: "127.0.0.1", port: 5000 }))
			.toThrow(KernelError);
		try {
			table.sendTo(id, new Uint8Array([1]), 0, { host: "127.0.0.1", port: 5000 });
		} catch (e) {
			expect((e as KernelError).code).toBe("EINVAL");
		}
	});

	it("recvFrom on SOCK_STREAM socket throws EINVAL", () => {
		const table = new SocketTable();
		const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
		expect(() => table.recvFrom(id, 1024)).toThrow(KernelError);
		try {
			table.recvFrom(id, 1024);
		} catch (e) {
			expect((e as KernelError).code).toBe("EINVAL");
		}
	});

	// -------------------------------------------------------------------
	// EADDRINUSE for UDP
	// -------------------------------------------------------------------

	it("bind two UDP sockets to same port throws EADDRINUSE", async () => {
		const { table } = await setupUdpSocket(5000);
		const id2 = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		await expect(table.bind(id2, { host: "0.0.0.0", port: 5000 })).rejects.toThrow(KernelError);
		try {
			const id3 = table.create(AF_INET, SOCK_DGRAM, 0, 2);
			await table.bind(id3, { host: "0.0.0.0", port: 5000 });
		} catch (e) {
			expect((e as KernelError).code).toBe("EADDRINUSE");
		}
	});

	it("TCP and UDP can bind to the same port", async () => {
		const table = new SocketTable();
		const tcpId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(tcpId, { host: "0.0.0.0", port: 5000 });

		const udpId = table.create(AF_INET, SOCK_DGRAM, 0, 1);
		// Should NOT throw — TCP and UDP share different binding maps
		await table.bind(udpId, { host: "0.0.0.0", port: 5000 });

		expect(table.get(tcpId)!.state).toBe("bound");
		expect(table.get(udpId)!.state).toBe("bound");
	});

	it("close frees UDP port for reuse", async () => {
		const { table, id } = await setupUdpSocket(5000);
		table.close(id, 1);

		const id2 = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		await table.bind(id2, { host: "0.0.0.0", port: 5000 });
		expect(table.get(id2)!.state).toBe("bound");
	});

	// -------------------------------------------------------------------
	// Wildcard matching
	// -------------------------------------------------------------------

	it("sendTo via wildcard matching (0.0.0.0 listener, 127.0.0.1 send)", async () => {
		const { table, id: recvId } = await setupUdpSocket(5000, "0.0.0.0");
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);

		table.sendTo(sendId, new TextEncoder().encode("wild"), 0, { host: "127.0.0.1", port: 5000 });
		const result = table.recvFrom(recvId, 1024);
		expect(new TextDecoder().decode(result!.data)).toBe("wild");
	});

	// -------------------------------------------------------------------
	// sendTo wakes readWaiters
	// -------------------------------------------------------------------

	it("sendTo wakes read waiters on target socket", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const recvSock = table.get(recvId)!;
		const handle = recvSock.readWaiters.enqueue();

		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);
		table.sendTo(sendId, new TextEncoder().encode("wake"), 0, addr);

		expect(handle.isSettled).toBe(true);
	});

	// -------------------------------------------------------------------
	// Poll
	// -------------------------------------------------------------------

	it("poll reflects UDP readability", async () => {
		const { table, id: recvId, addr } = await setupUdpSocket(5000);
		const sendId = table.create(AF_INET, SOCK_DGRAM, 0, 2);

		// No data — not readable, but writable (bound UDP can send)
		const poll1 = table.poll(recvId);
		expect(poll1.readable).toBe(false);
		expect(poll1.writable).toBe(true);

		// Send a datagram — now readable
		table.sendTo(sendId, new TextEncoder().encode("data"), 0, addr);
		const poll2 = table.poll(recvId);
		expect(poll2.readable).toBe(true);
	});

	// -------------------------------------------------------------------
	// External UDP routing via mock adapter
	// -------------------------------------------------------------------

	it("bindExternalUdp creates host UDP socket and starts recv pump", async () => {
		const mockAdapter = new MockHostNetworkAdapter();
		const table = new SocketTable({ hostAdapter: mockAdapter });

		const id = table.create(AF_INET, SOCK_DGRAM, 0, 1);
		await table.bind(id, { host: "0.0.0.0", port: 5000 });
		await table.bindExternalUdp(id);

		const sock = table.get(id)!;
		expect(sock.external).toBe(true);
		expect(sock.hostUdpSocket).toBe(mockAdapter.mockUdpSocket);
	});

	it("external recv pump feeds datagrams into kernel queue", async () => {
		const mockAdapter = new MockHostNetworkAdapter();
		const table = new SocketTable({ hostAdapter: mockAdapter });

		const id = table.create(AF_INET, SOCK_DGRAM, 0, 1);
		await table.bind(id, { host: "0.0.0.0", port: 5000 });
		await table.bindExternalUdp(id);

		// Simulate incoming external datagram
		mockAdapter.mockUdpSocket.pushDatagram(
			new TextEncoder().encode("external"),
			"10.0.0.1", 9000,
		);

		// Allow pump microtask to run
		await new Promise(r => setTimeout(r, 10));

		const result = table.recvFrom(id, 1024);
		expect(result).not.toBeNull();
		expect(new TextDecoder().decode(result!.data)).toBe("external");
		expect(result!.srcAddr).toEqual({ host: "10.0.0.1", port: 9000 });
	});

	it("sendTo external routes through host adapter udpSend", async () => {
		const mockAdapter = new MockHostNetworkAdapter();
		const table = new SocketTable({ hostAdapter: mockAdapter });

		const id = table.create(AF_INET, SOCK_DGRAM, 0, 1);
		await table.bind(id, { host: "0.0.0.0", port: 5000 });
		await table.bindExternalUdp(id);

		const data = new TextEncoder().encode("outbound");
		table.sendTo(id, data, 0, { host: "10.0.0.2", port: 8000 });

		expect(mockAdapter.sentDatagrams.length).toBe(1);
		expect(new TextDecoder().decode(mockAdapter.sentDatagrams[0].data)).toBe("outbound");
		expect(mockAdapter.sentDatagrams[0].host).toBe("10.0.0.2");
		expect(mockAdapter.sentDatagrams[0].port).toBe(8000);
	});

	it("close external UDP socket calls hostUdpSocket.close()", async () => {
		const mockAdapter = new MockHostNetworkAdapter();
		const table = new SocketTable({ hostAdapter: mockAdapter });

		const id = table.create(AF_INET, SOCK_DGRAM, 0, 1);
		await table.bind(id, { host: "0.0.0.0", port: 5000 });
		await table.bindExternalUdp(id);

		table.close(id, 1);
		expect(mockAdapter.mockUdpSocket.closed).toBe(true);
	});
});
