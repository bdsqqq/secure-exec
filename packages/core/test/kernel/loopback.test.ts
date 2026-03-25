import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_INET,
	SOCK_STREAM,
	KernelError,
	type InetAddr,
} from "../../src/kernel/index.js";

/**
 * Helper: create a SocketTable with a listening server on the given port.
 * Returns { table, listenId, addr }.
 */
async function setupListener(port: number, host = "0.0.0.0") {
	const table = new SocketTable();
	const listenId = table.create(AF_INET, SOCK_STREAM, 0, /* pid */ 1);
	const addr: InetAddr = { host, port };
	await table.bind(listenId, addr);
	await table.listen(listenId);
	return { table, listenId, addr };
}

describe("Loopback TCP routing", () => {
	// -------------------------------------------------------------------
	// connect
	// -------------------------------------------------------------------

	it("connect to a listening socket creates paired sockets", async () => {
		const { table, listenId, addr } = await setupListener(8080);

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, /* pid */ 2);
		await table.connect(clientId, addr);

		const client = table.get(clientId)!;
		expect(client.state).toBe("connected");
		expect(client.remoteAddr).toEqual(addr);
		expect(client.peerId).toBeDefined();

		// Server-side socket was created and queued in backlog
		const serverSockId = table.accept(listenId);
		expect(serverSockId).not.toBeNull();
		const server = table.get(serverSockId!)!;
		expect(server.state).toBe("connected");
		expect(server.peerId).toBe(clientId);
		expect(client.peerId).toBe(serverSockId);
	});

	it("connect to nonexistent listener throws ECONNREFUSED", async () => {
		const table = new SocketTable();
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await expect(table.connect(clientId, { host: "127.0.0.1", port: 9999 }))
			.rejects.toThrow(KernelError);
		try {
			const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
			await table.connect(id, { host: "127.0.0.1", port: 9999 });
		} catch (e) {
			expect((e as KernelError).code).toBe("ECONNREFUSED");
		}
	});

	it("connect on already-connected socket throws EINVAL", async () => {
		const { table, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		await expect(table.connect(clientId, addr)).rejects.toThrow(KernelError);
		try {
			await table.connect(clientId, addr);
		} catch (e) {
			expect((e as KernelError).code).toBe("EINVAL");
		}
	});

	it("connect via wildcard matching (0.0.0.0 listener, 127.0.0.1 connect)", async () => {
		const { table, listenId } = await setupListener(8080, "0.0.0.0");

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, { host: "127.0.0.1", port: 8080 });

		expect(table.get(clientId)!.state).toBe("connected");
		expect(table.accept(listenId)).not.toBeNull();
	});

	it("connect wakes accept waiters on listener", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const listener = table.get(listenId)!;
		const handle = listener.acceptWaiters.enqueue();

		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);

		await handle.wait();
		expect(handle.isSettled).toBe(true);
	});

	// -------------------------------------------------------------------
	// send / recv — bidirectional data exchange
	// -------------------------------------------------------------------

	it("send data from client to server", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		const data = new TextEncoder().encode("hello");
		const written = table.send(clientId, data);
		expect(written).toBe(5);

		const received = table.recv(serverSockId, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("hello");
	});

	it("send data from server to client", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		const data = new TextEncoder().encode("pong");
		table.send(serverSockId, data);

		const received = table.recv(clientId, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("pong");
	});

	it("bidirectional data exchange", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Client → Server
		table.send(clientId, new TextEncoder().encode("ping"));
		const req = table.recv(serverSockId, 1024);
		expect(new TextDecoder().decode(req!)).toBe("ping");

		// Server → Client
		table.send(serverSockId, new TextEncoder().encode("pong"));
		const res = table.recv(clientId, 1024);
		expect(new TextDecoder().decode(res!)).toBe("pong");
	});

	it("send copies data so mutations don't affect buffer", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		const buf = new Uint8Array([1, 2, 3]);
		table.send(clientId, buf);
		buf[0] = 99; // Mutate original

		const received = table.recv(serverSockId, 1024);
		expect(received![0]).toBe(1); // Should be original value
	});

	it("recv with maxBytes limits returned data", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		table.send(clientId, new Uint8Array([1, 2, 3, 4, 5]));

		// Read only 3 bytes
		const first = table.recv(serverSockId, 3);
		expect(first).toEqual(new Uint8Array([1, 2, 3]));

		// Remaining 2 bytes still in buffer
		const rest = table.recv(serverSockId, 1024);
		expect(rest).toEqual(new Uint8Array([4, 5]));
	});

	it("recv returns null when buffer is empty and peer is alive", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		table.accept(listenId);

		// No data sent yet
		const result = table.recv(clientId, 1024);
		expect(result).toBeNull();
	});

	it("send wakes read waiters on peer", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;
		const serverSock = table.get(serverSockId)!;

		const handle = serverSock.readWaiters.enqueue();
		table.send(clientId, new TextEncoder().encode("wake"));

		await handle.wait();
		expect(handle.isSettled).toBe(true);
	});

	it("send on non-connected socket throws ENOTCONN", () => {
		const table = new SocketTable();
		const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
		expect(() => table.send(id, new Uint8Array([1]))).toThrow(KernelError);
		try {
			table.send(id, new Uint8Array([1]));
		} catch (e) {
			expect((e as KernelError).code).toBe("ENOTCONN");
		}
	});

	it("recv on non-connected socket throws ENOTCONN", () => {
		const table = new SocketTable();
		const id = table.create(AF_INET, SOCK_STREAM, 0, 1);
		expect(() => table.recv(id, 1024)).toThrow(KernelError);
		try {
			table.recv(id, 1024);
		} catch (e) {
			expect((e as KernelError).code).toBe("ENOTCONN");
		}
	});

	// -------------------------------------------------------------------
	// EOF propagation on close
	// -------------------------------------------------------------------

	it("close client → server recv gets EOF", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Close client side
		table.close(clientId, 2);

		// Server recv should return null (EOF)
		const result = table.recv(serverSockId, 1024);
		expect(result).toBeNull();
	});

	it("close server → client recv gets EOF", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Close server side
		table.close(serverSockId, 1);

		// Client recv should return null (EOF)
		const result = table.recv(clientId, 1024);
		expect(result).toBeNull();
	});

	it("close one side wakes peer read waiters", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;
		const serverSock = table.get(serverSockId)!;

		const handle = serverSock.readWaiters.enqueue();
		table.close(clientId, 2);

		await handle.wait();
		expect(handle.isSettled).toBe(true);
	});

	it("send to closed peer throws EPIPE", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Close server side
		table.close(serverSockId, 1);

		expect(() => table.send(clientId, new Uint8Array([1]))).toThrow(KernelError);
		try {
			table.send(clientId, new Uint8Array([1]));
		} catch (e) {
			expect((e as KernelError).code).toBe("EPIPE");
		}
	});

	it("buffered data survives peer close (read remaining then EOF)", async () => {
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Send data then close client
		table.send(clientId, new TextEncoder().encode("final"));
		table.close(clientId, 2);

		// Server can still read buffered data
		const data = table.recv(serverSockId, 1024);
		expect(new TextDecoder().decode(data!)).toBe("final");

		// Next recv returns EOF
		const eof = table.recv(serverSockId, 1024);
		expect(eof).toBeNull();
	});

	// -------------------------------------------------------------------
	// Loopback never calls host adapter
	// -------------------------------------------------------------------

	it("loopback connection does not require a host adapter", async () => {
		// The SocketTable has no host adapter reference — loopback is
		// entirely in-kernel. If this test compiles and connects, it
		// proves no host adapter was involved.
		const { table, listenId, addr } = await setupListener(8080);
		const clientId = table.create(AF_INET, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		table.send(clientId, new TextEncoder().encode("loopback"));
		const received = table.recv(serverSockId, 1024);
		expect(new TextDecoder().decode(received!)).toBe("loopback");
	});

	// -------------------------------------------------------------------
	// Multiple connections to the same listener
	// -------------------------------------------------------------------

	it("multiple clients can connect to the same listener", async () => {
		const { table, listenId, addr } = await setupListener(8080);

		const client1 = table.create(AF_INET, SOCK_STREAM, 0, 2);
		const client2 = table.create(AF_INET, SOCK_STREAM, 0, 3);
		await table.connect(client1, addr);
		await table.connect(client2, addr);

		const server1 = table.accept(listenId)!;
		const server2 = table.accept(listenId)!;
		expect(server1).not.toBe(server2);

		// Data is isolated between connections
		table.send(client1, new TextEncoder().encode("from1"));
		table.send(client2, new TextEncoder().encode("from2"));

		expect(new TextDecoder().decode(table.recv(server1, 1024)!)).toBe("from1");
		expect(new TextDecoder().decode(table.recv(server2, 1024)!)).toBe("from2");
	});
});
