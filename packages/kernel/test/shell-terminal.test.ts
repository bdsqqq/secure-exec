/**
 * Shell terminal tests using MockRuntimeDriver.
 *
 * All output assertions use exact-match on screenshotTrimmed().
 * No toContain(), no substring checks — the full screen state is asserted.
 * This ensures cursor positioning, echo, and output placement are correct.
 */

import { describe, it, expect, afterEach } from "vitest";
import { TerminalHarness } from "./terminal-harness.js";
import { createTestKernel } from "./helpers.js";
import type {
	RuntimeDriver,
	DriverProcess,
	ProcessContext,
	KernelInterface,
} from "../src/types.js";

// ---------------------------------------------------------------------------
// Mock shell driver — reads lines from PTY slave via kernel FDs, interprets
// simple commands (echo), writes output + prompt back through PTY.
// ---------------------------------------------------------------------------

class MockShellDriver implements RuntimeDriver {
	name = "mock-shell";
	commands = ["sh"];
	private ki: KernelInterface | null = null;

	async init(ki: KernelInterface): Promise<void> {
		this.ki = ki;
	}

	spawn(_command: string, _args: string[], ctx: ProcessContext): DriverProcess {
		const ki = this.ki!;
		const { pid } = ctx;
		const stdinFd = ctx.fds.stdin;
		const stdoutFd = ctx.fds.stdout;

		let exitResolve: (code: number) => void;
		const exitPromise = new Promise<number>((r) => {
			exitResolve = r;
		});

		const enc = new TextEncoder();
		const dec = new TextDecoder();

		const proc: DriverProcess = {
			writeStdin() {},
			closeStdin() {},
			kill(signal) {
				exitResolve!(128 + signal);
				proc.onExit?.(128 + signal);
			},
			wait() {
				return exitPromise;
			},
			onStdout: null,
			onStderr: null,
			onExit: null,
		};

		// Shell read-eval-print loop
		(async () => {
			// Write initial prompt
			ki.fdWrite(pid, stdoutFd, enc.encode("$ "));

			while (true) {
				const data = await ki.fdRead(pid, stdinFd, 4096);
				if (data.length === 0) {
					// EOF (^D on empty line)
					exitResolve!(0);
					proc.onExit?.(0);
					break;
				}

				const line = dec.decode(data).replace(/\n$/, "");

				// Simple command dispatch
				if (line.startsWith("echo ")) {
					ki.fdWrite(pid, stdoutFd, enc.encode(line.slice(5) + "\r\n"));
				} else if (line.length > 0) {
					// Unknown command — just emit a newline
					ki.fdWrite(pid, stdoutFd, enc.encode("\r\n"));
				}

				// Next prompt
				ki.fdWrite(pid, stdoutFd, enc.encode("$ "));
			}
		})().catch(() => {
			exitResolve!(1);
			proc.onExit?.(1);
		});

		return proc;
	}

	async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("shell-terminal", () => {
	let harness: TerminalHarness;

	afterEach(async () => {
		await harness?.dispose();
	});

	it("clean initial state — shell opens, screen shows prompt", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");

		expect(harness.screenshotTrimmed()).toBe("$ ");
	});

	it("echo on input — typed text appears on screen via PTY echo", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");
		await harness.type("hello");

		expect(harness.screenshotTrimmed()).toBe("$ hello");
	});

	it("command output on correct line — output appears below input", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");
		await harness.type("echo hello\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ echo hello", "hello", "$ "].join("\n"),
		);
	});

	it("output preservation — multiple commands, all previous output visible", async () => {
		const driver = new MockShellDriver();
		const { kernel } = await createTestKernel({ drivers: [driver] });
		harness = new TerminalHarness(kernel);

		await harness.waitFor("$");
		await harness.type("echo AAA\n");
		await harness.type("echo BBB\n");

		expect(harness.screenshotTrimmed()).toBe(
			["$ echo AAA", "AAA", "$ echo BBB", "BBB", "$ "].join("\n"),
		);
	});
});
