import { describe, it, expect, vi } from "vitest";
import { TimerTable } from "../../src/kernel/timer-table.js";
import { KernelError } from "../../src/kernel/types.js";

describe("TimerTable", () => {
	it("createTimer returns unique IDs", () => {
		const table = new TimerTable();
		const id1 = table.createTimer(1, 100, false, () => {});
		const id2 = table.createTimer(1, 200, false, () => {});
		expect(id1).not.toBe(id2);
	});

	it("get returns timer by ID", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		const timer = table.get(id);
		expect(timer).not.toBeNull();
		expect(timer!.id).toBe(id);
		expect(timer!.pid).toBe(1);
		expect(timer!.delayMs).toBe(100);
		expect(timer!.repeat).toBe(false);
	});

	it("get returns null for unknown ID", () => {
		const table = new TimerTable();
		expect(table.get(999)).toBeNull();
	});

	it("createTimer stores repeat flag", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 50, true, () => {});
		const timer = table.get(id);
		expect(timer!.repeat).toBe(true);
	});

	it("createTimer stores callback", () => {
		const table = new TimerTable();
		const cb = vi.fn();
		const id = table.createTimer(1, 100, false, cb);
		const timer = table.get(id);
		timer!.callback();
		expect(cb).toHaveBeenCalledOnce();
	});

	it("clearTimer removes timer", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		table.clearTimer(id);
		expect(table.get(id)).toBeNull();
		expect(table.size).toBe(0);
	});

	it("clearTimer marks timer as cleared", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		const timer = table.get(id)!;
		table.clearTimer(id);
		expect(timer.cleared).toBe(true);
	});

	it("clearTimer is no-op for unknown ID", () => {
		const table = new TimerTable();
		// Should not throw
		table.clearTimer(999);
	});

	it("cross-process isolation: process B cannot clear process A timer", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		expect(() => table.clearTimer(id, /* pid */ 2)).toThrow(KernelError);
		// Timer should still exist
		expect(table.get(id)).not.toBeNull();
	});

	it("cross-process isolation: owning process can clear own timer", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		table.clearTimer(id, 1); // Owner clears — should succeed
		expect(table.get(id)).toBeNull();
	});

	it("countForProcess counts only that process", () => {
		const table = new TimerTable();
		table.createTimer(1, 100, false, () => {});
		table.createTimer(1, 200, false, () => {});
		table.createTimer(2, 100, false, () => {});
		expect(table.countForProcess(1)).toBe(2);
		expect(table.countForProcess(2)).toBe(1);
		expect(table.countForProcess(3)).toBe(0);
	});

	it("getActiveTimers returns timers for a process", () => {
		const table = new TimerTable();
		const id1 = table.createTimer(1, 100, false, () => {});
		table.createTimer(2, 200, false, () => {});
		const id3 = table.createTimer(1, 300, true, () => {});

		const timers = table.getActiveTimers(1);
		expect(timers).toHaveLength(2);
		expect(timers.map((t) => t.id).sort()).toEqual([id1, id3].sort());
	});

	it("budget enforcement: throws EAGAIN when limit exceeded", () => {
		const table = new TimerTable({ defaultMaxTimers: 2 });
		table.createTimer(1, 100, false, () => {});
		table.createTimer(1, 200, false, () => {});
		expect(() => table.createTimer(1, 300, false, () => {})).toThrow(
			KernelError,
		);
		try {
			table.createTimer(1, 300, false, () => {});
		} catch (e) {
			expect((e as KernelError).code).toBe("EAGAIN");
		}
	});

	it("budget enforcement: per-process limit override", () => {
		const table = new TimerTable({ defaultMaxTimers: 10 });
		table.setLimit(1, 1);
		table.createTimer(1, 100, false, () => {});
		expect(() => table.createTimer(1, 200, false, () => {})).toThrow(
			KernelError,
		);
		// Process 2 still has the default limit of 10
		table.createTimer(2, 100, false, () => {});
		table.createTimer(2, 200, false, () => {});
	});

	it("budget enforcement: limit 0 means unlimited", () => {
		const table = new TimerTable({ defaultMaxTimers: 0 });
		// Should create many timers without error
		for (let i = 0; i < 100; i++) {
			table.createTimer(1, 100, false, () => {});
		}
		expect(table.countForProcess(1)).toBe(100);
	});

	it("budget enforcement: clearing a timer frees budget", () => {
		const table = new TimerTable({ defaultMaxTimers: 2 });
		const id1 = table.createTimer(1, 100, false, () => {});
		table.createTimer(1, 200, false, () => {});
		table.clearTimer(id1);
		// Now we have room again
		table.createTimer(1, 300, false, () => {});
		expect(table.countForProcess(1)).toBe(2);
	});

	it("clearAllForProcess removes all timers for a process", () => {
		const table = new TimerTable();
		table.createTimer(1, 100, false, () => {});
		table.createTimer(1, 200, false, () => {});
		table.createTimer(2, 100, false, () => {});

		table.clearAllForProcess(1);

		expect(table.countForProcess(1)).toBe(0);
		expect(table.countForProcess(2)).toBe(1);
		expect(table.size).toBe(1);
	});

	it("clearAllForProcess marks timers as cleared", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		const timer = table.get(id)!;
		table.clearAllForProcess(1);
		expect(timer.cleared).toBe(true);
	});

	it("clearAllForProcess cleans up per-process limit", () => {
		const table = new TimerTable();
		table.setLimit(1, 5);
		table.createTimer(1, 100, false, () => {});
		table.clearAllForProcess(1);
		// After clearing, new timers for pid 1 use default limit
		// (setLimit was cleaned up)
		expect(table.countForProcess(1)).toBe(0);
	});

	it("disposeAll clears everything", () => {
		const table = new TimerTable();
		table.createTimer(1, 100, false, () => {});
		table.createTimer(2, 200, false, () => {});
		table.setLimit(1, 5);

		table.disposeAll();

		expect(table.size).toBe(0);
		expect(table.countForProcess(1)).toBe(0);
		expect(table.countForProcess(2)).toBe(0);
	});

	it("disposeAll marks all timers as cleared", () => {
		const table = new TimerTable();
		const id1 = table.createTimer(1, 100, false, () => {});
		const id2 = table.createTimer(2, 200, false, () => {});
		const t1 = table.get(id1)!;
		const t2 = table.get(id2)!;

		table.disposeAll();

		expect(t1.cleared).toBe(true);
		expect(t2.cleared).toBe(true);
	});

	it("hostHandle can be set after creation", () => {
		const table = new TimerTable();
		const id = table.createTimer(1, 100, false, () => {});
		const timer = table.get(id)!;
		expect(timer.hostHandle).toBeUndefined();
		timer.hostHandle = 42;
		expect(timer.hostHandle).toBe(42);
	});

	it("size tracks total active timers", () => {
		const table = new TimerTable();
		expect(table.size).toBe(0);
		const id1 = table.createTimer(1, 100, false, () => {});
		expect(table.size).toBe(1);
		table.createTimer(2, 200, false, () => {});
		expect(table.size).toBe(2);
		table.clearTimer(id1);
		expect(table.size).toBe(1);
	});
});
