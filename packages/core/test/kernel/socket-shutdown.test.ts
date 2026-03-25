import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_INET,
	SOCK_STREAM,
	KernelError,
	type InetAddr,
} from "../../src/kernel/index.js";

/**
 * Helper: create a SocketTable with a connected client/server pair.
 * Returns { table, clientId, serverSockId }.
 */
async function setupConnectedPair(port = 8080) {
	const table = new SocketTable();
	const listenId = table.create(AF_INET, SOCK_STREAM, 0, /* pid */ 1);
	const addr: InetAddr = { host: "0.0.0.0", port };
	await table.bind(listenId, addr);
	await table.listen(listenId);

	const clientId = table.create(AF_INET, SOCK_STREAM, 0, /* pid */ 2);
	await table.connect(clientId, { host: "127.0.0.1", port });
	const serverSockId = table.accept(listenId)!;

	return { table, clientId, serverSockId };
}

describe("Socket shutdown (half-close)", () => {
	// -------------------------------------------------------------------
	// shutdown('write') — half-close write
	// -------------------------------------------------------------------

	it("shutdown('write') transitions to write-closed", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "write");
		expect(table.get(clientId)!.state).toBe("write-closed");
	});

	it("shutdown('write') → peer recv() gets EOF after buffer drained", async () => {
		const { table, clientId, serverSockId } = await setupConnectedPair();

		// Send some data before shutdown
		table.send(clientId, new TextEncoder().encode("last"));
		table.shutdown(clientId, "write");

		// Server can still read buffered data
		const data = table.recv(serverSockId, 1024);
		expect(new TextDecoder().decode(data!)).toBe("last");

		// Next recv returns EOF
		const eof = table.recv(serverSockId, 1024);
		expect(eof).toBeNull();
	});

	it("shutdown('write') → peer recv() returns EOF immediately when buffer empty", async () => {
		const { table, clientId, serverSockId } = await setupConnectedPair();
		table.shutdown(clientId, "write");

		const result = table.recv(serverSockId, 1024);
		expect(result).toBeNull();
	});

	it("shutdown('write') → local recv() still works", async () => {
		const { table, clientId, serverSockId } = await setupConnectedPair();

		// Server sends data, then client shuts down write
		table.send(serverSockId, new TextEncoder().encode("hello"));
		table.shutdown(clientId, "write");

		// Client can still read data from server
		const data = table.recv(clientId, 1024);
		expect(new TextDecoder().decode(data!)).toBe("hello");
	});

	it("send() on write-closed socket throws EPIPE", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "write");

		expect(() => table.send(clientId, new Uint8Array([1]))).toThrow(KernelError);
		try {
			table.send(clientId, new Uint8Array([1]));
		} catch (e) {
			expect((e as KernelError).code).toBe("EPIPE");
		}
	});

	it("shutdown('write') wakes peer read waiters", async () => {
		const { table, clientId, serverSockId } = await setupConnectedPair();
		const serverSock = table.get(serverSockId)!;
		const handle = serverSock.readWaiters.enqueue();

		table.shutdown(clientId, "write");

		await handle.wait();
		expect(handle.isSettled).toBe(true);
	});

	// -------------------------------------------------------------------
	// shutdown('read') — half-close read
	// -------------------------------------------------------------------

	it("shutdown('read') transitions to read-closed", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "read");
		expect(table.get(clientId)!.state).toBe("read-closed");
	});

	it("shutdown('read') → local recv() returns EOF immediately", async () => {
		const { table, clientId, serverSockId } = await setupConnectedPair();

		// Send data from server first
		table.send(serverSockId, new TextEncoder().encode("data"));
		table.shutdown(clientId, "read");

		// recv returns null (EOF) — buffered data discarded
		const result = table.recv(clientId, 1024);
		expect(result).toBeNull();
	});

	it("shutdown('read') → local send() still works", async () => {
		const { table, clientId, serverSockId } = await setupConnectedPair();
		table.shutdown(clientId, "read");

		// Client can still send data
		const written = table.send(clientId, new TextEncoder().encode("outgoing"));
		expect(written).toBe(8);

		// Server can read it
		const data = table.recv(serverSockId, 1024);
		expect(new TextDecoder().decode(data!)).toBe("outgoing");
	});

	// -------------------------------------------------------------------
	// shutdown('both') — full shutdown
	// -------------------------------------------------------------------

	it("shutdown('both') transitions to closed", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "both");
		expect(table.get(clientId)!.state).toBe("closed");
	});

	it("shutdown('both') → send() throws EPIPE", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "both");

		expect(() => table.send(clientId, new Uint8Array([1]))).toThrow(KernelError);
		try {
			table.send(clientId, new Uint8Array([1]));
		} catch (e) {
			expect((e as KernelError).code).toBe("EPIPE");
		}
	});

	it("shutdown('both') → recv() returns EOF", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "both");

		const result = table.recv(clientId, 1024);
		expect(result).toBeNull();
	});

	// -------------------------------------------------------------------
	// Sequential half-close: read then write → closed
	// -------------------------------------------------------------------

	it("shutdown('read') then shutdown('write') transitions to closed", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "read");
		expect(table.get(clientId)!.state).toBe("read-closed");

		table.shutdown(clientId, "write");
		expect(table.get(clientId)!.state).toBe("closed");
	});

	it("shutdown('write') then shutdown('read') transitions to closed", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "write");
		expect(table.get(clientId)!.state).toBe("write-closed");

		table.shutdown(clientId, "read");
		expect(table.get(clientId)!.state).toBe("closed");
	});

	// -------------------------------------------------------------------
	// Error cases
	// -------------------------------------------------------------------

	it("shutdown on non-connected socket throws ENOTCONN", () => {
		const table = new SocketTable();
		const id = table.create(AF_INET, SOCK_STREAM, 0, 1);

		expect(() => table.shutdown(id, "write")).toThrow(KernelError);
		try {
			table.shutdown(id, "write");
		} catch (e) {
			expect((e as KernelError).code).toBe("ENOTCONN");
		}
	});

	// -------------------------------------------------------------------
	// Poll reflects half-close states
	// -------------------------------------------------------------------

	it("poll on write-closed: writable=false, hangup=true", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "write");

		const poll = table.poll(clientId);
		expect(poll.writable).toBe(false);
		expect(poll.hangup).toBe(true);
	});

	it("poll on read-closed: readable=true, writable=true, hangup=true", async () => {
		const { table, clientId } = await setupConnectedPair();
		table.shutdown(clientId, "read");

		const poll = table.poll(clientId);
		expect(poll.readable).toBe(true);
		expect(poll.writable).toBe(true);
		expect(poll.hangup).toBe(true);
	});
});
