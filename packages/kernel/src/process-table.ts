/**
 * Process table.
 *
 * Universal process tracking across all runtimes. Owns PID allocation,
 * parent-child relationships, waitpid, and signal routing. A WasmVM
 * shell can waitpid on a Node child process.
 */

import type { DriverProcess, ProcessContext, ProcessEntry, ProcessInfo } from "./types.js";

const ZOMBIE_TTL_MS = 60_000;

export class ProcessTable {
	private entries: Map<number, ProcessEntry> = new Map();
	private nextPid = 1;
	private waiters: Map<number, Array<(info: { pid: number; status: number }) => void>> = new Map();
	private zombieTimers: Map<number, ReturnType<typeof setTimeout>> = new Map();

	/** Called when a process exits, before waiters are notified. */
	onProcessExit: ((pid: number) => void) | null = null;

	/** Atomically allocate the next PID. */
	allocatePid(): number {
		return this.nextPid++;
	}

	/** Register a process with a pre-allocated PID. */
	register(
		pid: number,
		driver: string,
		command: string,
		args: string[],
		ctx: ProcessContext,
		driverProcess: DriverProcess,
	): ProcessEntry {
		const entry: ProcessEntry = {
			pid,
			ppid: ctx.ppid,
			driver,
			command,
			args,
			status: "running",
			exitCode: null,
			exitTime: null,
			env: { ...ctx.env },
			cwd: ctx.cwd,
			driverProcess,
		};
		this.entries.set(pid, entry);

		// Wire up exit callback to mark process as exited
		driverProcess.onExit = (code: number) => {
			this.markExited(pid, code);
		};

		return entry;
	}

	get(pid: number): ProcessEntry | undefined {
		return this.entries.get(pid);
	}

	/** Mark a process as exited with the given code. Notifies waiters. */
	markExited(pid: number, exitCode: number): void {
		const entry = this.entries.get(pid);
		if (!entry) return;
		if (entry.status === "exited") return;

		entry.status = "exited";
		entry.exitCode = exitCode;
		entry.exitTime = Date.now();

		// Clean up process resources (FD table, pipe ends)
		this.onProcessExit?.(pid);

		// Notify waiters
		const waiters = this.waiters.get(pid);
		if (waiters) {
			for (const resolve of waiters) {
				resolve({ pid, status: exitCode });
			}
			this.waiters.delete(pid);
		}

		// Schedule zombie cleanup (tracked for cancellation on dispose)
		const timer = setTimeout(() => {
			this.zombieTimers.delete(pid);
			this.reap(pid);
		}, ZOMBIE_TTL_MS);
		this.zombieTimers.set(pid, timer);
	}

	/**
	 * Wait for a process to exit.
	 * If already exited, resolves immediately. Otherwise blocks until exit.
	 */
	waitpid(pid: number): Promise<{ pid: number; status: number }> {
		const entry = this.entries.get(pid);
		if (!entry) {
			return Promise.reject(new Error(`ESRCH: no such process ${pid}`));
		}

		if (entry.status === "exited") {
			return Promise.resolve({ pid, status: entry.exitCode! });
		}

		return new Promise((resolve) => {
			let waiters = this.waiters.get(pid);
			if (!waiters) {
				waiters = [];
				this.waiters.set(pid, waiters);
			}
			waiters.push(resolve);
		});
	}

	/** Send a signal to a process via its driver. */
	kill(pid: number, signal: number): void {
		const entry = this.entries.get(pid);
		if (!entry) throw new Error(`ESRCH: no such process ${pid}`);
		if (entry.status === "exited") return;
		entry.driverProcess.kill(signal);
	}

	/** Get the parent PID for a process. */
	getppid(pid: number): number {
		const entry = this.entries.get(pid);
		if (!entry) throw new Error(`ESRCH: no such process ${pid}`);
		return entry.ppid;
	}

	/** Get a read-only view of process info for all processes. */
	listProcesses(): Map<number, ProcessInfo> {
		const result = new Map<number, ProcessInfo>();
		for (const [pid, entry] of this.entries) {
			result.set(pid, {
				pid: entry.pid,
				ppid: entry.ppid,
				driver: entry.driver,
				command: entry.command,
				status: entry.status,
				exitCode: entry.exitCode,
			});
		}
		return result;
	}

	/** Remove a zombie process. */
	private reap(pid: number): void {
		const entry = this.entries.get(pid);
		if (entry?.status === "exited") {
			this.entries.delete(pid);
		}
	}

	/** Terminate all running processes and clear pending timers. */
	async terminateAll(): Promise<void> {
		// Clear all zombie cleanup timers to prevent post-dispose firings
		for (const timer of this.zombieTimers.values()) {
			clearTimeout(timer);
		}
		this.zombieTimers.clear();

		const running = [...this.entries.values()].filter(
			(e) => e.status === "running",
		);
		for (const entry of running) {
			try {
				entry.driverProcess.kill(15); // SIGTERM
			} catch {
				// Best effort
			}
		}
		// Wait briefly for exits
		await Promise.allSettled(
			running.map((e) =>
				Promise.race([
					e.driverProcess.wait(),
					new Promise((r) => setTimeout(r, 1000)),
				]),
			),
		);
	}
}
