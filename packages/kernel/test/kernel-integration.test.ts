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
	// stdin streaming
	// -----------------------------------------------------------------------

	describe("stdin streaming", () => {
		it("writeStdin delivers bytes to MockRuntimeDriver DriverProcess", async () => {
			const stdinCapture: Uint8Array[] = [];
			const driver = new MockRuntimeDriver(["mock-cmd"], {
				"mock-cmd": { exitCode: 0, stdinCapture },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("mock-cmd", []);
			proc.writeStdin(new TextEncoder().encode("test data"));

			const received = new TextDecoder().decode(stdinCapture[0]);
			expect(received).toBe("test data");

			await proc.wait();
		});

		it("writeStdin converts string to Uint8Array", async () => {
			const stdinCapture: Uint8Array[] = [];
			const driver = new MockRuntimeDriver(["mock-cmd"], {
				"mock-cmd": { exitCode: 0, stdinCapture },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("mock-cmd", []);
			proc.writeStdin("string data");

			expect(stdinCapture.length).toBe(1);
			expect(stdinCapture[0]).toBeInstanceOf(Uint8Array);
			expect(new TextDecoder().decode(stdinCapture[0])).toBe("string data");

			await proc.wait();
		});

		it("closeStdin triggers driver closeStdin callback", async () => {
			let closeCalled = false;
			const driver = new MockRuntimeDriver(["mock-cmd"], {
				"mock-cmd": { exitCode: 0, onCloseStdin: () => { closeCalled = true; } },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("mock-cmd", []);
			proc.closeStdin();
			expect(closeCalled).toBe(true);

			await proc.wait();
		});

		it("multiple writeStdin calls accumulate in order", async () => {
			const stdinCapture: Uint8Array[] = [];
			const driver = new MockRuntimeDriver(["mock-cmd"], {
				"mock-cmd": { exitCode: 0, stdinCapture },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("mock-cmd", []);
			proc.writeStdin(new TextEncoder().encode("chunk1"));
			proc.writeStdin(new TextEncoder().encode("chunk2"));
			proc.writeStdin(new TextEncoder().encode("chunk3"));

			expect(stdinCapture.length).toBe(3);
			const texts = stdinCapture.map((c) => new TextDecoder().decode(c));
			expect(texts).toEqual(["chunk1", "chunk2", "chunk3"]);

			await proc.wait();
		});
	});

	// -----------------------------------------------------------------------
	// Dispose with active processes
	// -----------------------------------------------------------------------

	describe("dispose with active processes", () => {
		it("dispose kills all running processes and resolves within 5s", async () => {
			const killSignals: number[][] = [];
			const commands: string[] = [];
			const configs: Record<string, MockCommandConfig> = {};
			for (let i = 0; i < 5; i++) {
				const signals: number[] = [];
				killSignals.push(signals);
				const cmd = `hang-${i}`;
				commands.push(cmd);
				configs[cmd] = { neverExit: true, killSignals: signals };
			}

			const driver = new MockRuntimeDriver(commands, configs);
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			// Spawn 5 processes that never exit on their own
			const procs = commands.map((cmd) => kernel.spawn(cmd, []));
			expect(procs.length).toBe(5);

			// All should be running
			for (const proc of procs) {
				expect(kernel.processes.get(proc.pid)?.status).toBe("running");
			}

			// Dispose should kill all and resolve quickly
			const start = Date.now();
			await kernel.dispose();
			const elapsed = Date.now() - start;

			expect(elapsed).toBeLessThan(5000);

			// Every process received SIGTERM (signal 15)
			for (const signals of killSignals) {
				expect(signals).toContain(15);
			}
		}, 10_000);

		it("spawn after dispose throws disposed", async () => {
			const driver = new MockRuntimeDriver(["sh"], { sh: { exitCode: 0 } });
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			await kernel.dispose();
			expect(() => kernel.spawn("sh", [])).toThrow("disposed");
		});

		it("exec after dispose rejects with disposed", async () => {
			const driver = new MockRuntimeDriver(["sh"], { sh: { exitCode: 0 } });
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			await kernel.dispose();
			await expect(kernel.exec("echo hello")).rejects.toThrow("disposed");
		});
	});

	// -----------------------------------------------------------------------
	// FD inheritance
	// -----------------------------------------------------------------------

	describe("FD inheritance", () => {
		it("child inherits parent FD table via fork", async () => {
			const driver = new MockRuntimeDriver(["parent-cmd", "child-cmd"]);
			const { kernel: k, vfs } = await createTestKernel({ drivers: [driver] });
			kernel = k;
			const ki = driver.kernelInterface!;

			await vfs.writeFile("/tmp/data.txt", "inherited content");

			// Spawn parent and open a file in its FD table
			const parent = kernel.spawn("parent-cmd", []);
			const fd = ki.fdOpen(parent.pid, "/tmp/data.txt", 0);
			expect(fd).toBeGreaterThanOrEqual(3);

			// Spawn child via kernel interface (callerPid = parent.pid)
			const child = ki.spawn("child-cmd", [], { ppid: parent.pid });

			// Child should have the inherited FD and can read from it
			const data = await ki.fdRead(child.pid, fd, 100);
			expect(new TextDecoder().decode(data)).toBe("inherited content");

			await parent.wait();
			await child.wait();
		});

		it("inherited FDs share cursor position with parent", async () => {
			const driver = new MockRuntimeDriver(["parent-cmd", "child-cmd"]);
			const { kernel: k, vfs } = await createTestKernel({ drivers: [driver] });
			kernel = k;
			const ki = driver.kernelInterface!;

			await vfs.writeFile("/tmp/shared.txt", "hello world");

			const parent = kernel.spawn("parent-cmd", []);
			const fd = ki.fdOpen(parent.pid, "/tmp/shared.txt", 0);

			// Parent reads 5 bytes — cursor advances to 5
			const data1 = await ki.fdRead(parent.pid, fd, 5);
			expect(new TextDecoder().decode(data1)).toBe("hello");

			// Spawn child — inherits FD with shared cursor at position 5
			const child = ki.spawn("child-cmd", [], { ppid: parent.pid });

			// Child reads from inherited FD — starts at cursor position 5
			const data2 = await ki.fdRead(child.pid, fd, 100);
			expect(new TextDecoder().decode(data2)).toBe(" world");

			await parent.wait();
			await child.wait();
		});

		it("child closing inherited FD does not affect parent", async () => {
			const driver = new MockRuntimeDriver(["parent-cmd", "child-cmd"]);
			const { kernel: k, vfs } = await createTestKernel({ drivers: [driver] });
			kernel = k;
			const ki = driver.kernelInterface!;

			await vfs.writeFile("/tmp/file.txt", "still readable");

			const parent = kernel.spawn("parent-cmd", []);
			const fd = ki.fdOpen(parent.pid, "/tmp/file.txt", 0);

			// Spawn child and close the inherited FD
			const child = ki.spawn("child-cmd", [], { ppid: parent.pid });
			ki.fdClose(child.pid, fd);

			// Child can no longer read
			await expect(ki.fdRead(child.pid, fd, 100)).rejects.toThrow("EBADF");

			// Parent can still read — not affected by child's close
			const data = await ki.fdRead(parent.pid, fd, 100);
			expect(new TextDecoder().decode(data)).toBe("still readable");

			await parent.wait();
			await child.wait();
		});

		it("child closing inherited pipe FD does not cause premature EOF", async () => {
			const driver = new MockRuntimeDriver(["parent-cmd", "child-cmd"]);
			const { kernel: k } = await createTestKernel({ drivers: [driver] });
			kernel = k;
			const ki = driver.kernelInterface!;

			const parent = kernel.spawn("parent-cmd", []);

			// Create a pipe in parent's FD table
			const { readFd, writeFd } = ki.pipe(parent.pid);

			// Spawn child — inherits both pipe ends
			const child = ki.spawn("child-cmd", [], { ppid: parent.pid });

			// Child closes its inherited write end
			ki.fdClose(child.pid, writeFd);

			// Parent writes to the pipe — should still work (parent's write end is open)
			ki.fdWrite(parent.pid, writeFd, new TextEncoder().encode("pipe data"));

			// Child reads from its inherited read end
			const data = await ki.fdRead(child.pid, readFd, 100);
			expect(new TextDecoder().decode(data)).toBe("pipe data");

			await parent.wait();
			await child.wait();
		});
	});

	// -----------------------------------------------------------------------
	// Signal forwarding
	// -----------------------------------------------------------------------

	describe("signal forwarding", () => {
		it("kill(SIGTERM) routes to DriverProcess.kill and process exits", async () => {
			const killSignals: number[] = [];
			const driver = new MockRuntimeDriver(["daemon"], {
				daemon: { neverExit: true, killSignals },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("daemon", []);
			expect(kernel.processes.get(proc.pid)?.status).toBe("running");

			proc.kill(15); // SIGTERM
			const code = await proc.wait();

			expect(killSignals).toContain(15);
			expect(code).toBe(128 + 15); // Unix convention
		});

		it("kill(SIGKILL) immediately terminates the process", async () => {
			const killSignals: number[] = [];
			const driver = new MockRuntimeDriver(["daemon"], {
				daemon: { neverExit: true, killSignals },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("daemon", []);
			proc.kill(9); // SIGKILL
			const code = await proc.wait();

			expect(killSignals).toContain(9);
			expect(code).toBe(128 + 9);
		});

		it("kill defaults to SIGTERM when no signal specified", async () => {
			const killSignals: number[] = [];
			const driver = new MockRuntimeDriver(["daemon"], {
				daemon: { neverExit: true, killSignals },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("daemon", []);
			proc.kill(); // No signal arg — default SIGTERM
			const code = await proc.wait();

			expect(killSignals).toEqual([15]);
			expect(code).toBe(128 + 15);
		});

		it("kill on non-existent PID throws ESRCH", async () => {
			const driver = new MockRuntimeDriver(["x"]);
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			// KernelInterface.kill for a PID that was never spawned
			const ki = driver.kernelInterface!;
			expect(() => ki.kill(9999, 15)).toThrow("ESRCH");
		});

		it("kill on already-exited process is a no-op", async () => {
			const killSignals: number[] = [];
			const driver = new MockRuntimeDriver(["fast-cmd"], {
				"fast-cmd": { exitCode: 0, killSignals },
			});
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("fast-cmd", []);
			await proc.wait(); // Wait for it to exit

			// kill after exit should not throw and should not deliver signal
			proc.kill(15);
			expect(killSignals).toEqual([]);
		});

		it("cross-driver signal: driver A process killed via KernelInterface from driver B", async () => {
			const killSignals: number[] = [];
			const driverA = new MockRuntimeDriver(["daemon-a"], {
				"daemon-a": { neverExit: true, killSignals },
			});
			const driverB = new MockRuntimeDriver(["worker-b"]);
			({ kernel } = await createTestKernel({ drivers: [driverA, driverB] }));

			// Spawn a process on driver A
			const procA = kernel.spawn("daemon-a", []);

			// Driver B uses KernelInterface to kill driver A's process
			const kiB = driverB.kernelInterface!;
			kiB.kill(procA.pid, 15);

			const code = await procA.wait();
			expect(killSignals).toContain(15);
			expect(code).toBe(128 + 15);
		});

		it("multiple signals can be sent to the same process", async () => {
			const killSignals: number[] = [];
			// Process ignores first SIGTERM (neverExit stays, kill captures but doesn't resolve)
			let killCount = 0;
			let exitResolve: ((code: number) => void) | null = null;

			const driver = new MockRuntimeDriver(["stubborn"]);
			// Override spawn to create a custom process that ignores first signal
			const origSpawn = driver.spawn.bind(driver);
			driver.spawn = (command, args, ctx) => {
				if (command !== "stubborn") return origSpawn(command, args, ctx);
				const exitPromise = new Promise<number>((r) => { exitResolve = r; });
				return {
					writeStdin() {},
					closeStdin() {},
					kill(signal) {
						killSignals.push(signal);
						killCount++;
						// Only exit on SIGKILL or second signal
						if (signal === 9 || killCount >= 2) {
							exitResolve!(128 + signal);
						}
					},
					wait() { return exitPromise; },
					onStdout: null,
					onStderr: null,
					onExit: null,
				};
			};
			({ kernel } = await createTestKernel({ drivers: [driver] }));

			const proc = kernel.spawn("stubborn", []);

			// First SIGTERM — process ignores it
			proc.kill(15);
			expect(killSignals).toEqual([15]);

			// SIGKILL — forces exit
			proc.kill(9);
			const code = await proc.wait();

			expect(killSignals).toEqual([15, 9]);
			expect(code).toBe(128 + 9);
		});
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
