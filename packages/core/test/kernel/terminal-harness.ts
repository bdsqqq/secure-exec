/**
 * TerminalHarness — wires openShell() to a headless xterm Terminal for
 * deterministic screen-state assertions in tests.
 */

import { Terminal } from "@xterm/headless";
import type { Kernel, OpenShellOptions, ShellHandle } from "../../src/kernel/types.js";

/** Settlement window: resolve type() after this many ms of no new output. */
const SETTLE_MS = 50;
/** Poll interval for waitFor(). */
const POLL_MS = 20;
/** Default waitFor() timeout. */
const DEFAULT_WAIT_TIMEOUT_MS = 2_000;

export class TerminalHarness {
	readonly term: Terminal;
	readonly shell: ShellHandle;
	private typing = false;
	private disposed = false;

	constructor(kernel: Kernel, options?: OpenShellOptions) {
		const cols = options?.cols ?? 80;
		const rows = options?.rows ?? 24;

		this.term = new Terminal({ cols, rows, allowProposedApi: true });

		this.shell = kernel.openShell({ ...options, cols, rows });

		// Wire shell output → xterm
		this.shell.onData = (data: Uint8Array) => {
			this.term.write(data);
		};
	}

	/**
	 * Send input through the PTY. Resolves after output settles (no new bytes
	 * received for SETTLE_MS). Rejects if called while a previous type() is
	 * in-flight.
	 */
	async type(input: string): Promise<void> {
		if (this.typing) {
			throw new Error("TerminalHarness.type() called while previous type() is still in-flight");
		}
		this.typing = true;
		try {
			await this.typeInternal(input);
		} finally {
			this.typing = false;
		}
	}

	private typeInternal(input: string): Promise<void> {
		return new Promise<void>((resolve) => {
			let timer: ReturnType<typeof setTimeout> | null = null;

			const resetTimer = () => {
				if (timer !== null) clearTimeout(timer);
				timer = setTimeout(() => {
					// Unhook and resolve
					this.shell.onData = originalOnData;
					resolve();
				}, SETTLE_MS);
			};

			// Intercept shell output to detect settlement
			const originalOnData = this.shell.onData;
			this.shell.onData = (data: Uint8Array) => {
				this.term.write(data);
				resetTimer();
			};

			// Start settlement timer before writing (in case no output comes)
			resetTimer();

			// Write input to shell
			this.shell.write(input);
		});
	}

	/**
	 * Full screen as a string: viewport rows only (not scrollback), trailing
	 * whitespace trimmed per line, trailing empty lines dropped, joined with '\n'.
	 */
	screenshotTrimmed(): string {
		const buf = this.term.buffer.active;
		const rows = this.term.rows;
		const lines: string[] = [];

		for (let y = 0; y < rows; y++) {
			const line = buf.getLine(buf.viewportY + y);
			lines.push(line ? line.translateToString(true) : "");
		}

		// Drop trailing empty lines
		while (lines.length > 0 && lines[lines.length - 1] === "") {
			lines.pop();
		}

		return lines.join("\n");
	}

	/**
	 * Single trimmed row from the screen buffer (0-indexed from viewport top).
	 */
	line(row: number): string {
		const buf = this.term.buffer.active;
		const line = buf.getLine(buf.viewportY + row);
		return line ? line.translateToString(true) : "";
	}

	/**
	 * Poll screen buffer every POLL_MS until `text` is found. Throws a
	 * descriptive error on timeout (includes expected text, timeout, and
	 * actual screen content). Checks shell.exitCode in poll loop and
	 * throws immediately if shell died.
	 */
	async waitFor(
		text: string,
		occurrence: number = 1,
		timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
	): Promise<void> {
		const deadline = Date.now() + timeoutMs;

		while (true) {
			const screen = this.screenshotTrimmed();

			// Count occurrences
			let count = 0;
			let idx = -1;
			while (true) {
				idx = screen.indexOf(text, idx + 1);
				if (idx === -1) break;
				count++;
				if (count >= occurrence) return;
			}

			// Check if shell has died
			const exitCode = await Promise.race([
				this.shell.wait(),
				new Promise<null>((r) => setTimeout(() => r(null), 0)),
			]);
			if (exitCode !== null) {
				throw new Error(
					`waitFor("${text}") failed: shell exited with code ${exitCode} before text appeared.\n` +
					`Screen:\n${screen}`,
				);
			}

			if (Date.now() >= deadline) {
				throw new Error(
					`waitFor("${text}", ${occurrence}) timed out after ${timeoutMs}ms.\n` +
					`Expected: "${text}" (occurrence ${occurrence})\n` +
					`Screen:\n${screen}`,
				);
			}

			await new Promise((r) => setTimeout(r, POLL_MS));
		}
	}

	/**
	 * Send ^D on empty line and await shell exit. Returns exit code.
	 */
	async exit(): Promise<number> {
		this.shell.write("\x04"); // ^D
		return this.shell.wait();
	}

	/**
	 * Kill shell and dispose terminal. Safe to call multiple times.
	 * Tests must call in afterEach or use try/finally to prevent resource leaks.
	 */
	async dispose(): Promise<void> {
		if (this.disposed) return;
		this.disposed = true;

		try {
			this.shell.kill();
			// Wait briefly for exit, don't hang if already exited
			await Promise.race([
				this.shell.wait(),
				new Promise((r) => setTimeout(r, 500)),
			]);
		} catch {
			// Shell may already be dead
		}

		this.term.dispose();
	}
}
