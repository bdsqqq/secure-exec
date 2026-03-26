import { afterEach, describe, expect, it } from "vitest";
import {
	AF_UNIX,
	S_IFSOCK,
	SOCK_DGRAM,
	SOCK_STREAM,
	createKernel,
} from "../../../core/src/kernel/index.ts";
import type {
	DriverProcess,
	Kernel,
	VirtualFileSystem,
} from "../../../core/src/kernel/index.ts";
import { InMemoryFileSystem } from "../../../browser/src/os-filesystem.ts";

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type KernelTestInternals = {
	posixDirsReady: Promise<void>;
	processTable: {
		allocatePid(): number;
		register(
			pid: number,
			driver: string,
			command: string,
			args: string[],
			ctx: {
				pid: number;
				ppid: number;
				env: Record<string, string>;
				cwd: string;
				fds: { stdin: number; stdout: number; stderr: number };
			},
			driverProcess: DriverProcess,
		): void;
	};
};

function requireValue<T>(value: T | null, message: string): T {
	if (value === null) {
		throw new Error(message);
	}
	return value;
}

async function createUnixKernel(): Promise<{
	kernel: Kernel;
	vfs: VirtualFileSystem;
	dispose: () => Promise<void>;
}> {
	const vfs = new InMemoryFileSystem();
	const kernel = createKernel({ filesystem: vfs });
	await (kernel as Kernel & KernelTestInternals).posixDirsReady;

	return {
		kernel,
		vfs,
		dispose: () => kernel.dispose(),
	};
}

function createMockDriverProcess(): DriverProcess {
	let resolveExit!: (code: number) => void;
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
	const internal = kernel as Kernel & KernelTestInternals;
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

describe("kernel AF_UNIX behavior", () => {
	let ctx: Awaited<ReturnType<typeof createUnixKernel>> | undefined;

	afterEach(async () => {
		await ctx?.dispose();
		ctx = undefined;
	});

	it("supports stream bind/listen/connect by path through the real kernel", async () => {
		ctx = await createUnixKernel();
		const serverPid = registerKernelPid(ctx.kernel);
		const clientPid = registerKernelPid(ctx.kernel);

		const listenId = ctx.kernel.socketTable.create(
			AF_UNIX,
			SOCK_STREAM,
			0,
			serverPid,
		);
		await ctx.kernel.socketTable.bind(listenId, { path: "/tmp/stream.sock" });
		await ctx.kernel.socketTable.listen(listenId);

		const stat = await ctx.vfs.stat("/tmp/stream.sock");
		expect(stat.mode & 0o170000).toBe(S_IFSOCK);

		const clientId = ctx.kernel.socketTable.create(
			AF_UNIX,
			SOCK_STREAM,
			0,
			clientPid,
		);
		await ctx.kernel.socketTable.connect(clientId, {
			path: "/tmp/stream.sock",
		});
		const serverId = requireValue(
			ctx.kernel.socketTable.accept(listenId),
			"expected an accepted AF_UNIX server socket",
		);

		ctx.kernel.socketTable.send(clientId, textEncoder.encode("ping"));
		const serverReceived = requireValue(
			ctx.kernel.socketTable.recv(serverId, 1024),
			"expected AF_UNIX server data",
		);
		expect(textDecoder.decode(serverReceived)).toBe("ping");

		ctx.kernel.socketTable.send(serverId, textEncoder.encode("pong"));
		const clientReceived = requireValue(
			ctx.kernel.socketTable.recv(clientId, 1024),
			"expected AF_UNIX client data",
		);
		expect(textDecoder.decode(clientReceived)).toBe("pong");
	});

	it("supports AF_UNIX datagram routing with path-based addresses", async () => {
		ctx = await createUnixKernel();
		const receiverPid = registerKernelPid(ctx.kernel);
		const senderPid = registerKernelPid(ctx.kernel);

		const receiverId = ctx.kernel.socketTable.create(
			AF_UNIX,
			SOCK_DGRAM,
			0,
			receiverPid,
		);
		await ctx.kernel.socketTable.bind(receiverId, {
			path: "/tmp/receiver.sock",
		});

		const senderId = ctx.kernel.socketTable.create(
			AF_UNIX,
			SOCK_DGRAM,
			0,
			senderPid,
		);
		await ctx.kernel.socketTable.bind(senderId, { path: "/tmp/sender.sock" });

		ctx.kernel.socketTable.sendTo(senderId, textEncoder.encode("first"), 0, {
			path: "/tmp/receiver.sock",
		});
		ctx.kernel.socketTable.sendTo(senderId, textEncoder.encode("second"), 0, {
			path: "/tmp/receiver.sock",
		});

		const first = requireValue(
			ctx.kernel.socketTable.recvFrom(receiverId, 1024),
			"expected first AF_UNIX datagram",
		);
		const second = requireValue(
			ctx.kernel.socketTable.recvFrom(receiverId, 1024),
			"expected second AF_UNIX datagram",
		);

		expect(textDecoder.decode(first.data)).toBe("first");
		expect(first.srcAddr).toEqual({ path: "/tmp/sender.sock" });
		expect(textDecoder.decode(second.data)).toBe("second");
		expect(second.srcAddr).toEqual({ path: "/tmp/sender.sock" });
	});

	it("supports AF_UNIX socketpair shutdown half-close semantics", async () => {
		ctx = await createUnixKernel();
		const pid = registerKernelPid(ctx.kernel);

		const [leftId, rightId] = ctx.kernel.socketTable.socketpair(
			AF_UNIX,
			SOCK_STREAM,
			0,
			pid,
		);

		ctx.kernel.socketTable.send(leftId, textEncoder.encode("before-shutdown"));
		const beforeShutdown = requireValue(
			ctx.kernel.socketTable.recv(rightId, 1024),
			"expected socketpair data before shutdown",
		);
		expect(textDecoder.decode(beforeShutdown)).toBe("before-shutdown");

		ctx.kernel.socketTable.shutdown(leftId, "write");

		const eof = ctx.kernel.socketTable.recv(rightId, 1024);
		expect(eof).toBeNull();

		ctx.kernel.socketTable.send(rightId, textEncoder.encode("still-open"));
		const reply = requireValue(
			ctx.kernel.socketTable.recv(leftId, 1024),
			"expected socketpair reply after shutdown",
		);
		expect(textDecoder.decode(reply)).toBe("still-open");
	});
});
