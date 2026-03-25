import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_INET,
	SOCK_STREAM,
	MSG_PEEK,
	MSG_DONTWAIT,
	MSG_NOSIGNAL,
	KernelError,
} from "../../src/kernel/index.js";

/**
 * Helper: create a loopback-connected pair of sockets.
 * Returns { table, clientId, serverId }.
 */
async function createConnectedPair(port = 6060) {
	const table = new SocketTable();
	const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
	await table.bind(listenId, { host: "0.0.0.0", port });
	await table.listen(listenId);
	const clientId = table.create(AF_INET, SOCK_STREAM, 0, 1);
	await table.connect(clientId, { host: "127.0.0.1", port });
	const serverId = table.accept(listenId)!;
	return { table, clientId, serverId, listenId };
}

describe("Socket flags", () => {
	// -------------------------------------------------------------------
	// MSG_PEEK
	// -------------------------------------------------------------------

	it("MSG_PEEK reads data without consuming it from readBuffer", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.send(clientId, new Uint8Array([10, 20, 30]));

		// Peek at the data
		const peeked = table.recv(serverId, 1024, MSG_PEEK);
		expect(peeked).not.toBeNull();
		expect(Array.from(peeked!)).toEqual([10, 20, 30]);

		// Data is still in the buffer — a normal recv should return the same data
		const consumed = table.recv(serverId, 1024);
		expect(consumed).not.toBeNull();
		expect(Array.from(consumed!)).toEqual([10, 20, 30]);

		// Buffer is now empty
		const empty = table.recv(serverId, 1024);
		expect(empty).toBeNull();
	});

	it("MSG_PEEK respects maxBytes limit", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.send(clientId, new Uint8Array([1, 2, 3, 4, 5]));

		// Peek only 3 bytes
		const peeked = table.recv(serverId, 3, MSG_PEEK);
		expect(peeked).not.toBeNull();
		expect(peeked!.length).toBe(3);
		expect(Array.from(peeked!)).toEqual([1, 2, 3]);

		// Full data still in buffer
		const full = table.recv(serverId, 1024);
		expect(full!.length).toBe(5);
	});

	it("MSG_PEEK with multiple chunks", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.send(clientId, new Uint8Array([1, 2]));
		table.send(clientId, new Uint8Array([3, 4]));

		// Peek all
		const peeked = table.recv(serverId, 1024, MSG_PEEK);
		expect(Array.from(peeked!)).toEqual([1, 2, 3, 4]);

		// Peek again — still the same
		const peeked2 = table.recv(serverId, 1024, MSG_PEEK);
		expect(Array.from(peeked2!)).toEqual([1, 2, 3, 4]);

		// Consume — gets all data
		const consumed = table.recv(serverId, 1024);
		expect(Array.from(consumed!)).toEqual([1, 2, 3, 4]);
	});

	it("MSG_PEEK returns copy of data, not a reference", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.send(clientId, new Uint8Array([42]));

		const peeked = table.recv(serverId, 1024, MSG_PEEK)!;
		// Mutating the peeked data should not affect the buffer
		peeked[0] = 99;

		const consumed = table.recv(serverId, 1024)!;
		expect(consumed[0]).toBe(42);
	});

	it("MSG_PEEK on empty buffer with EOF returns null", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		// Close client → server gets EOF
		table.close(clientId, 1);
		const result = table.recv(serverId, 1024, MSG_PEEK);
		expect(result).toBeNull();
	});

	// -------------------------------------------------------------------
	// MSG_DONTWAIT
	// -------------------------------------------------------------------

	it("MSG_DONTWAIT returns EAGAIN when no data available", async () => {
		const { table, serverId } = await createConnectedPair();
		// No data sent — recv with MSG_DONTWAIT should throw EAGAIN
		expect(() => table.recv(serverId, 1024, MSG_DONTWAIT)).toThrow(KernelError);
		try {
			table.recv(serverId, 1024, MSG_DONTWAIT);
		} catch (e) {
			expect((e as KernelError).code).toBe("EAGAIN");
		}
	});

	it("MSG_DONTWAIT returns data when available", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.send(clientId, new Uint8Array([7, 8, 9]));
		// Data is available — MSG_DONTWAIT should return it
		const data = table.recv(serverId, 1024, MSG_DONTWAIT);
		expect(data).not.toBeNull();
		expect(Array.from(data!)).toEqual([7, 8, 9]);
	});

	it("MSG_DONTWAIT still returns null for EOF", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.close(clientId, 1);
		// EOF — should return null, not EAGAIN
		const result = table.recv(serverId, 1024, MSG_DONTWAIT);
		expect(result).toBeNull();
	});

	it("MSG_DONTWAIT on read-closed socket returns null (EOF)", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.shutdown(serverId, "read");
		const result = table.recv(serverId, 1024, MSG_DONTWAIT);
		expect(result).toBeNull();
	});

	it("non-blocking recv returns EAGAIN when no data is available", async () => {
		const { table, serverId } = await createConnectedPair();
		table.setNonBlocking(serverId, true);

		expect(() => table.recv(serverId, 1024)).toThrow(KernelError);
		try {
			table.recv(serverId, 1024);
		} catch (e) {
			expect((e as KernelError).code).toBe("EAGAIN");
		}
	});

	it("non-blocking accept returns EAGAIN when backlog is empty", async () => {
		const table = new SocketTable();
		const listenId = table.create(AF_INET, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { host: "0.0.0.0", port: 6061 });
		await table.listen(listenId);
		table.setNonBlocking(listenId, true);

		expect(() => table.accept(listenId)).toThrow(KernelError);
		try {
			table.accept(listenId);
		} catch (e) {
			expect((e as KernelError).code).toBe("EAGAIN");
		}
	});

	it("setNonBlocking toggles socket non-blocking mode", async () => {
		const { table, serverId } = await createConnectedPair(6062);
		expect(table.get(serverId)!.nonBlocking).toBe(false);

		table.setNonBlocking(serverId, true);
		expect(table.get(serverId)!.nonBlocking).toBe(true);
		expect(() => table.recv(serverId, 1024)).toThrow(KernelError);

		table.setNonBlocking(serverId, false);
		expect(table.get(serverId)!.nonBlocking).toBe(false);
		expect(table.recv(serverId, 1024)).toBeNull();
	});

	// -------------------------------------------------------------------
	// MSG_PEEK + MSG_DONTWAIT combined
	// -------------------------------------------------------------------

	it("MSG_PEEK | MSG_DONTWAIT: EAGAIN when empty, data when available", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		const flags = MSG_PEEK | MSG_DONTWAIT;

		// No data → EAGAIN
		expect(() => table.recv(serverId, 1024, flags)).toThrow(KernelError);

		// Send data
		table.send(clientId, new Uint8Array([55]));

		// Peek + dontwait → returns data without consuming
		const peeked = table.recv(serverId, 1024, flags);
		expect(Array.from(peeked!)).toEqual([55]);

		// Data still in buffer
		const consumed = table.recv(serverId, 1024);
		expect(Array.from(consumed!)).toEqual([55]);
	});

	// -------------------------------------------------------------------
	// MSG_NOSIGNAL
	// -------------------------------------------------------------------

	it("MSG_NOSIGNAL on broken pipe returns EPIPE", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.close(serverId, 1); // Close server → client's peer is gone
		expect(() => table.send(clientId, new Uint8Array([1]), MSG_NOSIGNAL)).toThrow(KernelError);
		try {
			table.send(clientId, new Uint8Array([1]), MSG_NOSIGNAL);
		} catch (e) {
			expect((e as KernelError).code).toBe("EPIPE");
			expect((e as KernelError).message).toContain("MSG_NOSIGNAL");
		}
	});

	it("MSG_NOSIGNAL on write-closed socket returns EPIPE", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		table.shutdown(clientId, "write"); // Client shuts down write
		expect(() => table.send(clientId, new Uint8Array([1]), MSG_NOSIGNAL)).toThrow(KernelError);
		try {
			table.send(clientId, new Uint8Array([1]), MSG_NOSIGNAL);
		} catch (e) {
			expect((e as KernelError).code).toBe("EPIPE");
			expect((e as KernelError).message).toContain("MSG_NOSIGNAL");
		}
	});

	it("MSG_NOSIGNAL does not affect successful send", async () => {
		const { table, clientId, serverId } = await createConnectedPair();
		const written = table.send(clientId, new Uint8Array([1, 2, 3]), MSG_NOSIGNAL);
		expect(written).toBe(3);
		// Data arrives at server
		const data = table.recv(serverId, 1024);
		expect(Array.from(data!)).toEqual([1, 2, 3]);
	});
});
