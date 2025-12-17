import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { DATA_MOUNT_PATH } from "../wasix/index.js";
import { VirtualMachine } from "./index";

describe("VirtualMachine", () => {
	describe("Step 4: Basic filesystem", () => {
		it("should write and read files", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			await vm.writeFile("/data/foo.txt", "bar");
			expect(await vm.readFile("/data/foo.txt")).toBe("bar");
		});

		it("should write and read binary files", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			const data = new Uint8Array([0xde, 0xad, 0xbe, 0xef]);
			await vm.writeFile("/data/binary.bin", data);

			const result = await vm.readFileBinary("/data/binary.bin");
			expect(result).toEqual(data);
		});

		it("should check if files exist", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			await vm.writeFile("/data/exists.txt", "yes");

			expect(await vm.exists("/data/exists.txt")).toBe(true);
			expect(await vm.exists("/data/notexists.txt")).toBe(false);
		});

		it("should list directory contents", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			await vm.mkdir("/data/mydir");
			await vm.writeFile("/data/mydir/a.txt", "a");
			await vm.writeFile("/data/mydir/b.txt", "b");

			const entries = await vm.readDir("/data/mydir");
			expect(entries).toContain("a.txt");
			expect(entries).toContain("b.txt");
		});

		it("should remove files", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			await vm.writeFile("/data/remove.txt", "delete me");
			expect(await vm.exists("/data/remove.txt")).toBe(true);

			await vm.remove("/data/remove.txt");
			expect(await vm.exists("/data/remove.txt")).toBe(false);
		});

		it("should expose underlying Directory", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			expect(vm.getDirectory()).toBeDefined();
		});

		it("should expose VirtualFileSystem", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			expect(vm.getVirtualFileSystem()).toBeDefined();
		});

		it("should initialize only once", async () => {
			const vm = new VirtualMachine();
			await vm.init();
			await vm.init(); // Should not throw

			await vm.writeFile("/data/test.txt", "ok");
			expect(await vm.readFile("/data/test.txt")).toBe("ok");
		});

		it("should reject writes to non-/data paths", async () => {
			const vm = new VirtualMachine();
			await vm.init();

			await expect(vm.writeFile("/foo.txt", "bar")).rejects.toThrow(
				"Cannot write to path outside /data",
			);
		});
	});

	describe("Step 5: Host filesystem loading", () => {
		let tempDir: string;

		beforeAll(async () => {
			// Create a temp directory with some test files
			tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "vm-test-"));
			await fs.writeFile(path.join(tempDir, "hello.txt"), "Hello World");
			await fs.mkdir(path.join(tempDir, "subdir"));
			await fs.writeFile(
				path.join(tempDir, "subdir", "nested.txt"),
				"Nested content",
			);
			await fs.mkdir(path.join(tempDir, "node_modules"));
			await fs.writeFile(
				path.join(tempDir, "node_modules", "package.json"),
				'{"name": "test-pkg"}',
			);
		});

		afterAll(async () => {
			// Cleanup temp directory
			await fs.rm(tempDir, { recursive: true, force: true });
		});

		it("should load files from host directory", async () => {
			const vm = new VirtualMachine();
			await vm.init();
			// loadFromHost takes path in Directory (without /data), files accessible at /data/*
			await vm.loadFromHost(tempDir);

			expect(await vm.readFile("/data/hello.txt")).toBe("Hello World");
		});

		it("should load nested directories", async () => {
			const vm = new VirtualMachine();
			await vm.init();
			await vm.loadFromHost(tempDir);

			expect(await vm.readFile("/data/subdir/nested.txt")).toBe(
				"Nested content",
			);
		});

		it("should load node_modules directory", async () => {
			const vm = new VirtualMachine();
			await vm.init();
			await vm.loadFromHost(tempDir);

			const pkgJson = await vm.readFile("/data/node_modules/package.json");
			expect(pkgJson).toContain("test-pkg");
		});

		it("should list loaded directories", async () => {
			const vm = new VirtualMachine();
			await vm.init();
			await vm.loadFromHost(tempDir);

			const entries = await vm.readDir("/data");
			expect(entries).toContain("hello.txt");
			expect(entries).toContain("subdir");
			expect(entries).toContain("node_modules");
		});

		it("should load to custom virtual base path", async () => {
			const vm = new VirtualMachine();
			await vm.init();
			// loadFromHost to /project in Directory, accessible at /data/project
			await vm.loadFromHost(tempDir, "/project");

			expect(await vm.readFile("/data/project/hello.txt")).toBe("Hello World");
		});
	});

	describe("Step 9: Hybrid routing in spawn()", () => {
		it("should route node -e commands to NodeProcess", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("node", {
					args: ["-e", 'console.log("hello from node")'],
				});
				expect(result.stdout).toContain("hello from node");
				expect(result.code).toBe(0);
			} finally {
				vm.dispose();
			}
		});

		it("should route node script file to NodeProcess", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();
				await vm.writeFile("/data/script.js", 'console.log("script output")');

				const result = await vm.spawn("node", { args: ["/data/script.js"] });
				expect(result.stdout).toContain("script output");
				expect(result.code).toBe(0);
			} finally {
				vm.dispose();
			}
		});

		it("should route linux commands to WasixInstance", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();
				await vm.writeFile("/data/test.txt", "content");

				// Files are mounted at DATA_MOUNT_PATH
				const result = await vm.spawn("ls", { args: [DATA_MOUNT_PATH] });
				expect(result.stdout).toContain("test.txt");
			} finally {
				vm.dispose();
			}
		});

		it("should execute echo command via WasixInstance", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("echo", { args: ["hello world"] });
				expect(result.stdout.trim()).toBe("hello world");
				expect(result.code).toBe(0);
			} finally {
				vm.dispose();
			}
		});

		it("should run shell scripts that call node via IPC", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();
				await vm.writeFile("/data/script.js", 'console.log("from node")');

				// bash runs in WASM, node call bridges via IPC to NodeProcess
				// Script is at DATA_MOUNT_PATH
				const result = await vm.spawn("bash", {
					args: ["-c", `echo before && node ${DATA_MOUNT_PATH}/script.js && echo after`],
				});
				expect(result.stdout).toContain("before");
				expect(result.stdout).toContain("from node");
				expect(result.stdout).toContain("after");
			} finally {
				vm.dispose();
			}
		});

		it("should handle node errors properly", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("node", {
					args: ["-e", "throw new Error('oops')"],
				});
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("oops");
			} finally {
				vm.dispose();
			}
		});

		it("should handle missing script file", async () => {
			const vm = new VirtualMachine();
			try {
				const result = await vm.spawn("node", { args: ["/data/nonexistent.js"] });
				expect(result.code).toBe(1);
				expect(result.stderr).toContain("Cannot find module");
			} finally {
				vm.dispose();
			}
		});
	});

	describe("Integration tests with real packages", () => {
		it("should run ms package from host node_modules", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();
				// Load only the ms package (not the entire project - that's too slow)
				const msPath = path.join(process.cwd(), "node_modules/ms");
				await vm.loadFromHost(msPath, "/node_modules/ms");

				// Write a script that uses ms
				// Note: require() uses VFS which routes /data/* to Directory.
				// So we need to use /data prefix for the module path.
				await vm.writeFile(
					"/data/test-ms.js",
					`
          const ms = require('/data/node_modules/ms');
          console.log(ms('1h'));
          console.log(ms('2d'));
          console.log(ms(3600000));
        `,
				);

				const result = await vm.spawn("node", { args: ["/data/test-ms.js"] });
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("3600000"); // 1h in ms
				expect(result.stdout).toContain("172800000"); // 2d in ms
				expect(result.stdout).toContain("1h"); // reverse conversion
			} finally {
				vm.dispose();
			}
		});

		it("should handle fs operations from script", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();

				// Write a script that uses fs
				// Note: fs operations use VFS which routes /data/* to Directory.
				// So we need to use /data prefix for file paths.
				await vm.writeFile(
					"/data/test-fs.js",
					`
          const fs = require('fs');
          fs.writeFileSync('/data/output.json', JSON.stringify({ hello: 'world' }));
          const content = fs.readFileSync('/data/output.json', 'utf8');
          console.log(content);
        `,
				);

				const result = await vm.spawn("node", { args: ["/data/test-fs.js"] });
				expect(result.code).toBe(0);
				expect(result.stdout).toContain('{"hello":"world"}');

				// Verify the file was actually written
				const content = await vm.readFile("/data/output.json");
				expect(JSON.parse(content)).toEqual({ hello: "world" });
			} finally {
				vm.dispose();
			}
		});

		it("should handle path operations from script", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();

				await vm.writeFile(
					"/data/test-path.js",
					`
          const path = require('path');
          console.log(path.join('/foo', 'bar', 'baz.txt'));
          console.log(path.dirname('/foo/bar/baz.txt'));
          console.log(path.basename('/foo/bar/baz.txt'));
          console.log(path.extname('/foo/bar/baz.txt'));
        `,
				);

				const result = await vm.spawn("node", { args: ["/data/test-path.js"] });
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("/foo/bar/baz.txt");
				expect(result.stdout).toContain("/foo/bar");
				expect(result.stdout).toContain("baz.txt");
				expect(result.stdout).toContain(".txt");
			} finally {
				vm.dispose();
			}
		});
	});

	describe("npm accessibility", () => {
		it("should have npm accessible via bash ls", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();

				// Check npm path is accessible via bash
				const npmPath = vm.getNpmPath();
				expect(npmPath).toBe(`${DATA_MOUNT_PATH}/opt/npm`);

				// Verify we can ls the npm directory
				if (!npmPath) throw new Error("npm path should not be null");
				const result = await vm.spawn("ls", { args: [npmPath] });
				expect(result.code).toBe(0);
				// npm should have bin, lib directories
				expect(result.stdout).toContain("bin");
				expect(result.stdout).toContain("lib");
			} finally {
				vm.dispose();
			}
		});

		it("should be able to cat npm-cli.js via bash", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();

				const npmPath = vm.getNpmPath();
				if (!npmPath) throw new Error("npm path should not be null");
				// Verify we can read the npm-cli.js file
				const result = await vm.spawn("cat", { args: [`${npmPath}/bin/npm-cli.js`] });
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("lib/cli.js");
			} finally {
				vm.dispose();
			}
		});

		it("should have npm wrapper script at /data/bin/npm", async () => {
			const vm = new VirtualMachine();
			try {
				await vm.init();

				// Check that the wrapper exists
				const result = await vm.spawn("cat", { args: [`${DATA_MOUNT_PATH}/bin/npm`] });
				expect(result.code).toBe(0);
				expect(result.stdout).toContain("npm-cli.js");
			} finally {
				vm.dispose();
			}
		});

		// Note: Running npm via the wrapper doesn't work yet because npm uses
		// relative requires (../lib/cli.js) that depend on __dirname being set
		// correctly, which the sandboxed-node fs bridge doesn't fully support.
		// The npm files ARE accessible in the filesystem though.
	});
});
