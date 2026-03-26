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
		packageJsonFields?: Record<string, unknown>;
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
		...options.packageJsonFields,
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

	it("allows sync fs access to host absolute paths within the projected module tree", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);
		const entryPath = path.join(
			projectDir,
			"node_modules",
			"asset-probe",
			"dist",
			"config.js",
		);
		const packageJsonPath = path.join(
			projectDir,
			"node_modules",
			"asset-probe",
			"package.json",
		);

		await writePackage(projectDir, "asset-probe", {
			files: {
				"dist/config.js": "module.exports = { ok: true };",
			},
		});

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const filesystem = driver.filesystem!;

		expect(await filesystem.exists(entryPath)).toBe(true);
		expect(await filesystem.realpath(entryPath)).toBe(entryPath);
		expect(await filesystem.exists(packageJsonPath)).toBe(true);
		expect(await filesystem.readTextFile(packageJsonPath)).toContain(
			'"name": "asset-probe"',
		);
	});

	it("allows host-absolute reads for pnpm virtual-store dependencies inside the projected closure", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		const virtualStoreRoot = path.join(projectDir, "node_modules", ".pnpm");
		const agentStoreRoot = path.join(
			virtualStoreRoot,
			"agent-pkg@1.0.0",
			"node_modules",
		);
		const transitiveStoreRoot = path.join(
			virtualStoreRoot,
			"chalkish@1.0.0",
			"node_modules",
		);
		const agentPackageDir = path.join(agentStoreRoot, "agent-pkg");
		const transitivePackageDir = path.join(transitiveStoreRoot, "chalkish");

		await mkdir(agentPackageDir, { recursive: true });
		await mkdir(transitivePackageDir, { recursive: true });
		await writeFile(
			path.join(agentPackageDir, "package.json"),
			JSON.stringify({ name: "agent-pkg", version: "1.0.0" }, null, 2),
		);
		await writeFile(
			path.join(transitivePackageDir, "package.json"),
			JSON.stringify({ name: "chalkish", version: "1.0.0" }, null, 2),
		);

		await symlink(
			path.relative(path.join(projectDir, "node_modules"), agentPackageDir),
			path.join(projectDir, "node_modules", "agent-pkg"),
		);
		await symlink(
			path.relative(agentStoreRoot, transitivePackageDir),
			path.join(agentStoreRoot, "chalkish"),
		);

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const filesystem = driver.filesystem!;
		const transitivePackageJsonPath = path.join(
			transitivePackageDir,
			"package.json",
		);

		expect(await filesystem.exists(transitivePackageJsonPath)).toBe(true);
		expect(await filesystem.readTextFile(transitivePackageJsonPath)).toContain(
			'"name": "chalkish"',
		);
	});

	it("resolves nested import exports from projected host file referrers", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "conditional-dep", {
			packageJsonFields: {
				type: "module",
				exports: {
					".": {
						import: {
							default: "./dist/esm/index.mjs",
						},
						require: {
							default: "./dist/cjs/index.cjs",
						},
					},
				},
			},
			files: {
				"dist/esm/index.mjs": 'export { value } from "./compiler/index.mjs";',
				"dist/esm/compiler/index.mjs": "export const value = 42;",
				"dist/cjs/index.cjs": "module.exports = { value: 41 };",
			},
		});
		const referrerPackageDir = await writePackage(projectDir, "host-referrer-probe", {
			packageJsonFields: {
				type: "module",
			},
			files: {
				"dist/index.js": 'export { value } from "conditional-dep";',
			},
		});
		const referrerPath = path.join(referrerPackageDir, "dist", "index.js");

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ driver, onStdio: capture.onStdio });

		const result = await proc.exec(
			`import { value } from ${JSON.stringify(referrerPath)}; console.log(value);`,
			{ cwd: "/root", filePath: "/entry.mjs" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("42\n");
	});

	it("imports named exports from projected CommonJS packages in ESM mode", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		await writePackage(projectDir, "cjs-named", {
			files: {
				"index.js": "exports.parse = () => 42; exports.kind = 'cjs';",
			},
		});
		const referrerPackageDir = await writePackage(projectDir, "esm-cjs-interop-probe", {
			packageJsonFields: {
				type: "module",
			},
			files: {
				"dist/index.js": 'import { parse } from "cjs-named"; console.log(parse());',
			},
		});
		const referrerPath = path.join(referrerPackageDir, "dist", "index.js");

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ driver, onStdio: capture.onStdio });

		const result = await proc.exec(
			`import ${JSON.stringify(referrerPath)};`,
			{ cwd: "/root", filePath: "/entry.mjs" },
		);
		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("42\n");
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

	it("module access out-of-scope error does not leak host paths", async () => {
		const projectDir = await createTempProject();
		tempDirs.push(projectDir);

		// Create a package with a nested symlink pointing outside allowed roots.
		// collectOverlayAllowedRoots only scans top-level symlinks, so a nested
		// symlink's target won't be in the allowed list.
		await writePackage(projectDir, "leak-probe", {
			files: {
				"index.js": "module.exports = {};",
			},
		});
		const nestedDir = path.join(
			projectDir,
			"node_modules",
			"leak-probe",
			"nested",
		);
		await mkdir(nestedDir, { recursive: true });
		// Symlink to a directory that is not in allowed roots
		await symlink("/usr", path.join(nestedDir, "escape"), "dir");

		const driver = createModuleAccessDriver({
			moduleAccess: {
				cwd: projectDir,
			},
		});
		proc = createTestNodeRuntime({ driver });

		const result = await proc.exec(
			`
      const fs = require("fs");
      try {
        fs.readFileSync("/root/node_modules/leak-probe/nested/escape/share", "utf8");
        console.log("unexpected");
      } catch (error) {
        console.log("ERROR:" + error.message);
      }
    `,
			{ cwd: "/root", filePath: "/root/index.js" },
		);
		// Error message must not contain the host canonical path or hostNodeModulesRoot
		const output = result.errorMessage ?? "";
		expect(output).not.toContain(projectDir);
		expect(output).not.toContain("/usr");
		expect(output).not.toContain("node_modules");
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
