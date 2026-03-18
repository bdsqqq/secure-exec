/**
 * Resource exhaustion and unbounded buffering tests.
 *
 * Verifies that the kernel enforces bounded buffers and FD limits
 * to prevent host memory buildup from sandboxed code.
 */

import { describe, it, expect } from "vitest";
import { PipeManager, MAX_PIPE_BUFFER_BYTES } from "../src/pipe-manager.js";
import { ProcessFDTable, MAX_FDS_PER_PROCESS } from "../src/fd-table.js";
import { PtyManager, MAX_PTY_BUFFER_BYTES } from "../src/pty.js";
import { KernelError } from "../src/types.js";

describe("pipe buffer limit", () => {
	it("rejects writes that exceed MAX_PIPE_BUFFER_BYTES when no reader", () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		// Fill the buffer up to the limit
		const chunk = new Uint8Array(MAX_PIPE_BUFFER_BYTES);
		manager.write(write.description.id, chunk);

		// Next write should fail with EAGAIN
		const extra = new Uint8Array(1);
		expect(() => manager.write(write.description.id, extra)).toThrowError(
			expect.objectContaining({ code: "EAGAIN" }),
		);

		// Keep reference alive to prevent cleanup
		expect(manager.isPipe(read.description.id)).toBe(true);
	});

	it("allows writes when a reader drains the buffer", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		// Fill buffer
		const chunk = new Uint8Array(MAX_PIPE_BUFFER_BYTES);
		manager.write(write.description.id, chunk);

		// Drain the buffer
		await manager.read(read.description.id, MAX_PIPE_BUFFER_BYTES);

		// Write should succeed again
		expect(() =>
			manager.write(write.description.id, new Uint8Array(1024)),
		).not.toThrow();
	});

	it("delivers directly to waiting reader without buffering (no limit hit)", async () => {
		const manager = new PipeManager();
		const { read, write } = manager.createPipe();

		// Start a read (blocks waiting for data)
		const readPromise = manager.read(read.description.id, MAX_PIPE_BUFFER_BYTES + 1024);

		// Write large data — delivered directly to waiter, not buffered
		const bigChunk = new Uint8Array(MAX_PIPE_BUFFER_BYTES + 1024);
		expect(() => manager.write(write.description.id, bigChunk)).not.toThrow();

		const result = await readPromise;
		expect(result!.length).toBe(MAX_PIPE_BUFFER_BYTES + 1024);
	});
});

describe("FD exhaustion", () => {
	it("throws EMFILE when per-process FD limit is reached", () => {
		const table = new ProcessFDTable();

		// Open FDs up to the limit (3 stdio FDs are not pre-allocated unless initStdio is called)
		const opened: number[] = [];
		for (let i = 0; i < MAX_FDS_PER_PROCESS; i++) {
			opened.push(table.open(`/tmp/file-${i}`, 0));
		}
		expect(opened.length).toBe(MAX_FDS_PER_PROCESS);

		// Next open should fail
		expect(() => table.open("/tmp/overflow", 0)).toThrowError(
			expect.objectContaining({ code: "EMFILE" }),
		);
	});

	it("allows new FDs after closing old ones", () => {
		const table = new ProcessFDTable();

		// Fill to limit, keep track of first FD
		let firstFd = -1;
		for (let i = 0; i < MAX_FDS_PER_PROCESS; i++) {
			const fd = table.open(`/tmp/file-${i}`, 0);
			if (i === 0) firstFd = fd;
		}

		// Close one
		table.close(firstFd);

		// Should be able to open one more
		expect(() => table.open("/tmp/reclaimed", 0)).not.toThrow();
	});

	it("dup counts toward FD limit", () => {
		const table = new ProcessFDTable();

		// Fill to limit - 1, then open one
		for (let i = 0; i < MAX_FDS_PER_PROCESS - 1; i++) {
			table.open(`/tmp/file-${i}`, 0);
		}
		const lastFd = table.open("/tmp/last", 0);

		// dup should fail (already at limit)
		expect(() => table.dup(lastFd)).toThrowError(
			expect.objectContaining({ code: "EMFILE" }),
		);
	});
});

describe("PTY buffer limit", () => {
	it("rejects slave writes that exceed MAX_PTY_BUFFER_BYTES when master does not read", () => {
		const manager = new PtyManager();
		const { master, slave } = manager.createPty();

		// Fill output buffer (slave write → master read direction)
		const chunk = new Uint8Array(MAX_PTY_BUFFER_BYTES);
		manager.write(slave.description.id, chunk);

		// Next write should fail
		expect(() =>
			manager.write(slave.description.id, new Uint8Array(1)),
		).toThrowError(expect.objectContaining({ code: "EAGAIN" }));

		// Keep references alive
		expect(manager.isPty(master.description.id)).toBe(true);
	});

	it("rejects master writes that exceed MAX_PTY_BUFFER_BYTES when slave does not read", () => {
		const manager = new PtyManager();
		const { master, slave } = manager.createPty();

		// Disable line discipline for raw pass-through
		manager.setDiscipline(master.description.id, {
			canonical: false,
			echo: false,
			isig: false,
		});

		// Fill input buffer (master write → slave read direction)
		const chunk = new Uint8Array(MAX_PTY_BUFFER_BYTES);
		manager.write(master.description.id, chunk);

		// Next write should fail
		expect(() =>
			manager.write(master.description.id, new Uint8Array(1)),
		).toThrowError(expect.objectContaining({ code: "EAGAIN" }));

		// Keep references alive
		expect(manager.isPty(slave.description.id)).toBe(true);
	});

	it("allows writes after draining", async () => {
		const manager = new PtyManager();
		const { master, slave } = manager.createPty();

		// Fill output buffer
		const chunk = new Uint8Array(MAX_PTY_BUFFER_BYTES);
		manager.write(slave.description.id, chunk);

		// Drain via master read
		await manager.read(master.description.id, MAX_PTY_BUFFER_BYTES);

		// Write should succeed again
		expect(() =>
			manager.write(slave.description.id, new Uint8Array(1024)),
		).not.toThrow();
	});
});
