import { describe, expect, it } from "vitest";
import { MountTable } from "../../src/kernel/mount-table.js";
import type { ProcBackendOptions } from "../../src/kernel/proc-backend.js";
import { createProcBackend } from "../../src/kernel/proc-backend.js";
import { TestFileSystem } from "./helpers.js";

function createMountTable(): { mt: MountTable; rootFs: TestFileSystem } {
	const rootFs = new TestFileSystem();
	const mt = new MountTable(rootFs);
	return { mt, rootFs };
}

describe("MountTable", () => {
	it("write to /data/foo via mount, read back from correct backend", async () => {
		const { mt } = createMountTable();
		const dataFs = new TestFileSystem();
		mt.mount("/data", dataFs);

		await mt.writeFile("/data/foo", "hello from data");
		const content = await mt.readTextFile("/data/foo");
		expect(content).toBe("hello from data");

		// Verify the data went to the mounted backend, not root
		const backendContent = await dataFs.readTextFile("/foo");
		expect(backendContent).toBe("hello from data");
	});

	it("write to /home/user/foo routes to root FS (no mount match beyond root)", async () => {
		const { mt, rootFs } = createMountTable();
		const dataFs = new TestFileSystem();
		mt.mount("/data", dataFs);

		await mt.writeFile("/home/user/foo", "root content");
		const content = await mt.readTextFile("/home/user/foo");
		expect(content).toBe("root content");

		// Verify it went to root FS
		const rootContent = await rootFs.readTextFile("/home/user/foo");
		expect(rootContent).toBe("root content");

		// And not to the data mount
		expect(await dataFs.exists("/home/user/foo")).toBe(false);
	});

	it("nested mounts (/data and /data/cache) route to different backends", async () => {
		const { mt } = createMountTable();
		const dataFs = new TestFileSystem();
		const cacheFs = new TestFileSystem();
		mt.mount("/data", dataFs);
		mt.mount("/data/cache", cacheFs);

		await mt.writeFile("/data/file.txt", "data content");
		await mt.writeFile("/data/cache/file.txt", "cache content");

		// /data/file.txt goes to dataFs
		expect(await dataFs.readTextFile("/file.txt")).toBe("data content");
		// /data/cache/file.txt goes to cacheFs (longest prefix match)
		expect(await cacheFs.readTextFile("/file.txt")).toBe("cache content");
		// cacheFs should NOT have data's file
		expect(await cacheFs.exists("/file.txt")).toBe(true);
		expect(await dataFs.exists("/file.txt")).toBe(true);
	});

	it("rename across mounts throws EXDEV", async () => {
		const { mt } = createMountTable();
		mt.mount("/data", new TestFileSystem());

		await mt.writeFile("/data/a.txt", "content");
		await expect(mt.rename("/data/a.txt", "/home/b.txt")).rejects.toThrow(
			"EXDEV",
		);
	});

	it("rename within same mount succeeds", async () => {
		const { mt } = createMountTable();
		mt.mount("/data", new TestFileSystem());

		await mt.writeFile("/data/a.txt", "content");
		await mt.rename("/data/a.txt", "/data/b.txt");

		expect(await mt.exists("/data/a.txt")).toBe(false);
		expect(await mt.readTextFile("/data/b.txt")).toBe("content");
	});

	it("link across mounts throws EXDEV", async () => {
		const { mt } = createMountTable();
		mt.mount("/data", new TestFileSystem());

		await mt.writeFile("/data/a.txt", "content");
		await expect(mt.link("/data/a.txt", "/home/link.txt")).rejects.toThrow(
			"EXDEV",
		);
	});

	it("writeFile on readOnly mount throws EROFS", async () => {
		const { mt } = createMountTable();
		const roFs = new TestFileSystem();
		await roFs.writeFile("/existing.txt", "pre-existing");
		mt.mount("/ro", roFs, { readOnly: true });

		await expect(mt.writeFile("/ro/new.txt", "should fail")).rejects.toThrow(
			"EROFS",
		);
	});

	it("readFile on readOnly mount succeeds", async () => {
		const { mt } = createMountTable();
		const roFs = new TestFileSystem();
		await roFs.writeFile("/existing.txt", "pre-existing");
		mt.mount("/ro", roFs, { readOnly: true });

		const content = await mt.readTextFile("/ro/existing.txt");
		expect(content).toBe("pre-existing");
	});

	it("readdir('/') includes mount point basenames alongside root FS entries", async () => {
		const { mt, rootFs } = createMountTable();
		await rootFs.writeFile("/hello.txt", "hi");
		mt.mount("/data", new TestFileSystem());
		mt.mount("/proc", new TestFileSystem());

		const entries = await mt.readDir("/");
		expect(entries).toContain("hello.txt");
		expect(entries).toContain("data");
		expect(entries).toContain("proc");
	});

	it("mount then unmount, path falls through to root FS", async () => {
		const { mt, rootFs } = createMountTable();
		await rootFs.mkdir("/data");
		await rootFs.writeFile("/data/root-file.txt", "from root");
		mt.mount("/data", new TestFileSystem());

		// While mounted, root file is hidden
		expect(await mt.exists("/data/root-file.txt")).toBe(false);

		mt.unmount("/data");

		// After unmount, root file is visible again
		expect(await mt.exists("/data/root-file.txt")).toBe(true);
		expect(await mt.readTextFile("/data/root-file.txt")).toBe("from root");
	});

	it("mount auto-creates directory in parent FS", async () => {
		const { mt, rootFs } = createMountTable();
		mt.mount("/mnt/external", new TestFileSystem());

		// The mount point directory should be auto-created in root FS
		// Give async mkdir a tick to complete
		await new Promise((r) => setTimeout(r, 10));
		expect(await rootFs.exists("/mnt/external")).toBe(true);
	});

	it("stat on mount point returns backend root stat", async () => {
		const { mt } = createMountTable();
		const dataFs = new TestFileSystem();
		mt.mount("/data", dataFs);

		const s = await mt.stat("/data");
		expect(s.isDirectory).toBe(true);
	});

	it("/proc/mounts lists all mounted filesystems", async () => {
		const { mt } = createMountTable();
		const dataFs = new TestFileSystem();
		mt.mount("/data", dataFs);
		mt.mount("/cache", new TestFileSystem(), { readOnly: true });

		// Create a minimal ProcBackend with stub processTable/fdTableManager
		const procFs = createProcBackend({
			processTable: { get: () => null, listProcesses: () => new Map() },
			fdTableManager: { get: () => null },
			mountTable: mt,
		} as ProcBackendOptions);
		mt.mount("/proc", procFs);

		const content = await mt.readTextFile("/proc/mounts");
		const lines = content.trim().split("\n");

		// Should have entries for root, /data, /cache, and /proc
		expect(lines.some((l) => l.includes("/ ") && l.includes("rw"))).toBe(true);
		expect(lines.some((l) => l.includes("/data") && l.includes("rw"))).toBe(
			true,
		);
		expect(lines.some((l) => l.includes("/cache") && l.includes("ro"))).toBe(
			true,
		);
		expect(lines.some((l) => l.includes("/proc") && l.includes("rw"))).toBe(
			true,
		);
	});
});
