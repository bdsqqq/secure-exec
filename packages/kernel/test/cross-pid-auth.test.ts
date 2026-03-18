import { describe, it, expect, afterEach } from "vitest";
import { createTestKernel } from "./helpers.js";
import type { Kernel, KernelInterface, ProcessContext, DriverProcess, RuntimeDriver } from "../src/types.js";

/**
 * Cross-PID authorization: each driver's KernelInterface is scoped to PIDs
 * owned by that driver. A driver cannot access FDs, kill, or manipulate
 * process groups belonging to another driver's processes.
 */
describe("cross-PID authorization", () => {
	let kernel: Kernel;

	afterEach(async () => {
		await kernel?.dispose();
	});

	// Helper: create two drivers that expose their KernelInterface and spawned PIDs
	function createTwoDrivers() {
		const spawnedPids: { alpha: number[]; beta: number[] } = { alpha: [], beta: [] };

		class SpyDriver implements RuntimeDriver {
			name: string;
			commands: string[];
			ki: KernelInterface | null = null;

			constructor(name: string, commands: string[]) {
				this.name = name;
				this.commands = commands;
			}

			async init(kernel: KernelInterface): Promise<void> {
				this.ki = kernel;
			}

			spawn(_command: string, _args: string[], ctx: ProcessContext): DriverProcess {
				const key = this.name as "alpha" | "beta";
				spawnedPids[key].push(ctx.pid);

				let exitResolve: (code: number) => void;
				const exitPromise = new Promise<number>((r) => { exitResolve = r; });

				const driverProc: DriverProcess = {
					writeStdin() {},
					closeStdin() {},
					kill(signal) {
						const code = 128 + signal;
						exitResolve!(code);
						queueMicrotask(() => driverProc.onExit?.(code));
					},
					wait() { return exitPromise; },
					onStdout: null,
					onStderr: null,
					onExit: null,
				};
				return driverProc;
			}

			async dispose(): Promise<void> {}
		}

		const alpha = new SpyDriver("alpha", ["alpha-cmd"]);
		const beta = new SpyDriver("beta", ["beta-cmd"]);

		return { alpha, beta, spawnedPids };
	}

	// -------------------------------------------------------------------
	// FD operations — driver cannot access another driver's PIDs
	// -------------------------------------------------------------------

	it("driver A cannot fdRead FDs belonging to driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		// Spawn a process in each driver (processes stay alive — neverExit)
		const procA = kernel.spawn("alpha-cmd", []);
		const procB = kernel.spawn("beta-cmd", []);

		// Alpha tries to fdRead from Beta's PID
		await expect(
			alpha.ki!.fdRead(procB.pid, 0, 1024),
		).rejects.toThrow(/EPERM.*does not own PID/);

		// Beta tries to fdRead from Alpha's PID
		await expect(
			beta.ki!.fdRead(procA.pid, 0, 1024),
		).rejects.toThrow(/EPERM.*does not own PID/);

		procA.kill();
		procB.kill();
		await procA.wait();
		await procB.wait();
	});

	it("driver A cannot fdWrite FDs belonging to driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procA = kernel.spawn("alpha-cmd", []);
		const procB = kernel.spawn("beta-cmd", []);

		const data = new Uint8Array([72, 73]);

		expect(() => alpha.ki!.fdWrite(procB.pid, 1, data)).toThrow(/EPERM/);
		expect(() => beta.ki!.fdWrite(procA.pid, 1, data)).toThrow(/EPERM/);

		procA.kill();
		procB.kill();
		await procA.wait();
		await procB.wait();
	});

	it("driver A cannot fdClose FDs belonging to driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procA = kernel.spawn("alpha-cmd", []);
		const procB = kernel.spawn("beta-cmd", []);

		expect(() => alpha.ki!.fdClose(procB.pid, 0)).toThrow(/EPERM/);

		procA.kill();
		procB.kill();
		await procA.wait();
		await procB.wait();
	});

	// -------------------------------------------------------------------
	// Process operations — driver cannot kill/setpgid another driver's PID
	// -------------------------------------------------------------------

	it("driver A cannot kill driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procA = kernel.spawn("alpha-cmd", []);
		const procB = kernel.spawn("beta-cmd", []);

		expect(() => alpha.ki!.kill(procB.pid, 15)).toThrow(/EPERM/);
		expect(() => beta.ki!.kill(procA.pid, 15)).toThrow(/EPERM/);

		procA.kill();
		procB.kill();
		await procA.wait();
		await procB.wait();
	});

	it("driver A cannot setpgid on driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procA = kernel.spawn("alpha-cmd", []);
		const procB = kernel.spawn("beta-cmd", []);

		expect(() => alpha.ki!.setpgid(procB.pid, procB.pid)).toThrow(/EPERM/);

		procA.kill();
		procB.kill();
		await procA.wait();
		await procB.wait();
	});

	it("driver A cannot getpgid/setsid/getsid on driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procA = kernel.spawn("alpha-cmd", []);
		const procB = kernel.spawn("beta-cmd", []);

		expect(() => alpha.ki!.getpgid(procB.pid)).toThrow(/EPERM/);
		expect(() => alpha.ki!.setsid(procB.pid)).toThrow(/EPERM/);
		expect(() => alpha.ki!.getsid(procB.pid)).toThrow(/EPERM/);

		procA.kill();
		procB.kill();
		await procA.wait();
		await procB.wait();
	});

	// -------------------------------------------------------------------
	// Positive: driver CAN access its own process's FDs and signals
	// -------------------------------------------------------------------

	it("driver A can access its own process FDs normally", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		// Write a file so fdRead has something to return
		await kernel.writeFile("/test.txt", "hello");

		const procA = kernel.spawn("alpha-cmd", []);

		// Open, read, write, close — all on alpha's own PID
		const fd = alpha.ki!.fdOpen(procA.pid, "/test.txt", 0);
		expect(fd).toBeGreaterThanOrEqual(0);

		const data = await alpha.ki!.fdRead(procA.pid, fd, 1024);
		expect(new TextDecoder().decode(data)).toBe("hello");

		alpha.ki!.fdClose(procA.pid, fd);

		// fdStat on stdio FDs
		const stat = alpha.ki!.fdStat(procA.pid, 0);
		expect(stat).toBeDefined();

		procA.kill();
		await procA.wait();
	});

	it("driver A can kill and signal its own process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procA = kernel.spawn("alpha-cmd", []);

		// setpgid, getpgid, kill — all on alpha's own PID
		alpha.ki!.setpgid(procA.pid, procA.pid);
		expect(alpha.ki!.getpgid(procA.pid)).toBe(procA.pid);

		alpha.ki!.kill(procA.pid, 15);
		const code = await procA.wait();
		expect(code).toBe(128 + 15);
	});

	it("driver A can create pipes in its own process", async () => {
		const { alpha } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha] }));

		const procA = kernel.spawn("alpha-cmd", []);

		const { readFd, writeFd } = alpha.ki!.pipe(procA.pid);
		expect(readFd).toBeGreaterThan(0);
		expect(writeFd).toBeGreaterThan(0);

		alpha.ki!.fdClose(procA.pid, readFd);
		alpha.ki!.fdClose(procA.pid, writeFd);

		procA.kill();
		await procA.wait();
	});

	// -------------------------------------------------------------------
	// Pipe/PTY/env/cwd — cross-driver blocked
	// -------------------------------------------------------------------

	it("driver A cannot create pipe in driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procB = kernel.spawn("beta-cmd", []);

		expect(() => alpha.ki!.pipe(procB.pid)).toThrow(/EPERM/);

		procB.kill();
		await procB.wait();
	});

	it("driver A cannot read env/cwd of driver B's process", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procB = kernel.spawn("beta-cmd", []);

		expect(() => alpha.ki!.getenv(procB.pid)).toThrow(/EPERM/);
		expect(() => alpha.ki!.getcwd(procB.pid)).toThrow(/EPERM/);

		procB.kill();
		await procB.wait();
	});

	it("driver A cannot spawn with ppid belonging to driver B", async () => {
		const { alpha, beta } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha, beta] }));

		const procB = kernel.spawn("beta-cmd", []);

		// Alpha tries to spawn using Beta's PID as parent
		expect(() =>
			alpha.ki!.spawn("alpha-cmd", [], { ppid: procB.pid }),
		).toThrow(/EPERM/);

		procB.kill();
		await procB.wait();
	});

	// -------------------------------------------------------------------
	// PID removed from ownership after process exit
	// -------------------------------------------------------------------

	it("PID ownership is cleaned up after process exits", async () => {
		const { alpha } = createTwoDrivers();
		({ kernel } = await createTestKernel({ drivers: [alpha] }));

		const proc = kernel.spawn("alpha-cmd", []);
		const pid = proc.pid;

		// Can access while alive
		alpha.ki!.fdStat(pid, 0);

		// Kill and wait for exit
		proc.kill();
		await proc.wait();

		// After exit, PID is no longer owned
		expect(() => alpha.ki!.fdStat(pid, 0)).toThrow(/EPERM|ESRCH/);
	});
});
