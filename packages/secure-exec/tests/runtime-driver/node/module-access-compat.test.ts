import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { NodeRuntime, allowAllFs, createNodeDriver } from "../../../src/index.js";
import { createTestNodeRuntime } from "../../test-utils.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 55_000;
const COMMAND_TIMEOUT_MS = 45_000;

const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_SOURCE = path.join(TESTS_ROOT, "projects", "module-access-pass");

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

function formatErrorOutput(errorMessage: string | undefined): string {
	if (!errorMessage) {
		return "";
	}
	return errorMessage.endsWith("\n") ? errorMessage : `${errorMessage}\n`;
}

describe("moduleAccess compatibility fixture", () => {
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

	it(
		"matches host Node output for overlay-backed package loading",
		async () => {
			const projectDir = await mkdtemp(
				path.join(tmpdir(), "secure-exec-module-access-fixture-"),
			);
			tempDirs.push(projectDir);

			await cp(FIXTURE_SOURCE, projectDir, {
				recursive: true,
				filter: (source) => !source.includes(`${path.sep}node_modules${path.sep}`),
			});

			await execFileAsync(
				"pnpm",
				["install", "--ignore-workspace", "--prefer-offline"],
				{
					cwd: projectDir,
					timeout: COMMAND_TIMEOUT_MS,
					maxBuffer: 10 * 1024 * 1024,
				},
			);

			const hostEntry = path.join(projectDir, "src", "index.js");
			const hostResult = await execFileAsync(process.execPath, [hostEntry], {
				cwd: projectDir,
				timeout: COMMAND_TIMEOUT_MS,
				maxBuffer: 10 * 1024 * 1024,
			});

			const sandboxCode = await readFile(hostEntry, "utf8");
			const sandboxDriver = createNodeDriver({
				moduleAccess: {
					cwd: projectDir,
				},
				permissions: allowAllFs,
			});
			const capturedEvents: CapturedConsoleEvent[] = [];
			proc = createTestNodeRuntime({
				driver: sandboxDriver,
				onStdio: (event) => {
					capturedEvents.push(event);
				},
				processConfig: {
					cwd: "/root",
					env: {},
				},
			});

			const sandboxResult = await proc.exec(sandboxCode, {
				filePath: "/root/src/index.js",
				cwd: "/root",
				env: {},
			});

			expect(sandboxResult.code).toBe(0);
			expect(sandboxResult).not.toHaveProperty("stdout");
			expect(formatConsoleChannel(capturedEvents, "stdout")).toBe(
				hostResult.stdout,
			);
			expect(
				formatConsoleChannel(capturedEvents, "stderr") +
					formatErrorOutput(sandboxResult.errorMessage),
			).toBe(hostResult.stderr);
		},
		TEST_TIMEOUT_MS,
	);
});
