import { describe, it, expect } from "vitest";
import { WaitHandle, WaitQueue } from "../../src/kernel/wait.js";

describe("WaitHandle", () => {
	it("wake resolves wait", async () => {
		const handle = new WaitHandle();
		// Wake immediately
		handle.wake();
		await handle.wait();
		expect(handle.isSettled).toBe(true);
		expect(handle.timedOut).toBe(false);
	});

	it("wait resolves when woken after await starts", async () => {
		const handle = new WaitHandle();
		let resolved = false;
		const p = handle.wait().then(() => { resolved = true; });
		expect(resolved).toBe(false);

		handle.wake();
		await p;
		expect(resolved).toBe(true);
		expect(handle.timedOut).toBe(false);
	});

	it("timeout fires when not woken", async () => {
		const handle = new WaitHandle(10);
		await handle.wait();
		expect(handle.isSettled).toBe(true);
		expect(handle.timedOut).toBe(true);
	});

	it("wake before timeout cancels timeout", async () => {
		const handle = new WaitHandle(1000);
		handle.wake();
		await handle.wait();
		expect(handle.timedOut).toBe(false);
	});

	it("double wake is a no-op", async () => {
		const handle = new WaitHandle();
		handle.wake();
		handle.wake(); // Should not throw
		await handle.wait();
		expect(handle.isSettled).toBe(true);
	});
});

describe("WaitQueue", () => {
	it("wakeOne wakes exactly one waiter (FIFO)", async () => {
		const queue = new WaitQueue();
		const h1 = queue.enqueue();
		const h2 = queue.enqueue();

		expect(queue.pending).toBe(2);

		queue.wakeOne();
		await h1.wait();

		expect(h1.isSettled).toBe(true);
		expect(h2.isSettled).toBe(false);
		expect(queue.pending).toBe(1);
	});

	it("wakeAll wakes all waiters", async () => {
		const queue = new WaitQueue();
		const h1 = queue.enqueue();
		const h2 = queue.enqueue();
		const h3 = queue.enqueue();

		const count = queue.wakeAll();
		expect(count).toBe(3);

		await Promise.all([h1.wait(), h2.wait(), h3.wait()]);
		expect(h1.isSettled).toBe(true);
		expect(h2.isSettled).toBe(true);
		expect(h3.isSettled).toBe(true);
		expect(queue.pending).toBe(0);
	});

	it("wakeOne returns false when no waiters", () => {
		const queue = new WaitQueue();
		expect(queue.wakeOne()).toBe(false);
	});

	it("wakeOne skips timed-out handles", async () => {
		const queue = new WaitQueue();
		const h1 = queue.enqueue(1); // Will time out quickly
		const h2 = queue.enqueue();

		// Wait for h1 to time out
		await h1.wait();
		expect(h1.timedOut).toBe(true);

		// wakeOne should skip h1 and wake h2
		const woke = queue.wakeOne();
		expect(woke).toBe(true);

		await h2.wait();
		expect(h2.isSettled).toBe(true);
		expect(h2.timedOut).toBe(false);
	});

	it("wakeAll returns 0 when empty", () => {
		const queue = new WaitQueue();
		expect(queue.wakeAll()).toBe(0);
	});

	it("enqueue with timeout creates timed handle", async () => {
		const queue = new WaitQueue();
		const handle = queue.enqueue(10);
		await handle.wait();
		expect(handle.timedOut).toBe(true);
	});

	it("pending count is accurate", () => {
		const queue = new WaitQueue();
		expect(queue.pending).toBe(0);

		queue.enqueue();
		queue.enqueue();
		expect(queue.pending).toBe(2);

		queue.wakeOne();
		expect(queue.pending).toBe(1);

		queue.wakeAll();
		expect(queue.pending).toBe(0);
	});

	it("clear removes all waiters without waking", () => {
		const queue = new WaitQueue();
		const h1 = queue.enqueue();
		const h2 = queue.enqueue();

		queue.clear();
		expect(queue.pending).toBe(0);
		// Handles are not settled — they were just removed from the queue
		expect(h1.isSettled).toBe(false);
		expect(h2.isSettled).toBe(false);
	});
});
