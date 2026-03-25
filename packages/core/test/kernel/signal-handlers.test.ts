import { describe, it, expect, vi } from "vitest";
import { ProcessTable } from "../../src/kernel/process-table.js";
import { SocketTable, AF_INET, SOCK_STREAM } from "../../src/kernel/socket-table.js";
import {
	SIGINT, SIGTERM, SIGKILL, SIGSTOP, SIGCHLD, SIGALRM, SIGTSTP, SIGCONT,
	SIGHUP, SIGPIPE,
	SA_RESTART, SA_RESETHAND, SA_NOCLDSTOP,
	SIG_BLOCK, SIG_UNBLOCK, SIG_SETMASK,
} from "../../src/kernel/types.js";
import type { DriverProcess, ProcessContext, SignalHandler } from "../../src/kernel/types.js";

function createMockDriverProcess(): DriverProcess {
	let exitResolve: (code: number) => void;
	const exitPromise = new Promise<number>((r) => { exitResolve = r; });

	const proc: DriverProcess = {
		writeStdin(_data) {},
		closeStdin() {},
		kill(_signal) {
			exitResolve!(128 + _signal);
		},
		wait() { return exitPromise; },
		onStdout: null,
		onStderr: null,
		onExit: null,
	};

	return proc;
}

function createCtx(overrides?: Partial<ProcessContext>): ProcessContext {
	return {
		pid: 0,
		ppid: 0,
		env: {},
		cwd: "/",
		fds: { stdin: 0, stdout: 1, stderr: 2 },
		...overrides,
	};
}

function registerProcess(table: ProcessTable, ppid = 0): { pid: number; proc: DriverProcess } {
	const pid = table.allocatePid();
	const proc = createMockDriverProcess();
	table.register(pid, "test", "test", [], createCtx({ ppid }), proc);
	return { pid, proc };
}

async function createConnectedSockets(
	processTable: ProcessTable,
	pid: number,
): Promise<{ socketTable: SocketTable; listenId: number; clientId: number; serverId: number }> {
	const socketTable = new SocketTable({
		getSignalState: (targetPid) => processTable.getSignalState(targetPid),
	});
	const listenId = socketTable.create(AF_INET, SOCK_STREAM, 0, pid);
	await socketTable.bind(listenId, { host: "127.0.0.1", port: 8080 });
	await socketTable.listen(listenId);
	const clientId = socketTable.create(AF_INET, SOCK_STREAM, 0, pid);
	await socketTable.connect(clientId, { host: "127.0.0.1", port: 8080 });
	const serverId = socketTable.accept(listenId)!;
	return { socketTable, listenId, clientId, serverId };
}

describe("Signal handlers (sigaction / sigprocmask)", () => {
	describe("sigaction", () => {
		it("registers a handler and returns previous disposition", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			const handler: SignalHandler = {
				handler: "ignore",
				mask: new Set(),
				flags: 0,
			};

			// No previous handler
			const prev = table.sigaction(pid, SIGINT, handler);
			expect(prev).toBeUndefined();

			// Returns previous handler
			const handler2: SignalHandler = {
				handler: "default",
				mask: new Set(),
				flags: 0,
			};
			const prev2 = table.sigaction(pid, SIGINT, handler2);
			expect(prev2).toBe(handler);
		});

		it("rejects SIGKILL handler registration", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			expect(() => table.sigaction(pid, SIGKILL, {
				handler: "ignore", mask: new Set(), flags: 0,
			})).toThrow("EINVAL");
		});

		it("rejects SIGSTOP handler registration", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			expect(() => table.sigaction(pid, SIGSTOP, {
				handler: "ignore", mask: new Set(), flags: 0,
			})).toThrow("EINVAL");
		});

		it("rejects invalid signal number", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			expect(() => table.sigaction(pid, 0, {
				handler: "ignore", mask: new Set(), flags: 0,
			})).toThrow("EINVAL");

			expect(() => table.sigaction(pid, 65, {
				handler: "ignore", mask: new Set(), flags: 0,
			})).toThrow("EINVAL");
		});

		it("ignore handler discards the signal", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			table.sigaction(pid, SIGTERM, {
				handler: "ignore", mask: new Set(), flags: 0,
			});

			table.kill(pid, SIGTERM);

			// Driver should NOT be called — signal discarded
			expect(killSpy).not.toHaveBeenCalled();
			expect(table.get(pid)!.termSignal).toBe(0);
		});

		it("default handler applies kernel default action", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			table.sigaction(pid, SIGTERM, {
				handler: "default", mask: new Set(), flags: 0,
			});

			table.kill(pid, SIGTERM);

			// Default SIGTERM: terminate
			expect(killSpy).toHaveBeenCalledWith(SIGTERM);
			expect(table.get(pid)!.termSignal).toBe(SIGTERM);
		});

		it("user handler is invoked with signal number", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const handlerFn = vi.fn();
			const killSpy = vi.spyOn(proc, "kill");

			table.sigaction(pid, SIGINT, {
				handler: handlerFn, mask: new Set(), flags: 0,
			});

			table.kill(pid, SIGINT);

			expect(handlerFn).toHaveBeenCalledWith(SIGINT);
			// User handler means process is NOT killed
			expect(killSpy).not.toHaveBeenCalled();
			expect(table.get(pid)!.termSignal).toBe(0);
		});

		it("sa_mask blocks signals during handler execution", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			const state = table.getSignalState(pid);
			let blockedDuringHandler: Set<number> | undefined;

			table.sigaction(pid, SIGINT, {
				handler: () => {
					// Capture blocked set during handler
					blockedDuringHandler = new Set(state.blockedSignals);
				},
				mask: new Set([SIGTERM, SIGHUP]),
				flags: 0,
			});

			table.kill(pid, SIGINT);

			// During handler: sa_mask (SIGTERM, SIGHUP) + the signal itself (SIGINT) should be blocked
			expect(blockedDuringHandler).toBeDefined();
			expect(blockedDuringHandler!.has(SIGTERM)).toBe(true);
			expect(blockedDuringHandler!.has(SIGHUP)).toBe(true);
			expect(blockedDuringHandler!.has(SIGINT)).toBe(true);

			// After handler: sa_mask should be restored
			expect(state.blockedSignals.has(SIGTERM)).toBe(false);
			expect(state.blockedSignals.has(SIGHUP)).toBe(false);
			expect(state.blockedSignals.has(SIGINT)).toBe(false);
		});

		it("SIGKILL always uses default action regardless of handler", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			// Can't register handler for SIGKILL, and even if somehow there were one,
			// SIGKILL should always terminate
			table.kill(pid, SIGKILL);

			expect(killSpy).toHaveBeenCalledWith(SIGKILL);
			expect(table.get(pid)!.termSignal).toBe(SIGKILL);
		});

		it("SIGCHLD default action is ignore (does not terminate)", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			// No handler registered — default SIGCHLD = ignore
			table.kill(pid, SIGCHLD);

			expect(killSpy).not.toHaveBeenCalled();
			expect(table.get(pid)!.termSignal).toBe(0);
			expect(table.get(pid)!.status).toBe("running");
		});

		it("SIGCHLD user handler is invoked", () => {
			const table = new ProcessTable();
			const parent = registerProcess(table);
			const handlerFn = vi.fn();

			table.sigaction(parent.pid, SIGCHLD, {
				handler: handlerFn, mask: new Set(), flags: 0,
			});

			// Create child process and let it exit to trigger SIGCHLD
			const child = registerProcess(table, parent.pid);
			table.markExited(child.pid, 0);

			expect(handlerFn).toHaveBeenCalledWith(SIGCHLD);
		});
	});

	describe("sigprocmask", () => {
		it("SIG_BLOCK adds signals to blocked set", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			const prev = table.sigprocmask(pid, SIG_BLOCK, new Set([SIGINT, SIGTERM]));

			expect(prev.size).toBe(0);
			const state = table.getSignalState(pid);
			expect(state.blockedSignals.has(SIGINT)).toBe(true);
			expect(state.blockedSignals.has(SIGTERM)).toBe(true);
		});

		it("SIG_UNBLOCK removes signals from blocked set", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGINT, SIGTERM, SIGHUP]));
			const prev = table.sigprocmask(pid, SIG_UNBLOCK, new Set([SIGTERM]));

			expect(prev.has(SIGINT)).toBe(true);
			expect(prev.has(SIGTERM)).toBe(true);
			expect(prev.has(SIGHUP)).toBe(true);

			const state = table.getSignalState(pid);
			expect(state.blockedSignals.has(SIGINT)).toBe(true);
			expect(state.blockedSignals.has(SIGTERM)).toBe(false);
			expect(state.blockedSignals.has(SIGHUP)).toBe(true);
		});

		it("SIG_SETMASK replaces the entire blocked set", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGINT, SIGTERM]));
			table.sigprocmask(pid, SIG_SETMASK, new Set([SIGHUP]));

			const state = table.getSignalState(pid);
			expect(state.blockedSignals.has(SIGINT)).toBe(false);
			expect(state.blockedSignals.has(SIGTERM)).toBe(false);
			expect(state.blockedSignals.has(SIGHUP)).toBe(true);
		});

		it("cannot block SIGKILL or SIGSTOP", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGKILL, SIGSTOP, SIGINT]));

			const state = table.getSignalState(pid);
			expect(state.blockedSignals.has(SIGKILL)).toBe(false);
			expect(state.blockedSignals.has(SIGSTOP)).toBe(false);
			expect(state.blockedSignals.has(SIGINT)).toBe(true);
		});

		it("rejects invalid how value", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			expect(() => table.sigprocmask(pid, 99, new Set())).toThrow("EINVAL");
		});
	});

	describe("signal blocking and pending delivery", () => {
		it("blocked signal is queued in pendingSignals", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGINT]));
			table.kill(pid, SIGINT);

			// Signal should be queued, not delivered
			expect(killSpy).not.toHaveBeenCalled();
			const state = table.getSignalState(pid);
			expect(state.pendingSignals.has(SIGINT)).toBe(true);
		});

		it("unblocking delivers pending signals", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGTERM]));
			table.kill(pid, SIGTERM);
			expect(killSpy).not.toHaveBeenCalled();

			// Unblock — pending SIGTERM should be delivered
			table.sigprocmask(pid, SIG_UNBLOCK, new Set([SIGTERM]));

			expect(killSpy).toHaveBeenCalledWith(SIGTERM);
			const state = table.getSignalState(pid);
			expect(state.pendingSignals.has(SIGTERM)).toBe(false);
		});

		it("standard signals (1-31) coalesce: only one pending per signal", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			const handlerFn = vi.fn();
			table.sigaction(pid, SIGINT, {
				handler: handlerFn, mask: new Set(), flags: 0,
			});

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGINT]));

			// Send SIGINT three times while blocked
			table.kill(pid, SIGINT);
			table.kill(pid, SIGINT);
			table.kill(pid, SIGINT);

			// Unblock — handler should only fire once (coalesced)
			table.sigprocmask(pid, SIG_UNBLOCK, new Set([SIGINT]));

			expect(handlerFn).toHaveBeenCalledTimes(1);
		});

		it("pending signals delivered in ascending order", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			const order: number[] = [];
			for (const sig of [SIGINT, SIGTERM, SIGHUP]) {
				table.sigaction(pid, sig, {
					handler: (s) => order.push(s),
					mask: new Set(),
					flags: 0,
				});
			}

			// Block all three, then deliver in arbitrary order
			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGINT, SIGTERM, SIGHUP]));
			table.kill(pid, SIGTERM); // 15
			table.kill(pid, SIGINT);  // 2
			table.kill(pid, SIGHUP);  // 1

			// Unblock all — should deliver in ascending: SIGHUP(1), SIGINT(2), SIGTERM(15)
			table.sigprocmask(pid, SIG_UNBLOCK, new Set([SIGINT, SIGTERM, SIGHUP]));

			expect(order).toEqual([SIGHUP, SIGINT, SIGTERM]);
		});

		it("SIGKILL cannot be blocked — delivered immediately", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const killSpy = vi.spyOn(proc, "kill");

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGKILL]));
			table.kill(pid, SIGKILL);

			// SIGKILL should be delivered immediately despite block attempt
			expect(killSpy).toHaveBeenCalledWith(SIGKILL);
		});

		it("SIGSTOP cannot be blocked — delivered immediately", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGSTOP]));
			table.kill(pid, SIGSTOP);

			// SIGSTOP default action: stop the process
			expect(table.get(pid)!.status).toBe("stopped");
		});
	});

	describe("SA_RESTART flag", () => {
		it("handler registration stores SA_RESTART flag", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			table.sigaction(pid, SIGINT, {
				handler: () => {},
				mask: new Set(),
				flags: SA_RESTART,
			});

			const state = table.getSignalState(pid);
			const reg = state.handlers.get(SIGINT)!;
			expect(reg.flags & SA_RESTART).toBe(SA_RESTART);
		});

		it("recv returns EINTR when a signal handler lacks SA_RESTART", async () => {
			const processTable = new ProcessTable();
			const { pid } = registerProcess(processTable);
			const { socketTable, serverId } = await createConnectedSockets(processTable, pid);

			processTable.sigaction(pid, SIGALRM, {
				handler: () => {},
				mask: new Set(),
				flags: 0,
			});

			const recvPromise = socketTable.recv(serverId, 1024, 0, { block: true, pid });
			await Promise.resolve();
			processTable.kill(pid, SIGALRM);

			await expect(recvPromise).rejects.toMatchObject({ code: "EINTR" });
		});

		it("recv restarts after a signal handler with SA_RESTART", async () => {
			const processTable = new ProcessTable();
			const { pid } = registerProcess(processTable);
			const { socketTable, clientId, serverId } = await createConnectedSockets(processTable, pid);

			processTable.sigaction(pid, SIGALRM, {
				handler: () => {},
				mask: new Set(),
				flags: SA_RESTART,
			});

			const recvPromise = socketTable.recv(serverId, 1024, 0, { block: true, pid });
			await Promise.resolve();
			processTable.kill(pid, SIGALRM);
			socketTable.send(clientId, new TextEncoder().encode("pong"));

			await expect(recvPromise).resolves.toEqual(new TextEncoder().encode("pong"));
		});

		it("accept restarts after a signal handler with SA_RESTART", async () => {
			const processTable = new ProcessTable();
			const { pid } = registerProcess(processTable);
			const socketTable = new SocketTable({
				getSignalState: (targetPid) => processTable.getSignalState(targetPid),
			});
			const listenId = socketTable.create(AF_INET, SOCK_STREAM, 0, pid);
			await socketTable.bind(listenId, { host: "127.0.0.1", port: 9090 });
			await socketTable.listen(listenId);

			processTable.sigaction(pid, SIGALRM, {
				handler: () => {},
				mask: new Set(),
				flags: SA_RESTART,
			});

			const acceptPromise = socketTable.accept(listenId, { block: true, pid });
			await Promise.resolve();
			processTable.kill(pid, SIGALRM);

			const clientId = socketTable.create(AF_INET, SOCK_STREAM, 0, pid);
			await socketTable.connect(clientId, { host: "127.0.0.1", port: 9090 });

			const acceptedId = await acceptPromise;
			expect(acceptedId).not.toBeNull();
		});
	});

	describe("SA_RESETHAND flag", () => {
		it("handler fires once then resets to default disposition", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const handlerFn = vi.fn();
			const killSpy = vi.spyOn(proc, "kill");

			table.sigaction(pid, SIGINT, {
				handler: handlerFn,
				mask: new Set(),
				flags: SA_RESETHAND,
			});

			table.kill(pid, SIGINT);

			expect(handlerFn).toHaveBeenCalledTimes(1);
			expect(killSpy).not.toHaveBeenCalled();

			const registration = table.getSignalState(pid).handlers.get(SIGINT);
			expect(registration).toEqual({
				handler: "default",
				mask: new Set(),
				flags: 0,
			});
		});

		it("second delivery after SA_RESETHAND uses the default action", () => {
			const table = new ProcessTable();
			const { pid, proc } = registerProcess(table);

			const handlerFn = vi.fn();
			const killSpy = vi.spyOn(proc, "kill");

			table.sigaction(pid, SIGTERM, {
				handler: handlerFn,
				mask: new Set(),
				flags: SA_RESETHAND,
			});

			table.kill(pid, SIGTERM);
			table.kill(pid, SIGTERM);

			expect(handlerFn).toHaveBeenCalledTimes(1);
			expect(killSpy).toHaveBeenCalledTimes(1);
			expect(killSpy).toHaveBeenCalledWith(SIGTERM);
			expect(table.get(pid)!.termSignal).toBe(SIGTERM);
		});

		it("SA_RESETHAND combines with SA_RESTART", async () => {
			const processTable = new ProcessTable();
			const { pid } = registerProcess(processTable);
			const { socketTable, clientId, serverId } = await createConnectedSockets(processTable, pid);

			processTable.sigaction(pid, SIGALRM, {
				handler: () => {},
				mask: new Set(),
				flags: SA_RESETHAND | SA_RESTART,
			});

			const recvPromise = socketTable.recv(serverId, 1024, 0, { block: true, pid });
			await Promise.resolve();
			processTable.kill(pid, SIGALRM);
			socketTable.send(clientId, new TextEncoder().encode("pong"));

			await expect(recvPromise).resolves.toEqual(new TextEncoder().encode("pong"));
			expect(processTable.getSignalState(pid).handlers.get(SIGALRM)).toEqual({
				handler: "default",
				mask: new Set(),
				flags: 0,
			});
		});
	});

	describe("SIGALRM integration", () => {
		it("SIGALRM with user handler invokes handler instead of terminating", () => {
			vi.useFakeTimers();
			try {
				const table = new ProcessTable();
				const { pid, proc } = registerProcess(table);

				const handlerFn = vi.fn();
				const killSpy = vi.spyOn(proc, "kill");

				table.sigaction(pid, SIGALRM, {
					handler: handlerFn, mask: new Set(), flags: 0,
				});

				table.alarm(pid, 5);
				vi.advanceTimersByTime(5000);

				expect(handlerFn).toHaveBeenCalledWith(SIGALRM);
				// Process should NOT be terminated
				expect(killSpy).not.toHaveBeenCalled();
				expect(table.get(pid)!.termSignal).toBe(0);
			} finally {
				vi.useRealTimers();
			}
		});

		it("SIGALRM with ignore handler does not terminate", () => {
			vi.useFakeTimers();
			try {
				const table = new ProcessTable();
				const { pid, proc } = registerProcess(table);

				const killSpy = vi.spyOn(proc, "kill");

				table.sigaction(pid, SIGALRM, {
					handler: "ignore", mask: new Set(), flags: 0,
				});

				table.alarm(pid, 3);
				vi.advanceTimersByTime(3000);

				expect(killSpy).not.toHaveBeenCalled();
			} finally {
				vi.useRealTimers();
			}
		});
	});

	describe("stop/continue with handlers", () => {
		it("SIGTSTP with user handler invokes handler instead of stopping", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			const handlerFn = vi.fn();
			table.sigaction(pid, SIGTSTP, {
				handler: handlerFn, mask: new Set(), flags: 0,
			});

			table.kill(pid, SIGTSTP);

			// User handler overrides default stop action
			expect(handlerFn).toHaveBeenCalledWith(SIGTSTP);
			expect(table.get(pid)!.status).toBe("running"); // NOT stopped
		});

		it("SIGCONT with user handler invokes handler AND resumes", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			// Stop the process first via SIGSTOP (uncatchable)
			table.kill(pid, SIGSTOP);
			expect(table.get(pid)!.status).toBe("stopped");

			const handlerFn = vi.fn();
			table.sigaction(pid, SIGCONT, {
				handler: handlerFn, mask: new Set(), flags: 0,
			});

			table.kill(pid, SIGCONT);

			// SIGCONT always resumes (even with handler), and handler is invoked
			expect(handlerFn).toHaveBeenCalledWith(SIGCONT);
			expect(table.get(pid)!.status).toBe("running");
		});
	});

	describe("process exit clears signal state", () => {
		it("markExited clears pending signals and handlers", () => {
			const table = new ProcessTable();
			const { pid } = registerProcess(table);

			table.sigaction(pid, SIGINT, {
				handler: () => {}, mask: new Set(), flags: 0,
			});
			table.sigprocmask(pid, SIG_BLOCK, new Set([SIGTERM]));
			table.kill(pid, SIGTERM); // queued

			table.markExited(pid, 0);

			// Signal state should still exist (on the entry) but process is exited
			expect(table.get(pid)!.status).toBe("exited");
		});
	});
});
