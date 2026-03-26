import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, cp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export const COMMAND_TIMEOUT_MS = 45_000;
export const CACHE_READY_MARKER = ".ready";

export type PackageManager = "pnpm" | "npm" | "bun" | "yarn";

export type PackageManagerPassFixtureMetadata = {
	entry: string;
	expectation: "pass";
	packageManager?: PackageManager;
};

export type PackageManagerFailFixtureMetadata = {
	entry: string;
	expectation: "fail";
	fail: {
		code: number;
		stderrIncludes: string;
	};
	packageManager?: PackageManager;
};

export type PackageManagerFixtureMetadata =
	| PackageManagerPassFixtureMetadata
	| PackageManagerFailFixtureMetadata;

export type PreparedFixture = {
	cacheHit: boolean;
	cacheKey: string;
	projectDir: string;
};

export type ResultEnvelope = {
	code: number;
	stdout: string;
	stderr: string;
};

export type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

const yarnEnv = { ...process.env, COREPACK_ENABLE_STRICT: "0" };

export function parsePackageManagerFixtureMetadata(
	raw: unknown,
	fixtureName: string,
): PackageManagerFixtureMetadata {
	// Enforce a strict metadata schema with only pass/fail expectations.
	if (!isRecord(raw)) {
		throw new Error(`Fixture "${fixtureName}" metadata must be an object`);
	}
	if ("knownMismatch" in raw) {
		throw new Error(
			`Fixture "${fixtureName}" uses unsupported knownMismatch classification`,
		);
	}
	if ("sandboxEntry" in raw || "nodeEntry" in raw) {
		throw new Error(
			`Fixture "${fixtureName}" must use a single shared entry for both runtimes`,
		);
	}

	const allowedTopLevelKeys = new Set(["entry", "expectation", "fail", "packageManager"]);
	for (const key of Object.keys(raw)) {
		if (!allowedTopLevelKeys.has(key)) {
			throw new Error(
				`Fixture "${fixtureName}" has unsupported metadata key "${key}"`,
			);
		}
	}

	if (typeof raw.entry !== "string" || raw.entry.length === 0) {
		throw new Error(`Fixture "${fixtureName}" requires a non-empty entry`);
	}
	if (raw.expectation !== "pass" && raw.expectation !== "fail") {
		throw new Error(
			`Fixture "${fixtureName}" expectation must be "pass" or "fail"`,
		);
	}

	const validPackageManagers = new Set(["pnpm", "npm", "bun", "yarn"]);
	if (
		raw.packageManager !== undefined &&
		(typeof raw.packageManager !== "string" || !validPackageManagers.has(raw.packageManager))
	) {
		throw new Error(
			`Fixture "${fixtureName}" packageManager must be "pnpm", "npm", "bun", or "yarn"`,
		);
	}
	const packageManager = (raw.packageManager as PackageManager | undefined) ?? undefined;

	if (raw.expectation === "pass") {
		return {
			entry: raw.entry,
			expectation: "pass",
			...(packageManager && { packageManager }),
		};
	}

	if (!isRecord(raw.fail)) {
		throw new Error(
			`Fixture "${fixtureName}" with expectation "fail" requires a fail contract`,
		);
	}
	const failKeys = new Set(["code", "stderrIncludes"]);
	for (const key of Object.keys(raw.fail)) {
		if (!failKeys.has(key)) {
			throw new Error(
				`Fixture "${fixtureName}" fail contract has unsupported key "${key}"`,
			);
		}
	}

	if (typeof raw.fail.code !== "number") {
		throw new Error(
			`Fixture "${fixtureName}" fail contract requires numeric code`,
		);
	}
	if (
		typeof raw.fail.stderrIncludes !== "string" ||
		raw.fail.stderrIncludes.length === 0
	) {
		throw new Error(
			`Fixture "${fixtureName}" fail contract requires stderrIncludes`,
		);
	}

	return {
		entry: raw.entry,
		expectation: "fail",
		fail: {
			code: raw.fail.code,
			stderrIncludes: raw.fail.stderrIncludes,
		},
		...(packageManager && { packageManager }),
	};
}

export async function prepareFixtureProject(options: {
	cacheRoot: string;
	workspaceRoot: string;
	fixtureName: string;
	sourceDir: string;
	packageManager?: PackageManager;
}): Promise<PreparedFixture> {
	const {
		cacheRoot,
		workspaceRoot,
		fixtureName,
		sourceDir,
		packageManager = "pnpm",
	} = options;

	await mkdir(cacheRoot, { recursive: true });
	const cacheKey = await createFixtureCacheKey({
		workspaceRoot,
		sourceDir,
		packageManager,
	});
	const cacheDir = path.join(cacheRoot, `${fixtureName}-${cacheKey}`);
	const readyMarkerPath = path.join(cacheDir, CACHE_READY_MARKER);
	if (await pathExists(readyMarkerPath)) {
		return {
			cacheHit: true,
			cacheKey,
			projectDir: cacheDir,
		};
	}

	if (await pathExists(cacheDir)) {
		await rm(cacheDir, { recursive: true, force: true });
	}

	const stagingDir = `${cacheDir}.tmp-${process.pid}-${Date.now()}`;
	await rm(stagingDir, { recursive: true, force: true });
	await cp(sourceDir, stagingDir, {
		recursive: true,
		filter: (source) => !isNodeModulesPath(source),
	});

	const installCmd =
		packageManager === "npm"
			? { cmd: "npm", args: ["install", "--prefer-offline"] }
			: packageManager === "bun"
				? { cmd: "bun", args: ["install"] }
				: packageManager === "yarn"
					? await getYarnInstallCmd(stagingDir)
					: { cmd: "pnpm", args: ["install", "--ignore-workspace", "--prefer-offline"] };
	await execFileAsync(installCmd.cmd, installCmd.args, {
		cwd: stagingDir,
		timeout: COMMAND_TIMEOUT_MS,
		maxBuffer: 10 * 1024 * 1024,
		...(packageManager === "yarn" && { env: yarnEnv }),
	});
	await writeFile(
		path.join(stagingDir, CACHE_READY_MARKER),
		`${new Date().toISOString()}\n`,
	);

	try {
		await rename(stagingDir, cacheDir);
	} catch (error) {
		const code =
			error && typeof error === "object" && "code" in error
				? String(error.code)
				: "";
		if (code !== "EEXIST") {
			throw error;
		}
		await rm(stagingDir, { recursive: true, force: true });
		if (!(await pathExists(readyMarkerPath))) {
			throw new Error(`Cache entry race produced missing ready marker: ${cacheDir}`);
		}
	}

	return {
		cacheHit: false,
		cacheKey,
		projectDir: cacheDir,
	};
}

export async function runHostExecution(
	projectDir: string,
	entryRelativePath: string,
	extraEnv: Record<string, string> = {},
): Promise<ResultEnvelope> {
	const entryPath = path.join(projectDir, entryRelativePath);
	const result = await runCommand(process.execPath, [entryPath], projectDir, extraEnv);
	return normalizeEnvelope(result, projectDir);
}

export async function runCommand(
	command: string,
	args: string[],
	cwd: string,
	extraEnv: Record<string, string> = {},
): Promise<ResultEnvelope> {
	try {
		const result = await execFileAsync(command, args, {
			cwd,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
			env: { ...process.env, ...extraEnv },
		});
		return {
			code: 0,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} catch (error: unknown) {
		if (!isExecError(error)) {
			throw error;
		}
		return {
			code: typeof error.code === "number" ? error.code : 1,
			stdout: typeof error.stdout === "string" ? error.stdout : "",
			stderr: typeof error.stderr === "string" ? error.stderr : "",
		};
	}
}

export function formatConsoleChannel(
	events: CapturedConsoleEvent[],
	channel: CapturedConsoleEvent["channel"],
): string {
	const lines = events
		.filter((event) => event.channel === channel)
		.map((event) => event.message);
	return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

export function formatErrorOutput(errorMessage: string | undefined): string {
	if (!errorMessage) {
		return "";
	}
	return errorMessage.endsWith("\n") ? errorMessage : `${errorMessage}\n`;
}

export function normalizeEnvelope(
	envelope: ResultEnvelope,
	projectDir: string,
): ResultEnvelope {
	return {
		code: envelope.code,
		stdout: normalizeText(envelope.stdout, projectDir),
		stderr: normalizeText(envelope.stderr, projectDir),
	};
}

export function normalizeText(value: string, projectDir: string): string {
	const normalized = value.replace(/\r\n/g, "\n");
	const projectDirPosix = toPosixPath(projectDir);
	const withoutPaths = normalized
		.split(projectDir)
		.join("<project>")
		.split(projectDirPosix)
		.join("<project>");
	return normalizeModuleNotFoundText(withoutPaths);
}

export function normalizeModuleNotFoundText(value: string): string {
	if (!value.includes("Cannot find module")) {
		return value;
	}
	const quotedMatch = value.match(/Cannot find module '([^']+)'/);
	if (quotedMatch) {
		return `Cannot find module '${quotedMatch[1]}'\n`;
	}
	const fromMatch = value.match(/Cannot find module:\s*([^\s]+)\s+from\s+/);
	if (fromMatch) {
		return `Cannot find module '${fromMatch[1]}'\n`;
	}
	return value;
}

export async function assertPathExists(
	pathname: string,
	message: string,
): Promise<void> {
	try {
		await access(pathname);
	} catch {
		throw new Error(message);
	}
}

export async function pathExists(pathname: string): Promise<boolean> {
	try {
		await access(pathname);
		return true;
	} catch {
		return false;
	}
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function isNodeModulesPath(value: string): boolean {
	return value.split(path.sep).includes("node_modules");
}

export function isNotFoundError(value: unknown): boolean {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"code" in value &&
		String(value.code) === "ENOENT"
	);
}

export function isExecError(value: unknown): value is {
	code?: number;
	stdout?: string;
	stderr?: string;
} {
	return Boolean(value) && typeof value === "object" && "stdout" in value;
}

export function toPosixPath(value: string): string {
	return value.split(path.sep).join(path.posix.sep);
}

async function createFixtureCacheKey(options: {
	workspaceRoot: string;
	sourceDir: string;
	packageManager: PackageManager;
}): Promise<string> {
	const { workspaceRoot, sourceDir, packageManager } = options;
	const hash = createHash("sha256");
	const nodeMajor = process.versions.node.split(".")[0] ?? "0";
	const pmVersion =
		packageManager === "npm"
			? await getNpmVersion(workspaceRoot)
			: packageManager === "bun"
				? await getBunVersion(workspaceRoot)
				: packageManager === "yarn"
					? await getYarnVersion(workspaceRoot)
					: await getPnpmVersion(workspaceRoot);
	hash.update(`node-major:${nodeMajor}\n`);
	hash.update(`pm:${packageManager}\n`);
	hash.update(`pm-version:${pmVersion}\n`);
	hash.update(`platform:${process.platform}\n`);
	hash.update(`arch:${process.arch}\n`);

	await hashOptionalFile(
		hash,
		"workspace-lock",
		path.join(workspaceRoot, "pnpm-lock.yaml"),
	);
	await hashOptionalFile(
		hash,
		"workspace-package",
		path.join(workspaceRoot, "package.json"),
	);
	await hashOptionalFile(
		hash,
		"fixture-package",
		path.join(sourceDir, "package.json"),
	);
	const lockFile =
		packageManager === "npm"
			? "package-lock.json"
			: packageManager === "bun"
				? "bun.lock"
				: packageManager === "yarn"
					? "yarn.lock"
					: "pnpm-lock.yaml";
	await hashOptionalFile(
		hash,
		"fixture-lock",
		path.join(sourceDir, lockFile),
	);

	const files = await listFixtureFiles(sourceDir);
	for (const relativePath of files) {
		const absolutePath = path.join(sourceDir, relativePath);
		const content = await readFile(absolutePath);
		hash.update(`fixture-file:${toPosixPath(relativePath)}\n`);
		hash.update(content);
		hash.update("\n");
	}

	return hash.digest("hex").slice(0, 16);
}

async function hashOptionalFile(
	hash: ReturnType<typeof createHash>,
	label: string,
	filePath: string,
): Promise<void> {
	hash.update(`${label}:`);
	try {
		const content = await readFile(filePath);
		hash.update(content);
	} catch (error) {
		if (!isNotFoundError(error)) {
			throw error;
		}
		hash.update("<missing>");
	}
	hash.update("\n");
}

async function listFixtureFiles(rootDir: string): Promise<string[]> {
	const files: string[] = [];

	async function walk(relativeDir: string): Promise<void> {
		const directory = path.join(rootDir, relativeDir);
		const entries = await readdir(directory, { withFileTypes: true });
		const sortedEntries = entries
			.filter((entry) => !isNodeModulesPath(entry.name))
			.sort((left, right) => left.name.localeCompare(right.name));

		for (const entry of sortedEntries) {
			const relativePath = relativeDir
				? path.join(relativeDir, entry.name)
				: entry.name;
			if (entry.isDirectory()) {
				await walk(relativePath);
				continue;
			}
			if (entry.isFile()) {
				files.push(relativePath);
			}
		}
	}

	await walk("");
	return files.sort((left, right) => left.localeCompare(right));
}

let pnpmVersionPromise: Promise<string> | undefined;

function getPnpmVersion(workspaceRoot: string): Promise<string> {
	if (!pnpmVersionPromise) {
		pnpmVersionPromise = execFileAsync("pnpm", ["--version"], {
			cwd: workspaceRoot,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		}).then((result) => result.stdout.trim());
	}

	return pnpmVersionPromise;
}

let npmVersionPromise: Promise<string> | undefined;

function getNpmVersion(workspaceRoot: string): Promise<string> {
	if (!npmVersionPromise) {
		npmVersionPromise = execFileAsync("npm", ["--version"], {
			cwd: workspaceRoot,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		}).then((result) => result.stdout.trim());
	}

	return npmVersionPromise;
}

let bunVersionPromise: Promise<string> | undefined;

function getBunVersion(workspaceRoot: string): Promise<string> {
	if (!bunVersionPromise) {
		bunVersionPromise = execFileAsync("bun", ["--version"], {
			cwd: workspaceRoot,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
		}).then((result) => result.stdout.trim());
	}

	return bunVersionPromise;
}

let yarnVersionPromise: Promise<string> | undefined;

function getYarnVersion(workspaceRoot: string): Promise<string> {
	if (!yarnVersionPromise) {
		yarnVersionPromise = execFileAsync("yarn", ["--version"], {
			cwd: workspaceRoot,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 1024 * 1024,
			env: yarnEnv,
		}).then((result) => result.stdout.trim());
	}

	return yarnVersionPromise;
}

async function getYarnInstallCmd(
	projectDir: string,
): Promise<{ cmd: string; args: string[] }> {
	const isBerry = await pathExists(path.join(projectDir, ".yarnrc.yml"));
	return isBerry
		? { cmd: "yarn", args: ["install", "--immutable"] }
		: { cmd: "yarn", args: ["install"] };
}
