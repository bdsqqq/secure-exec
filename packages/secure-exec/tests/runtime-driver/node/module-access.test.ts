import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllFs,
	NodeRuntime,
	createInMemoryFileSystem,
	createNodeDriver,
} from "../../../src/index.js";
import { createTestNodeRuntime } from "../../test-utils.js";

type PackageFiles = Record<string, string | Uint8Array>;

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function formatConsoleChannel(
	events: CapturedConsoleEvent[],
	channel: CapturedConsoleEvent["channel"],
): string {
	const lines = events
		.filter((event) => event.channel === channel)
		.map((event) => event.message);
	return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		events,
		onStdio: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () => formatConsoleChannel(events, "stdout"),
		stderr: () => formatConsoleChannel(events, "stderr"),
	};
}

function createModuleAccessDriver(
	options: Parameters<typeof createNodeDriver>[0],
) {
	return createNodeDriver({
		permissions: allowAllFs,
		...options,
	});
}

async function createTempProject(): Promise<string> {
	const projectDir = await mkdtemp(
		path.join(tmpdir(), "secure-exec-module-access-"),
	);
	await mkdir(path.join(projectDir, "node_modules"), { recursive: true });
	return projectDir;
}

async function writePackage(
	projectDir: string,
	packageName: string,
	options: {
		main?: string;
		dependencies?: Record<string, string>;
		files: PackageFiles;
	},
): Promise<string> {
	const packageDir = path.join(
		projectDir,
		"node_modules",
		...packageName.split("/"),
	);
	await mkdir(packageDir, { recursive: true });
	const packageJson = {
		name: packageName,
		main: options.main ?? "index.js",
		dependencies: options.dependencies,
	};
	await writeFile(
		path.join(packageDir, "package.json"),
		JSON.stringify(packageJson, null, 2),
	);
	for (const [relativePath, contents] of Object.entries(options.files)) {
		const absolutePath = path.join(packageDir, relativePath);
		await mkdir(path.dirname(absolutePath), { recursive: true });
		await writeFile(absolutePath, contents);
	}
	return packageDir;
}

describe("moduleAccess overlay", () => {
	const tempDirs: string[] = [];
	let proc: NodeRuntime | undefined;

	afterEach(async () => {
		proc?.dispose();
		proc = undefined;
		while (tempDirs.length > 0) {
			const dir = tempDirs.pop();
			if (!dir) continue;
			await rm(dir, { recursive: true, force: true });
		}
	});

	it("loads third-party packages from overlay without base filesystem", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "transitive-dep", {
			files: {
				"index.js": "module.exports = { value: 41 };",
			},
		});
		await writePackage(projectDir, "allowed-root", {
			dependencies: {
				"transitive-dep": "1.0.0",
			},
			files: {
				"index.js": "module.exports = { value: require('transitive-dep').value + 1 };",
			},
		});

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ driver, onStdio: capture.onStdio });

		const result = await proc.exec(
			`const mod = require("allowed-root"); console.log(mod.value);`,
			{ cwd: "/root", filePath: "/root/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("42\n");
	});

	it("loads dependency-of-dependency chains (A -> B -> C)", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "pkg-c", {
			files: {
				"index.js": "module.exports = { value: 39 };",
			},
		});
		await writePackage(projectDir, "pkg-b", {
			dependencies: {
				"pkg-c": "1.0.0",
			},
			files: {
				"index.js": "module.exports = { value: require('pkg-c').value + 2 };",
			},
		});
		await writePackage(projectDir, "pkg-a", {
			dependencies: {
				"pkg-b": "1.0.0",
			},
			files: {
				"index.js": "module.exports = { value: require('pkg-b').value + 1 };",
			},
		});

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ driver, onStdio: capture.onStdio });

		const result = await proc.exec(
			`const mod = require("pkg-a"); console.log(mod.value);`,
			{ cwd: "/root", filePath: "/root/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("42\n");
	});

	it("loads overlay packages when base filesystem is mounted elsewhere", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "overlay-pkg", {
			files: {
				"index.js": "module.exports = { value: 41 };",
			},
		});

		const baseFs = createInMemoryFileSystem();
		await baseFs.writeFile("/workspace/host.txt", "host-file");

		const driver = createModuleAccessDriver({
			filesystem: baseFs,
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ driver, onStdio: capture.onStdio });

		const result = await proc.exec(
			`
      const fs = require("fs");
      const overlay = require("overlay-pkg");
      const hostText = fs.readFileSync("/workspace/host.txt", "utf8");
      console.log(String(overlay.value + 1) + ":" + hostText);
    `,
			{ cwd: "/root", filePath: "/root/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("42:host-file\n");
	});

	it("keeps projected node_modules read-only", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "read-only-pkg", {
			files: {
				"index.js": "module.exports = { ok: true };",
			},
		});

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ driver, onStdio: capture.onStdio });

		const result = await proc.exec(
			`
      const fs = require("fs");
      try {
        fs.writeFileSync("/root/node_modules/read-only-pkg/index.js", "module.exports = 0;");
        console.log("unexpected");
      } catch (error) {
        console.log(error && error.message);
      }
    `,
			{ cwd: "/root", filePath: "/root/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toContain("EACCES: permission denied");
	});

	it("rejects invalid moduleAccess configuration deterministically", async () => {
		expect(() =>
			createModuleAccessDriver({
				moduleAccess: {
					cwd: "relative/path",
				},
			}),
		).toThrow(/ERR_MODULE_ACCESS_INVALID_CONFIG/);
	});

	it("allows symlinked overlay packages discovered under cwd/node_modules", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);
		const outsideDir = await mkdtemp(path.join(tmpdir(), "secure-exec-module-outside-"));
		tempDirs.push(outsideDir);

		const outsidePackageRoot = path.join(outsideDir, "escape-pkg");
		await mkdir(outsidePackageRoot, { recursive: true });
		await writeFile(
			path.join(outsidePackageRoot, "package.json"),
			JSON.stringify({ name: "escape-pkg", main: "index.js" }),
		);
		await writeFile(
			path.join(outsidePackageRoot, "index.js"),
			"module.exports = 'escape';",
		);

		const escapeLink = path.join(projectDir, "node_modules", "escape-pkg");
		await symlink(outsidePackageRoot, escapeLink, "dir");

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		proc = createTestNodeRuntime({ driver });

		const result = await proc.exec(`require("escape-pkg")`, {
			cwd: "/root",
			filePath: "/root/index.js",
		});
		expect(result.code).toBe(0);
		expect(result.errorMessage).toBeUndefined();
	});

	it("rejects native addon artifacts in overlay", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "native-addon-pkg", {
			main: "binding.node",
			files: {
				"index.js": "module.exports = { ok: true };",
				"binding.node": new Uint8Array([0xde, 0xad, 0xbe, 0xef]),
			},
		});

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		proc = createTestNodeRuntime({ driver });

		const result = await proc.exec(`require("native-addon-pkg")`, {
			cwd: "/root",
			filePath: "/root/index.js",
		});
		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain("ERR_MODULE_ACCESS_NATIVE_ADDON");
	});

	it("keeps non-overlay host paths denied when overlay reads are allowed", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "overlay-only", {
			files: {
				"index.js": "module.exports = { value: 42 };",
			},
		});

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({
			driver,
			permissions: {
				fs: (request) => ({
					allow: !request.path.startsWith("/etc/"),
				}),
			},
			onStdio: capture.onStdio,
		});

		const result = await proc.exec(
			`
      const fs = require("fs");
      const mod = require("overlay-only");
      console.log(mod.value);
      try {
        fs.readFileSync("/etc/passwd", "utf8");
        console.log("unexpected");
      } catch (error) {
        console.log(error && error.message);
      }
    `,
			{ cwd: "/root", filePath: "/root/index.js" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toContain("42\n");
		expect(capture.stdout()).toContain(
			"ENOENT: no such file or directory, open '/etc/passwd'",
		);
	});
});
