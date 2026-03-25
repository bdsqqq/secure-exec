import { describe, it, expect } from "vitest";
import {
	SocketTable,
	AF_UNIX,
	SOCK_STREAM,
	SOCK_DGRAM,
	S_IFSOCK,
	KernelError,
	type UnixAddr,
} from "../../src/kernel/index.js";
import { InMemoryFileSystem } from "../../src/shared/in-memory-fs.js";

/**
 * Helper: create a SocketTable with VFS and a listening Unix stream socket.
 * Returns { table, vfs, listenId, addr }.
 */
async function setupUnixListener(path: string) {
	const vfs = new InMemoryFileSystem();
	// Ensure parent directory exists
	await vfs.mkdir("/tmp", { recursive: true });
	const table = new SocketTable({ vfs });
	const listenId = table.create(AF_UNIX, SOCK_STREAM, 0, /* pid */ 1);
	const addr: UnixAddr = { path };
	await table.bind(listenId, addr);
	await table.listen(listenId);
	return { table, vfs, listenId, addr };
}

describe("Unix domain sockets", () => {
	// -------------------------------------------------------------------
	// SOCK_STREAM: bind / connect / exchange data
	// -------------------------------------------------------------------

	it("bind creates socket file in VFS and connect exchanges data", async () => {
		const { table, listenId, addr } = await setupUnixListener("/tmp/test.sock");

		// Connect a client
		const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, /* pid */ 2);
		await table.connect(clientId, addr);

		const client = table.get(clientId)!;
		expect(client.state).toBe("connected");
		expect(client.remoteAddr).toEqual(addr);

		// Accept the server-side socket
		const serverSockId = table.accept(listenId);
		expect(serverSockId).not.toBeNull();

		// Exchange data: client → server
		const msg = new TextEncoder().encode("hello unix");
		table.send(clientId, msg);
		const received = table.recv(serverSockId!, 1024);
		expect(received).not.toBeNull();
		expect(new TextDecoder().decode(received!)).toBe("hello unix");

		// Exchange data: server → client
		const reply = new TextEncoder().encode("pong");
		table.send(serverSockId!, reply);
		const got = table.recv(clientId, 1024);
		expect(got).not.toBeNull();
		expect(new TextDecoder().decode(got!)).toBe("pong");
	});

	it("close propagates EOF for Unix stream sockets", async () => {
		const { table, listenId, addr } = await setupUnixListener("/tmp/eof.sock");

		const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Close client → server gets EOF
		table.close(clientId, 2);
		const eof = table.recv(serverSockId, 1024);
		expect(eof).toBeNull();
	});

	// -------------------------------------------------------------------
	// Socket file in VFS
	// -------------------------------------------------------------------

	it("stat on socket path returns socket file type", async () => {
		const { vfs } = await setupUnixListener("/tmp/stat.sock");

		const stat = await vfs.stat("/tmp/stat.sock");
		expect(stat.mode & 0o170000).toBe(S_IFSOCK);
	});

	it("socket file exists in VFS after bind", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		const table = new SocketTable({ vfs });
		const id = table.create(AF_UNIX, SOCK_STREAM, 0, 1);

		await table.bind(id, { path: "/tmp/exists.sock" });
		expect(await vfs.exists("/tmp/exists.sock")).toBe(true);
	});

	// -------------------------------------------------------------------
	// EADDRINUSE
	// -------------------------------------------------------------------

	it("bind to existing socket path returns EADDRINUSE", async () => {
		const { table } = await setupUnixListener("/tmp/dup.sock");

		const id2 = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
		await expect(table.bind(id2, { path: "/tmp/dup.sock" })).rejects.toThrow(KernelError);
		await expect(table.bind(id2, { path: "/tmp/dup.sock" })).rejects.toThrow("EADDRINUSE");
	});

	it("bind to path where a regular file exists returns EADDRINUSE", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		await vfs.writeFile("/tmp/regular.file", "data");
		const table = new SocketTable({ vfs });

		const id = table.create(AF_UNIX, SOCK_STREAM, 0, 1);
		await expect(table.bind(id, { path: "/tmp/regular.file" })).rejects.toThrow(KernelError);
		await expect(table.bind(id, { path: "/tmp/regular.file" })).rejects.toThrow("EADDRINUSE");
	});

	// -------------------------------------------------------------------
	// ECONNREFUSED after unlink
	// -------------------------------------------------------------------

	it("connect fails with ECONNREFUSED after socket file is removed", async () => {
		const { table, vfs, addr } = await setupUnixListener("/tmp/removed.sock");

		// Remove the socket file from VFS
		await vfs.removeFile("/tmp/removed.sock");

		// New connection should fail
		const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
		await expect(table.connect(clientId, addr)).rejects.toThrow(KernelError);
		await expect(
			table.connect(table.create(AF_UNIX, SOCK_STREAM, 0, 2), addr),
		).rejects.toThrow("ECONNREFUSED");
	});

	// -------------------------------------------------------------------
	// SOCK_DGRAM mode
	// -------------------------------------------------------------------

	it("Unix SOCK_DGRAM: bind and sendTo/recvFrom with message boundaries", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		const table = new SocketTable({ vfs });

		// Create receiver
		const recvId = table.create(AF_UNIX, SOCK_DGRAM, 0, 1);
		const recvAddr: UnixAddr = { path: "/tmp/dgram.sock" };
		await table.bind(recvId, recvAddr);

		// Create sender
		const sendId = table.create(AF_UNIX, SOCK_DGRAM, 0, 2);
		const sendAddr: UnixAddr = { path: "/tmp/sender.sock" };
		await table.bind(sendId, sendAddr);

		// Send two datagrams
		const msg1 = new TextEncoder().encode("first");
		const msg2 = new TextEncoder().encode("second");
		table.sendTo(sendId, msg1, 0, recvAddr);
		table.sendTo(sendId, msg2, 0, recvAddr);

		// Receive preserves boundaries
		const r1 = table.recvFrom(recvId, 1024);
		expect(r1).not.toBeNull();
		expect(new TextDecoder().decode(r1!.data)).toBe("first");
		expect(r1!.srcAddr).toEqual(sendAddr);

		const r2 = table.recvFrom(recvId, 1024);
		expect(r2).not.toBeNull();
		expect(new TextDecoder().decode(r2!.data)).toBe("second");
	});

	it("Unix SOCK_DGRAM: socket file exists in VFS", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		const table = new SocketTable({ vfs });

		const id = table.create(AF_UNIX, SOCK_DGRAM, 0, 1);
		await table.bind(id, { path: "/tmp/dgram2.sock" });

		expect(await vfs.exists("/tmp/dgram2.sock")).toBe(true);
		const stat = await vfs.stat("/tmp/dgram2.sock");
		expect(stat.mode & 0o170000).toBe(S_IFSOCK);
	});

	it("Unix SOCK_DGRAM: sendTo to unbound path is silently dropped", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		const table = new SocketTable({ vfs });

		const sendId = table.create(AF_UNIX, SOCK_DGRAM, 0, 1);
		await table.bind(sendId, { path: "/tmp/src.sock" });

		// Send to a path that has no bound socket — should silently drop
		const bytes = table.sendTo(
			sendId,
			new TextEncoder().encode("dropped"),
			0,
			{ path: "/tmp/nobody.sock" },
		);
		expect(bytes).toBe(7); // "dropped".length
	});

	// -------------------------------------------------------------------
	// Always in-kernel (no host adapter)
	// -------------------------------------------------------------------

	it("Unix connect is always in-kernel (no host adapter needed)", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		// No host adapter configured — Unix sockets route in-kernel
		const table = new SocketTable({ vfs });

		const listenId = table.create(AF_UNIX, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { path: "/tmp/nohost.sock" });
		await table.listen(listenId);

		const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
		await table.connect(clientId, { path: "/tmp/nohost.sock" });

		const client = table.get(clientId)!;
		expect(client.state).toBe("connected");
		expect(client.external).toBeUndefined();
		expect(client.hostSocket).toBeUndefined();
	});

	// -------------------------------------------------------------------
	// Without VFS (backwards compatibility)
	// -------------------------------------------------------------------

	it("Unix sockets work without VFS (no socket file, listeners map only)", async () => {
		const table = new SocketTable(); // No VFS

		const listenId = table.create(AF_UNIX, SOCK_STREAM, 0, 1);
		await table.bind(listenId, { path: "/tmp/novfs.sock" });
		await table.listen(listenId);

		const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
		await table.connect(clientId, { path: "/tmp/novfs.sock" });

		const client = table.get(clientId)!;
		expect(client.state).toBe("connected");

		// Exchange data
		table.send(clientId, new TextEncoder().encode("no vfs"));
		const serverSockId = table.accept(listenId)!;
		const data = table.recv(serverSockId, 1024);
		expect(new TextDecoder().decode(data!)).toBe("no vfs");
	});

	// -------------------------------------------------------------------
	// Port reuse after close
	// -------------------------------------------------------------------

	it("close listener frees Unix path for reuse", async () => {
		const vfs = new InMemoryFileSystem();
		await vfs.mkdir("/tmp", { recursive: true });
		const table = new SocketTable({ vfs });

		const id1 = table.create(AF_UNIX, SOCK_STREAM, 0, 1);
		await table.bind(id1, { path: "/tmp/reuse.sock" });
		await table.listen(id1);

		// Close the listener
		table.close(id1, 1);

		// Remove the socket file (simulating application cleanup)
		await vfs.removeFile("/tmp/reuse.sock");

		// Now a new socket can bind to the same path
		const id2 = table.create(AF_UNIX, SOCK_STREAM, 0, 1);
		await table.bind(id2, { path: "/tmp/reuse.sock" });
		expect(table.get(id2)!.state).toBe("bound");
	});

	// -------------------------------------------------------------------
	// Half-close for Unix sockets
	// -------------------------------------------------------------------

	it("shutdown half-close works for Unix stream sockets", async () => {
		const { table, listenId, addr } = await setupUnixListener("/tmp/halfclose.sock");

		const clientId = table.create(AF_UNIX, SOCK_STREAM, 0, 2);
		await table.connect(clientId, addr);
		const serverSockId = table.accept(listenId)!;

		// Client shuts down write
		table.shutdown(clientId, "write");

		// Server sees EOF
		const eof = table.recv(serverSockId, 1024);
		expect(eof).toBeNull();

		// Server can still send to client
		table.send(serverSockId, new TextEncoder().encode("reply"));
		const got = table.recv(clientId, 1024);
		expect(new TextDecoder().decode(got!)).toBe("reply");
	});
});
