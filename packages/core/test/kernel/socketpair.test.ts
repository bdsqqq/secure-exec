import { describe, it, expect } from "vitest";
import { SocketTable, AF_UNIX, AF_INET, SOCK_STREAM, SOCK_DGRAM } from "../../src/kernel/socket-table.js";

describe("SocketTable.socketpair", () => {
	it("creates two sockets in connected state", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		const s1 = table.get(id1)!;
		const s2 = table.get(id2)!;
		expect(s1).not.toBeNull();
		expect(s2).not.toBeNull();
		expect(s1.state).toBe("connected");
		expect(s2.state).toBe("connected");
	});

	it("links sockets via peerId", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		const s1 = table.get(id1)!;
		const s2 = table.get(id2)!;
		expect(s1.peerId).toBe(id2);
		expect(s2.peerId).toBe(id1);
	});

	it("preserves domain, type, protocol, pid", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 42);

		const s1 = table.get(id1)!;
		const s2 = table.get(id2)!;
		expect(s1.domain).toBe(AF_UNIX);
		expect(s1.type).toBe(SOCK_STREAM);
		expect(s1.protocol).toBe(0);
		expect(s1.pid).toBe(42);
		expect(s2.domain).toBe(AF_UNIX);
		expect(s2.type).toBe(SOCK_STREAM);
		expect(s2.pid).toBe(42);
	});

	it("sends data from socket 1 to socket 2", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		const payload = new TextEncoder().encode("hello");
		table.send(id1, payload);

		const received = table.recv(id2, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("hello");
	});

	it("sends data from socket 2 to socket 1", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		const payload = new TextEncoder().encode("world");
		table.send(id2, payload);

		const received = table.recv(id1, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("world");
	});

	it("exchanges data bidirectionally", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		table.send(id1, new TextEncoder().encode("ping"));
		table.send(id2, new TextEncoder().encode("pong"));

		const r1 = table.recv(id1, 1024);
		const r2 = table.recv(id2, 1024);
		expect(new TextDecoder().decode(r1!)).toBe("pong");
		expect(new TextDecoder().decode(r2!)).toBe("ping");
	});

	it("close one side delivers EOF to the other", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		// Send data then close socket 1
		table.send(id1, new TextEncoder().encode("last"));
		table.close(id1, 1);

		// Socket 2 can still read buffered data
		const received = table.recv(id2, 1024);
		expect(new TextDecoder().decode(received!)).toBe("last");

		// After draining, recv returns null (EOF)
		const eof = table.recv(id2, 1024);
		expect(eof).toBeNull();
	});

	it("close one side — peer send returns EPIPE", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		table.close(id1, 1);

		expect(() => table.send(id2, new Uint8Array([1]))).toThrow(/broken pipe/);
	});

	it("both sockets can be closed independently", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		table.close(id1, 1);
		table.close(id2, 1);

		expect(table.get(id1)).toBeNull();
		expect(table.get(id2)).toBeNull();
	});

	it("works with AF_INET + SOCK_STREAM", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_INET, SOCK_STREAM, 0, 1);

		table.send(id1, new TextEncoder().encode("inet"));
		const r = table.recv(id2, 1024);
		expect(new TextDecoder().decode(r!)).toBe("inet");
	});

	it("works with SOCK_DGRAM", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_DGRAM, 0, 1);

		table.send(id1, new TextEncoder().encode("dgram"));
		const r = table.recv(id2, 1024);
		expect(new TextDecoder().decode(r!)).toBe("dgram");
	});

	it("respects EMFILE limit", () => {
		const table = new SocketTable({ maxSockets: 3 });
		// socketpair creates 2 sockets, then another 2 would exceed limit of 3
		table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);
		expect(() => table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1)).toThrow(/too many open sockets/);
	});

	it("shutdown half-close works on socketpair", () => {
		const table = new SocketTable();
		const [id1, id2] = table.socketpair(AF_UNIX, SOCK_STREAM, 0, 1);

		// Shut down write on socket 1
		table.shutdown(id1, "write");

		// Socket 2 sees EOF
		const eof = table.recv(id2, 1024);
		expect(eof).toBeNull();

		// Socket 1 can still receive
		table.send(id2, new TextEncoder().encode("still open"));
		const r = table.recv(id1, 1024);
		expect(new TextDecoder().decode(r!)).toBe("still open");
	});
});
