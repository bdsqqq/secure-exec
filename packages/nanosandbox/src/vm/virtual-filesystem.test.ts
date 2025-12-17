import { afterEach, describe, expect, it } from "vitest";
import { VirtualMachine } from "./index.js";
import { DATA_MOUNT_PATH } from "../wasix/index.js";

describe("VirtualFileSystem", () => {
	let vm: VirtualMachine;

	afterEach(() => {
		vm?.dispose();
	});

	describe("operations with /data prefix", () => {
		it("should readTextFile with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.writeFile("/data/test.txt", "hello from data");
			const vfs = vm.getVirtualFileSystem();

			const content = await vfs.readTextFile(`${DATA_MOUNT_PATH}/test.txt`);
			expect(content).toBe("hello from data");
		});

		it("should readFile (binary) with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const binaryData = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
			await vm.writeFile("/data/image.png", binaryData);

			const vfs = vm.getVirtualFileSystem();
			const result = await vfs.readFile(`${DATA_MOUNT_PATH}/image.png`);

			expect(result).toEqual(binaryData);
		});

		it("should writeFile with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();
			await vfs.writeFile(`${DATA_MOUNT_PATH}/written.txt`, "data write");

			const content = await vm.readFile("/data/written.txt");
			expect(content).toBe("data write");
		});

		it("should writeFile binary with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();
			const binaryData = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
			await vfs.writeFile(`${DATA_MOUNT_PATH}/binary.bin`, binaryData);

			const result = await vm.readFileBinary("/data/binary.bin");
			expect(result).toEqual(binaryData);
		});

		it("should readDir with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.mkdir("/data/mydir");
			await vm.writeFile("/data/mydir/a.txt", "a");
			await vm.writeFile("/data/mydir/b.txt", "b");

			const vfs = vm.getVirtualFileSystem();
			const entries = await vfs.readDir(`${DATA_MOUNT_PATH}/mydir`);

			expect(entries).toContain("a.txt");
			expect(entries).toContain("b.txt");
		});

		it("should createDir with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();
			await vfs.createDir(`${DATA_MOUNT_PATH}/newdir`);
			await vfs.writeFile(`${DATA_MOUNT_PATH}/newdir/file.txt`, "test");

			const entries = await vm.readDir("/data/newdir");
			expect(entries).toContain("file.txt");
		});

		it("should mkdir recursively with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();
			await vfs.mkdir(`${DATA_MOUNT_PATH}/a/b/c`);
			await vfs.writeFile(`${DATA_MOUNT_PATH}/a/b/c/file.txt`, "deep");

			const content = await vm.readFile("/data/a/b/c/file.txt");
			expect(content).toBe("deep");
		});

		it("should removeFile with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.writeFile("/data/to-remove.txt", "delete me");
			expect(await vm.exists("/data/to-remove.txt")).toBe(true);

			const vfs = vm.getVirtualFileSystem();
			await vfs.removeFile(`${DATA_MOUNT_PATH}/to-remove.txt`);

			expect(await vm.exists("/data/to-remove.txt")).toBe(false);
		});

		it("should removeDir with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.mkdir("/data/empty-dir");
			expect(await vm.exists("/data/empty-dir")).toBe(true);

			const vfs = vm.getVirtualFileSystem();
			await vfs.removeDir(`${DATA_MOUNT_PATH}/empty-dir`);

			expect(await vm.exists("/data/empty-dir")).toBe(false);
		});

		it("should normalize /data alone to root", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.writeFile("/data/root-file.txt", "at root");

			const vfs = vm.getVirtualFileSystem();
			const entries = await vfs.readDir(DATA_MOUNT_PATH);

			expect(entries).toContain("root-file.txt");
		});

		it("should throw for nonexistent file with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(
				vfs.readTextFile(`${DATA_MOUNT_PATH}/nonexistent.txt`),
			).rejects.toThrow();
		});

		it("should throw for nonexistent directory with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(
				vfs.readDir(`${DATA_MOUNT_PATH}/nonexistent-dir`),
			).rejects.toThrow();
		});

		it("should check exists with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.writeFile("/data/exists.txt", "yes");

			const vfs = vm.getVirtualFileSystem();
			expect(await vfs.exists(`${DATA_MOUNT_PATH}/exists.txt`)).toBe(true);
			expect(await vfs.exists(`${DATA_MOUNT_PATH}/not-exists.txt`)).toBe(false);
		});
	});

	describe("write operations require /data prefix", () => {
		it("should reject writeFile without /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(
				vfs.writeFile("/no-data-prefix.txt", "content"),
			).rejects.toThrow("Cannot write to path outside /data");
		});

		it("should reject createDir without /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(vfs.createDir("/newdir")).rejects.toThrow(
				"Cannot write to path outside /data",
			);
		});

		it("should reject mkdir without /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(vfs.mkdir("/a/b/c")).rejects.toThrow(
				"Cannot write to path outside /data",
			);
		});

		it("should reject removeFile without /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(vfs.removeFile("/some-file.txt")).rejects.toThrow(
				"Cannot write to path outside /data",
			);
		});

		it("should reject removeDir without /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await expect(vfs.removeDir("/some-dir")).rejects.toThrow(
				"Cannot write to path outside /data",
			);
		});
	});

	describe("nested paths and edge cases", () => {
		it("should list root directory via /data", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.writeFile("/data/root-file.txt", "at root");
			await vm.mkdir("/data/subdir");

			const vfs = vm.getVirtualFileSystem();
			// Use /data prefix to read Directory root
			const entries = await vfs.readDir(DATA_MOUNT_PATH);

			expect(entries).toContain("root-file.txt");
			expect(entries).toContain("subdir");
		});

		it("should list WASM root directory via shell fallback", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();
			// "/" without /data prefix reads WASM root via shell
			const entries = await vfs.readDir("/");

			// WASM root should contain system directories
			expect(entries).toContain("bin");
			expect(entries).toContain("data");
		});

		it("should handle deeply nested paths with /data prefix", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.mkdir("/data/a");
			await vm.mkdir("/data/a/b");
			await vm.mkdir("/data/a/b/c");
			await vm.mkdir("/data/a/b/c/d");
			await vm.writeFile("/data/a/b/c/d/deep.txt", "deep content");

			const vfs = vm.getVirtualFileSystem();

			// Read via /data prefix
			const content = await vfs.readTextFile(
				`${DATA_MOUNT_PATH}/a/b/c/d/deep.txt`,
			);
			expect(content).toBe("deep content");

			// List each level via /data prefix
			expect(await vfs.readDir(`${DATA_MOUNT_PATH}/a`)).toContain("b");
			expect(await vfs.readDir(`${DATA_MOUNT_PATH}/a/b`)).toContain("c");
			expect(await vfs.readDir(`${DATA_MOUNT_PATH}/a/b/c`)).toContain("d");
			expect(await vfs.readDir(`${DATA_MOUNT_PATH}/a/b/c/d`)).toContain(
				"deep.txt",
			);
		});

		it("should handle files with same name at different levels", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.writeFile("/data/config.json", '{"level": "root"}');
			await vm.mkdir("/data/app");
			await vm.writeFile("/data/app/config.json", '{"level": "app"}');
			await vm.mkdir("/data/app/sub");
			await vm.writeFile("/data/app/sub/config.json", '{"level": "sub"}');

			const vfs = vm.getVirtualFileSystem();

			// Read via /data prefix
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/config.json`)).toBe(
				'{"level": "root"}',
			);
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/app/config.json`)).toBe(
				'{"level": "app"}',
			);
			expect(
				await vfs.readTextFile(`${DATA_MOUNT_PATH}/app/sub/config.json`),
			).toBe('{"level": "sub"}');
		});

		it("should handle empty directories", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			await vm.mkdir("/data/empty");

			const vfs = vm.getVirtualFileSystem();
			// Read via /data prefix
			const entries = await vfs.readDir(`${DATA_MOUNT_PATH}/empty`);

			expect(entries).toEqual([]);
		});

		it("should overwrite existing files", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await vfs.writeFile(`${DATA_MOUNT_PATH}/overwrite.txt`, "original");
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/overwrite.txt`)).toBe(
				"original",
			);

			await vfs.writeFile(`${DATA_MOUNT_PATH}/overwrite.txt`, "updated!");
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/overwrite.txt`)).toBe(
				"updated!",
			);
		});

		// Tests workaround for wasmer-js bug: Directory.writeFile missing truncate(true)
		it("should overwrite with shorter content", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await vfs.writeFile(
				`${DATA_MOUNT_PATH}/file.txt`,
				"this is long content",
			);
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/file.txt`)).toBe(
				"this is long content",
			);

			await vfs.writeFile(`${DATA_MOUNT_PATH}/file.txt`, "short");
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/file.txt`)).toBe(
				"short",
			);
		});

		it("should handle special characters in filenames", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			// Spaces and dashes
			await vfs.writeFile(`${DATA_MOUNT_PATH}/my-file name.txt`, "content");
			expect(
				await vfs.readTextFile(`${DATA_MOUNT_PATH}/my-file name.txt`),
			).toBe("content");

			// Dots
			await vfs.writeFile(`${DATA_MOUNT_PATH}/file.test.backup.txt`, "backup");
			expect(
				await vfs.readTextFile(`${DATA_MOUNT_PATH}/file.test.backup.txt`),
			).toBe("backup");
		});

		it("should handle unicode content", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			const unicodeContent = "Hello 世界 🌍 émojis";
			await vfs.writeFile(`${DATA_MOUNT_PATH}/unicode.txt`, unicodeContent);

			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/unicode.txt`)).toBe(
				unicodeContent,
			);
		});

		it("should handle empty file content", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			await vfs.writeFile(`${DATA_MOUNT_PATH}/empty.txt`, "");
			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/empty.txt`)).toBe("");
		});

		it("should handle large file content", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			// Create a ~100KB string
			const largeContent = "x".repeat(100 * 1024);
			await vfs.writeFile(`${DATA_MOUNT_PATH}/large.txt`, largeContent);

			expect(await vfs.readTextFile(`${DATA_MOUNT_PATH}/large.txt`)).toBe(
				largeContent,
			);
		});
	});

	describe("shell fallback for WASM-only paths", () => {
		it("should readDir /bin via shell fallback", async () => {
			// /bin exists in WASM (from webc - coreutils) but NOT in Directory
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			// Verify direct spawn works first
			const spawnResult = await vm.spawn("ls", { args: ["-1", "/bin"] });
			expect(spawnResult.code).toBe(0);
			expect(spawnResult.stdout.length).toBeGreaterThan(0);

			const vfs = vm.getVirtualFileSystem();

			// This should fall back to 'ls' via shell
			const entries = await vfs.readDir("/bin");

			expect(entries.length).toBeGreaterThan(0);
			expect(entries.some((e) => e.length > 0)).toBe(true);
		});

		it("should readTextFile via shell fallback (cat)", async () => {
			// Test reading a file that exists in WASM but not in Directory
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			// First verify the file exists via shell
			const catResult = await vm.spawn("cat", { args: ["/etc/passwd"] });
			// /etc/passwd may or may not exist depending on the webc
			// Let's try a file we know exists - check if there's anything in /bin
			const lsResult = await vm.spawn("ls", { args: ["/bin"] });
			expect(lsResult.code).toBe(0);

			// If /etc/passwd exists, test reading it
			if (catResult.code === 0) {
				const vfs = vm.getVirtualFileSystem();
				const content = await vfs.readTextFile("/etc/passwd");
				expect(content.length).toBeGreaterThan(0);
			}
		});

		it("should NOT use shell fallback for /data paths that don't exist", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			// /data paths should NOT fall back to shell - they should throw
			await expect(
				vfs.readTextFile(`${DATA_MOUNT_PATH}/nonexistent.txt`),
			).rejects.toThrow();
		});

		it("should read /data paths from Directory", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			// Write file to Directory
			await vm.writeFile("/data/myfile.txt", "from directory");

			const vfs = vm.getVirtualFileSystem();

			// File exists in Directory, read via /data path
			const content = await vfs.readTextFile(`${DATA_MOUNT_PATH}/myfile.txt`);
			expect(content).toBe("from directory");
		});

		it("should read non-/data paths via shell", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			// /bin exists in WASM, read via shell
			const entries = await vfs.readDir("/bin");
			expect(entries.length).toBeGreaterThan(0);
			// Should contain coreutils commands from webc
			expect(entries).toContain("ls");
		});

		it("should check exists for WASM system paths via shell", async () => {
			vm = new VirtualMachine({ loadNpm: false });
			await vm.init();

			const vfs = vm.getVirtualFileSystem();

			// /bin should exist in WASM
			expect(await vfs.exists("/bin")).toBe(true);
			// Nonexistent path
			expect(await vfs.exists("/nonexistent-wasm-path")).toBe(false);
		});
	});
});
