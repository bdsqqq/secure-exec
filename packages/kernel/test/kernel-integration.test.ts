import { describe, it, expect, afterEach } from "vitest";
import {
	TestFileSystem,
	MockRuntimeDriver,
	createTestKernel,
	type MockCommandConfig,
} from "./helpers.js";
import type { Kernel } from "../src/types.js";

describe("kernel + MockRuntimeDriver integration", () => {
	let kernel: Kernel;

	afterEach(async () => {
		await kernel?.dispose();
	});

	// -----------------------------------------------------------------------
	// Basic mount / spawn / exec
	// -----------------------------------------------------------------------

	it("mount registers mock commands in kernel.commands", async () => {
		const driver = new MockRuntimeDriver(["echo", "cat"]);
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		expect(kernel.commands.get("echo")).toBe("mock");
		expect(kernel.commands.get("cat")).toBe("mock");
	});

	it("spawn returns ManagedProcess with correct PID and exit code", async () => {
		const driver = new MockRuntimeDriver(["mock-cmd"], {
			"mock-cmd": { exitCode: 42 },
		});
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		const proc = kernel.spawn("mock-cmd", []);
		expect(proc.pid).toBeGreaterThan(0);

		const code = await proc.wait();
		expect(code).toBe(42);
	});

	it("exec returns ExecResult with stdout and stderr", async () => {
		// exec() routes through 'sh', so register 'sh' as a mock command
		const driver = new MockRuntimeDriver(["sh"], {
			sh: { exitCode: 0, stdout: "hello\n", stderr: "warn\n" },
		});
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		const result = await kernel.exec("echo hello");
		expect(result.exitCode).toBe(0);
		expect(result.stdout).toBe("hello\n");
		expect(result.stderr).toBe("warn\n");
	});

	it("exec of unknown command throws ENOENT", async () => {
		const driver = new MockRuntimeDriver(["sh"], { sh: { exitCode: 0 } });
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		// spawn directly — 'nosuchcmd' is not registered
		expect(() => kernel.spawn("nosuchcmd", [])).toThrow("ENOENT");
	});

	it("dispose tears down cleanly", async () => {
		const driver = new MockRuntimeDriver(["sh"], { sh: { exitCode: 0 } });
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		await kernel.dispose();
		// Second dispose is safe
		await kernel.dispose();
		// Kernel is disposed — operations throw
		await expect(kernel.exec("echo")).rejects.toThrow("disposed");
	});

	it("driver receives KernelInterface on init", async () => {
		const driver = new MockRuntimeDriver(["x"]);
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		expect(driver.kernelInterface).not.toBeNull();
		expect(driver.kernelInterface!.vfs).toBeDefined();
	});

	// -----------------------------------------------------------------------
	// BUG 1 fix: stdout callback race
	// -----------------------------------------------------------------------

	it("exec captures stdout emitted synchronously during spawn", async () => {
		const driver = new MockRuntimeDriver(["sh"], {
			sh: { exitCode: 0, stdout: "sync-data", emitDuringSpawn: true },
		});
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		const result = await kernel.exec("test");
		expect(result.stdout).toBe("sync-data");
	});

	it("exec captures stderr emitted synchronously during spawn", async () => {
		const driver = new MockRuntimeDriver(["sh"], {
			sh: { exitCode: 0, stderr: "sync-err", emitDuringSpawn: true },
		});
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		const result = await kernel.exec("test");
		expect(result.stderr).toBe("sync-err");
	});

	// -----------------------------------------------------------------------
	// BUG 2 fix: PID allocation race
	// -----------------------------------------------------------------------

	it("concurrent spawns get unique PIDs", async () => {
		const commands = Array.from({ length: 10 }, (_, i) => `cmd-${i}`);
		const configs: Record<string, MockCommandConfig> = {};
		for (const cmd of commands) configs[cmd] = { exitCode: 0 };

		const driver = new MockRuntimeDriver(commands, configs);
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		// Spawn 10 processes concurrently
		const procs = commands.map((cmd) => kernel.spawn(cmd, []));

		const pids = procs.map((p) => p.pid);
		const uniquePids = new Set(pids);
		expect(uniquePids.size).toBe(10);

		// All PIDs should match what the process table reports
		for (const proc of procs) {
			const info = kernel.processes.get(proc.pid);
			expect(info).toBeDefined();
			expect(info!.pid).toBe(proc.pid);
		}

		// Wait for all to exit
		await Promise.all(procs.map((p) => p.wait()));
	});

	// -----------------------------------------------------------------------
	// BUG 3 fix: fdRead reads from VFS
	// -----------------------------------------------------------------------

	it("fdRead returns file content at cursor position", async () => {
		const driver = new MockRuntimeDriver(["x"]);
		const { kernel: k, vfs } = await createTestKernel({ drivers: [driver] });
		kernel = k;

		// Write a file via VFS
		await vfs.writeFile("/tmp/test.txt", "hello world");

		const ki = driver.kernelInterface!;
		const pid = 1; // Use a known PID

		// Spawn a process to get a valid PID in the FD table
		const proc = kernel.spawn("x", []);

		// Open the file via kernel interface
		const fd = ki.fdOpen(proc.pid, "/tmp/test.txt", 0);
		expect(fd).toBeGreaterThanOrEqual(3); // 0-2 are stdio

		// Read content
		const data = await ki.fdRead(proc.pid, fd, 5);
		expect(new TextDecoder().decode(data)).toBe("hello");

		// Read more — cursor should have advanced
		const data2 = await ki.fdRead(proc.pid, fd, 100);
		expect(new TextDecoder().decode(data2)).toBe(" world");

		// Read past EOF
		const data3 = await ki.fdRead(proc.pid, fd, 10);
		expect(data3.length).toBe(0);

		await proc.wait();
	});

	it("fdRead returns EBADF for invalid FD", async () => {
		const driver = new MockRuntimeDriver(["x"]);
		({ kernel } = await createTestKernel({ drivers: [driver] }));

		const proc = kernel.spawn("x", []);
		const ki = driver.kernelInterface!;

		await expect(ki.fdRead(proc.pid, 999, 10)).rejects.toThrow("EBADF");
		await proc.wait();
	});

	// -----------------------------------------------------------------------
	// Filesystem convenience wrappers
	// -----------------------------------------------------------------------

	it("readFile / writeFile / exists work through kernel", async () => {
		const driver = new MockRuntimeDriver(["x"]);
		const { kernel: k, vfs } = await createTestKernel({ drivers: [driver] });
		kernel = k;

		await kernel.writeFile("/tmp/data.txt", "content");
		expect(await kernel.exists("/tmp/data.txt")).toBe(true);

		const bytes = await kernel.readFile("/tmp/data.txt");
		expect(new TextDecoder().decode(bytes)).toBe("content");
	});
});
