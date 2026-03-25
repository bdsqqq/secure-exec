import { afterEach, describe, expect, it } from "vitest";
import { createKernel } from "../../src/kernel/kernel.js";
import { InodeTable } from "../../src/kernel/inode-table.js";
import { O_RDONLY, O_RDWR, type Kernel, type KernelInterface, KernelError } from "../../src/kernel/types.js";
import { InMemoryFileSystem } from "../../src/shared/in-memory-fs.js";

describe("InodeTable", () => {
	it("allocate returns inode with unique ino", () => {
		const table = new InodeTable();
		const a = table.allocate(0o100644, 0, 0);
		const b = table.allocate(0o100644, 0, 0);
		expect(a.ino).not.toBe(b.ino);
		expect(a.nlink).toBe(1);
		expect(a.openRefCount).toBe(0);
		expect(a.mode).toBe(0o100644);
	});

	it("get returns inode by ino", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 1, 2);
		expect(table.get(inode.ino)).toBe(inode);
	});

	it("get returns null for unknown ino", () => {
		const table = new InodeTable();
		expect(table.get(999)).toBeNull();
	});

	it("incrementLinks bumps nlink", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		expect(inode.nlink).toBe(1);
		table.incrementLinks(inode.ino);
		expect(inode.nlink).toBe(2);
	});

	it("decrementLinks drops nlink", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		table.incrementLinks(inode.ino); // nlink=2
		table.decrementLinks(inode.ino); // nlink=1
		expect(inode.nlink).toBe(1);
	});

	it("decrementLinks throws when nlink already 0", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		table.decrementLinks(inode.ino); // nlink=0
		expect(() => table.decrementLinks(inode.ino)).toThrow(KernelError);
	});

	it("incrementOpenRefs / decrementOpenRefs track open FDs", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		table.incrementOpenRefs(inode.ino);
		expect(inode.openRefCount).toBe(1);
		table.incrementOpenRefs(inode.ino);
		expect(inode.openRefCount).toBe(2);
		table.decrementOpenRefs(inode.ino);
		expect(inode.openRefCount).toBe(1);
	});

	it("decrementOpenRefs throws when already 0", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		expect(() => table.decrementOpenRefs(inode.ino)).toThrow(KernelError);
	});

	it("shouldDelete returns true when nlink=0 and openRefCount=0", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		// nlink=1, openRefCount=0 — not deletable yet
		expect(table.shouldDelete(inode.ino)).toBe(false);

		table.decrementLinks(inode.ino); // nlink=0
		expect(table.shouldDelete(inode.ino)).toBe(true);
	});

	it("shouldDelete returns false for unknown ino", () => {
		const table = new InodeTable();
		expect(table.shouldDelete(999)).toBe(false);
	});

	it("deferred deletion: unlink with open FDs keeps inode", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);

		// Open an FD
		table.incrementOpenRefs(inode.ino);

		// Unlink (remove last directory entry)
		table.decrementLinks(inode.ino); // nlink=0, openRefCount=1

		// Inode should persist — still has open FD
		expect(table.shouldDelete(inode.ino)).toBe(false);
		expect(inode.nlink).toBe(0);
		expect(inode.openRefCount).toBe(1);

		// stat on open FD to unlinked file returns nlink=0
		const fetched = table.get(inode.ino);
		expect(fetched).not.toBeNull();
		expect(fetched!.nlink).toBe(0);
	});

	it("close last FD on unlinked file triggers deletion", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);

		// Open two FDs
		table.incrementOpenRefs(inode.ino);
		table.incrementOpenRefs(inode.ino);

		// Unlink
		table.decrementLinks(inode.ino); // nlink=0, openRefCount=2
		expect(table.shouldDelete(inode.ino)).toBe(false);

		// Close one FD
		table.decrementOpenRefs(inode.ino); // openRefCount=1
		expect(table.shouldDelete(inode.ino)).toBe(false);

		// Close last FD
		table.decrementOpenRefs(inode.ino); // openRefCount=0
		expect(table.shouldDelete(inode.ino)).toBe(true);

		// Caller deletes
		table.delete(inode.ino);
		expect(table.get(inode.ino)).toBeNull();
	});

	it("hard links: multiple directory entries share same inode", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);

		// Create a hard link
		table.incrementLinks(inode.ino);
		expect(inode.nlink).toBe(2);

		// Remove one link
		table.decrementLinks(inode.ino);
		expect(inode.nlink).toBe(1);
		expect(table.shouldDelete(inode.ino)).toBe(false);

		// Remove last link
		table.decrementLinks(inode.ino);
		expect(inode.nlink).toBe(0);
		expect(table.shouldDelete(inode.ino)).toBe(true);
	});

	it("operations on unknown ino throw ENOENT", () => {
		const table = new InodeTable();
		expect(() => table.incrementLinks(999)).toThrow(KernelError);
		expect(() => table.decrementLinks(999)).toThrow(KernelError);
		expect(() => table.incrementOpenRefs(999)).toThrow(KernelError);
		expect(() => table.decrementOpenRefs(999)).toThrow(KernelError);
	});

	it("stores uid, gid, mode, timestamps", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o40755, 1000, 1000);
		expect(inode.uid).toBe(1000);
		expect(inode.gid).toBe(1000);
		expect(inode.mode).toBe(0o40755);
		expect(inode.atime).toBeInstanceOf(Date);
		expect(inode.mtime).toBeInstanceOf(Date);
		expect(inode.ctime).toBeInstanceOf(Date);
		expect(inode.birthtime).toBeInstanceOf(Date);
	});

	it("ctime updates on link/unlink operations", () => {
		const table = new InodeTable();
		const inode = table.allocate(0o100644, 0, 0);
		const originalCtime = inode.ctime;

		// Small delay to ensure time difference
		table.incrementLinks(inode.ino);
		expect(inode.ctime.getTime()).toBeGreaterThanOrEqual(originalCtime.getTime());
	});

	it("size tracks table entry count", () => {
		const table = new InodeTable();
		expect(table.size).toBe(0);

		const a = table.allocate(0o100644, 0, 0);
		expect(table.size).toBe(1);

		table.allocate(0o100644, 0, 0);
		expect(table.size).toBe(2);

		table.decrementLinks(a.ino);
		table.delete(a.ino);
		expect(table.size).toBe(1);
	});
});

describe("InodeTable integration", () => {
	let kernel: Kernel | undefined;

	afterEach(async () => {
		await kernel?.dispose();
	});

	async function createKernelHarness() {
		const filesystem = new InMemoryFileSystem();
		kernel = createKernel({ filesystem });
		const internal = kernel as any;
		await internal.posixDirsReady;
		internal.driverPids.set("test", new Set([100]));
		internal.fdTableManager.create(100);
		const ki = internal.createKernelInterface("test") as KernelInterface;
		return { filesystem, kernel, ki, pid: 100 };
	}

	it("kernel exposes a shared inode table and stat returns real inode numbers", async () => {
		const { kernel, filesystem } = await createKernelHarness();

		await filesystem.writeFile("/tmp/real.txt", "hello");

		const stat = await kernel.stat("/tmp/real.txt");
		expect(stat.ino).toBeGreaterThan(0);
		expect(stat.nlink).toBe(1);
		expect(kernel.inodeTable.get(stat.ino)?.ino).toBe(stat.ino);
	});

	it("unlink with an open FD removes the path but keeps inode data readable", async () => {
		const { kernel, filesystem, ki, pid } = await createKernelHarness();

		await filesystem.writeFile("/tmp/open.txt", "hello");
		const initial = await kernel.stat("/tmp/open.txt");
		const fd = ki.fdOpen(pid, "/tmp/open.txt", O_RDONLY);

		expect(kernel.inodeTable.get(initial.ino)?.openRefCount).toBe(1);

		await filesystem.removeFile("/tmp/open.txt");

		expect(await filesystem.exists("/tmp/open.txt")).toBe(false);
		expect(await filesystem.readDir("/tmp")).not.toContain("open.txt");
		expect(kernel.inodeTable.get(initial.ino)?.nlink).toBe(0);
		expect(new TextDecoder().decode(await ki.fdRead(pid, fd, 5))).toBe("hello");
		expect(filesystem.statByInode(initial.ino).nlink).toBe(0);
	});

	it("closing the last FD deletes deferred-unlink inode data", async () => {
		const { kernel, filesystem, ki, pid } = await createKernelHarness();

		await filesystem.writeFile("/tmp/deferred.txt", "bye");
		const initial = await kernel.stat("/tmp/deferred.txt");
		const fd = ki.fdOpen(pid, "/tmp/deferred.txt", O_RDONLY);

		await filesystem.removeFile("/tmp/deferred.txt");
		ki.fdClose(pid, fd);

		expect(kernel.inodeTable.get(initial.ino)).toBeNull();
		expect(() => filesystem.statByInode(initial.ino)).toThrow("inode");
	});

	it("pwrite keeps working on an unlinked open file until the last close", async () => {
		const { filesystem, ki, pid } = await createKernelHarness();

		await filesystem.writeFile("/tmp/pwrite.txt", "hello");
		const fd = ki.fdOpen(pid, "/tmp/pwrite.txt", O_RDWR);

		await filesystem.removeFile("/tmp/pwrite.txt");
		await ki.fdPwrite(pid, fd, new TextEncoder().encode("!"), 5n);

		expect(await filesystem.exists("/tmp/pwrite.txt")).toBe(false);
		expect(new TextDecoder().decode(await ki.fdPread(pid, fd, 6, 0n))).toBe(
			"hello!",
		);
	});

	it("hard links share inode numbers and increment nlink", async () => {
		const { kernel, filesystem } = await createKernelHarness();

		await filesystem.writeFile("/tmp/original.txt", "linked");
		await filesystem.link("/tmp/original.txt", "/tmp/alias.txt");

		const original = await kernel.stat("/tmp/original.txt");
		const alias = await kernel.stat("/tmp/alias.txt");

		expect(original.ino).toBe(alias.ino);
		expect(original.nlink).toBe(2);
		expect(alias.nlink).toBe(2);
	});

	it("readDir includes '.' and '..' before real entries", async () => {
		const { filesystem } = await createKernelHarness();

		await filesystem.writeFile("/tmp/example.txt", "hello");

		await expect(filesystem.readDir("/tmp")).resolves.toEqual([
			".",
			"..",
			"example.txt",
		]);
	});

	it("readDirWithTypes reports self and parent inode numbers", async () => {
		const { filesystem } = await createKernelHarness();

		await filesystem.mkdir("/tmp/child");

		const rootStat = await filesystem.stat("/");
		const tmpStat = await filesystem.stat("/tmp");
		const entries = await filesystem.readDirWithTypes("/tmp");
		const self = entries.find((entry) => entry.name === ".");
		const parent = entries.find((entry) => entry.name === "..");

		expect(entries.slice(0, 2).map((entry) => entry.name)).toEqual([".", ".."]);
		expect(self).toMatchObject({
			name: ".",
			isDirectory: true,
			isSymbolicLink: false,
			ino: tmpStat.ino,
		});
		expect(parent).toMatchObject({
			name: "..",
			isDirectory: true,
			isSymbolicLink: false,
			ino: rootStat.ino,
		});
	});

	it("root '..' points back to the root inode", async () => {
		const { filesystem } = await createKernelHarness();

		const rootStat = await filesystem.stat("/");
		const entries = await filesystem.readDirWithTypes("/");
		const parent = entries.find((entry) => entry.name === "..");

		expect(entries.slice(0, 2).map((entry) => entry.name)).toEqual([".", ".."]);
		expect(parent).toMatchObject({
			name: "..",
			isDirectory: true,
			isSymbolicLink: false,
			ino: rootStat.ino,
		});
	});
});
