import { describe, it, expect } from "vitest";
import { createDeviceLayer } from "../src/device-layer.js";
import { TestFileSystem } from "./helpers.js";

function createTestVfs() {
	return createDeviceLayer(new TestFileSystem());
}

describe("DeviceLayer", () => {
	it("/dev/null reads as empty", async () => {
		const vfs = createTestVfs();
		const data = await vfs.readFile("/dev/null");
		expect(data.length).toBe(0);
	});

	it("/dev/null write is discarded", async () => {
		const vfs = createTestVfs();
		await vfs.writeFile("/dev/null", "data");
		const readBack = await vfs.readFile("/dev/null");
		expect(readBack.length).toBe(0);
	});

	it("/dev/zero reads as zeros", async () => {
		const vfs = createTestVfs();
		const data = await vfs.readFile("/dev/zero");
		expect(data.length).toBe(4096);
		expect(data.every((b) => b === 0)).toBe(true);
	});

	it("/dev/urandom reads random bytes", async () => {
		const vfs = createTestVfs();
		const data = await vfs.readFile("/dev/urandom");
		expect(data.length).toBe(4096);
		// Very unlikely all zeros
		expect(data.some((b) => b !== 0)).toBe(true);
	});

	it("/dev/urandom returns different data on consecutive reads", async () => {
		const vfs = createTestVfs();
		const a = await vfs.readFile("/dev/urandom");
		const b = await vfs.readFile("/dev/urandom");
		expect(a.length).toBe(4096);
		expect(b.length).toBe(4096);
		// Buffers should differ (collision probability is negligible)
		let same = true;
		for (let i = 0; i < a.length; i++) {
			if (a[i] !== b[i]) { same = false; break; }
		}
		expect(same).toBe(false);
	});

	it("device paths exist", async () => {
		const vfs = createTestVfs();
		expect(await vfs.exists("/dev/null")).toBe(true);
		expect(await vfs.exists("/dev/zero")).toBe(true);
		expect(await vfs.exists("/dev/stdin")).toBe(true);
		expect(await vfs.exists("/dev/stdout")).toBe(true);
		expect(await vfs.exists("/dev/stderr")).toBe(true);
		expect(await vfs.exists("/dev/urandom")).toBe(true);
		expect(await vfs.exists("/dev")).toBe(true);
	});

	it("stat on device returns correct type", async () => {
		const vfs = createTestVfs();
		const stat = await vfs.stat("/dev/null");
		expect(stat.isDirectory).toBe(false);
		expect(stat.mode).toBe(0o666);
	});

	it("/dev is a directory", async () => {
		const vfs = createTestVfs();
		const stat = await vfs.stat("/dev");
		expect(stat.isDirectory).toBe(true);
	});

	it("readdir /dev lists devices", async () => {
		const vfs = createTestVfs();
		const entries = await vfs.readDir("/dev");
		expect(entries).toContain("null");
		expect(entries).toContain("zero");
		expect(entries).toContain("stdin");
	});

	it("cannot remove device nodes", async () => {
		const vfs = createTestVfs();
		await expect(vfs.removeFile("/dev/null")).rejects.toThrow("EPERM");
	});

	it("/dev/zero write is silently discarded", async () => {
		const vfs = createTestVfs();
		// Write to /dev/zero, then verify read still returns zeros
		await vfs.writeFile("/dev/zero", "garbage");
		const zeros = await vfs.readFile("/dev/zero");
		expect(zeros.length).toBe(4096);
		expect(zeros.every((b) => b === 0)).toBe(true);
	});

	it("/dev/stdin, /dev/stdout, /dev/stderr exist and stat as devices", async () => {
		const vfs = createTestVfs();
		for (const name of ["stdin", "stdout", "stderr"]) {
			const path = `/dev/${name}`;
			expect(await vfs.exists(path)).toBe(true);
			const stat = await vfs.stat(path);
			expect(stat.isDirectory).toBe(false);
			expect(stat.mode).toBe(0o666);
		}
	});

	it("/dev/stdin read falls through to backing VFS (ENOENT when absent)", async () => {
		const vfs = createTestVfs();
		await expect(vfs.readFile("/dev/stdin")).rejects.toThrow();
	});

	it("/dev/stdout read falls through to backing VFS (ENOENT when absent)", async () => {
		const vfs = createTestVfs();
		await expect(vfs.readFile("/dev/stdout")).rejects.toThrow();
	});

	it("/dev/stderr read falls through to backing VFS (ENOENT when absent)", async () => {
		const vfs = createTestVfs();
		await expect(vfs.readFile("/dev/stderr")).rejects.toThrow();
	});

	it("/dev/stdout write passes through to backing VFS", async () => {
		const vfs = createTestVfs();
		// Writes to stdio devices are not intercepted — they pass through
		await vfs.writeFile("/dev/stdout", "output");
		// Read also passes through; backing VFS should have the data
		// (readFile for /dev/stdout is not intercepted by device layer)
		const data = await vfs.readTextFile("/dev/stdout");
		expect(data).toBe("output");
	});

	it("/dev/stderr write passes through to backing VFS", async () => {
		const vfs = createTestVfs();
		await vfs.writeFile("/dev/stderr", "error output");
		const data = await vfs.readTextFile("/dev/stderr");
		expect(data).toBe("error output");
	});

	it("rename of device path throws EPERM", async () => {
		const vfs = createTestVfs();
		// Device as source
		await expect(vfs.rename("/dev/null", "/tmp/x")).rejects.toThrow("EPERM");
		// Device as target
		await vfs.writeFile("/tmp/a.txt", "data");
		await expect(vfs.rename("/tmp/a.txt", "/dev/null")).rejects.toThrow("EPERM");
	});

	it("link of device path throws EPERM", async () => {
		const vfs = createTestVfs();
		await expect(vfs.link("/dev/null", "/tmp/devlink")).rejects.toThrow("EPERM");
		await expect(vfs.link("/dev/urandom", "/tmp/rng")).rejects.toThrow("EPERM");
	});

	it("truncate /dev/null succeeds as no-op", async () => {
		const vfs = createTestVfs();
		// Should not throw
		await vfs.truncate("/dev/null", 0);
		// Still reads as empty
		const data = await vfs.readFile("/dev/null");
		expect(data.length).toBe(0);
	});

	it("/dev/urandom write is silently discarded", async () => {
		const vfs = createTestVfs();
		await vfs.writeFile("/dev/urandom", "garbage");
		// Read should still return random bytes, not garbage
		const data = await vfs.readFile("/dev/urandom");
		expect(data.length).toBe(4096);
	});

	it("realpath on device paths returns the device path", async () => {
		const vfs = createTestVfs();
		expect(await vfs.realpath("/dev/null")).toBe("/dev/null");
		expect(await vfs.realpath("/dev/zero")).toBe("/dev/zero");
		expect(await vfs.realpath("/dev/urandom")).toBe("/dev/urandom");
		expect(await vfs.realpath("/dev/stdin")).toBe("/dev/stdin");
		expect(await vfs.realpath("/dev")).toBe("/dev");
		expect(await vfs.realpath("/dev/fd")).toBe("/dev/fd");
	});

	it("non-device paths pass through to backing VFS", async () => {
		const vfs = createTestVfs();
		await vfs.writeFile("/tmp/test.txt", "hello");
		const data = await vfs.readTextFile("/tmp/test.txt");
		expect(data).toBe("hello");
	});
});
