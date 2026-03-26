import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import {
	NodeRuntime,
	allowAll,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../../src/index.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECURE_EXEC_ROOT = path.resolve(__dirname, "../..");
const PI_CONFIG_ENTRY = path.resolve(
	SECURE_EXEC_ROOT,
	"node_modules/@mariozechner/pi-coding-agent/dist/config.js",
);
const PI_SDK_ENTRY = path.resolve(
	SECURE_EXEC_ROOT,
	"node_modules/@mariozechner/pi-coding-agent/dist/index.js",
);

function skipUnlessPiInstalled(): string | false {
	return existsSync(PI_CONFIG_ENTRY)
		? false
		: "@mariozechner/pi-coding-agent not installed";
}

function parseLastJsonLine(stdout: string): Record<string, unknown> {
	const line = stdout
		.trim()
		.split("\n")
		.map((entry) => entry.trim())
		.filter(Boolean)
		.at(-1);

	if (!line) {
		throw new Error(`sandbox produced no JSON output: ${JSON.stringify(stdout)}`);
	}

	return JSON.parse(line) as Record<string, unknown>;
}

describe.skipIf(skipUnlessPiInstalled())("Pi SDK bootstrap in NodeRuntime", () => {
	let runtime: NodeRuntime | undefined;

	afterEach(async () => {
		await runtime?.terminate();
		runtime = undefined;
	});

	it("resolves Pi package assets from the package root after config bootstrap", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];

		runtime = new NodeRuntime({
			onStdio: (event) => {
				if (event.channel === "stdout") stdout.push(event.message);
				if (event.channel === "stderr") stderr.push(event.message);
			},
			systemDriver: createNodeDriver({
				moduleAccess: { cwd: SECURE_EXEC_ROOT },
				permissions: allowAll,
			}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
		});

		const result = await runtime.exec(
			`
      const fs = require("node:fs");
      (async () => {
        try {
          const config = await import(${JSON.stringify(PI_CONFIG_ENTRY)});
          const packageJsonPath = config.getPackageJsonPath();
          const readmePath = config.getReadmePath();
          const themesDir = config.getThemesDir();
          console.log(JSON.stringify({
            ok: true,
            appName: config.APP_NAME,
            version: config.VERSION,
            packageJsonPath,
            packageJsonExists: fs.existsSync(packageJsonPath),
            readmePath,
            readmeExists: fs.existsSync(readmePath),
            themesDir,
            themesDirExists: fs.existsSync(themesDir),
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(JSON.stringify({
            ok: false,
            error: errorMessage.split("\\n")[0].slice(0, 600),
            code: error && typeof error === "object" && "code" in error ? error.code : undefined,
          }));
          process.exitCode = 1;
        }
      })();
    `,
			{ cwd: SECURE_EXEC_ROOT },
		);

		expect(result.code, stderr.join("")).toBe(0);

		const payload = parseLastJsonLine(stdout.join(""));
		expect(payload.ok).toBe(true);
		expect(payload.appName).toBe("pi");
		expect(payload.version).toBe("0.60.0");
		expect(payload.packageJsonExists).toBe(true);
		expect(String(payload.packageJsonPath)).toMatch(
			/node_modules\/@mariozechner\/pi-coding-agent\/package\.json$/,
		);
		expect(String(payload.packageJsonPath)).not.toMatch(/\/dist\/package\.json$/);
		expect(payload.readmeExists).toBe(true);
		expect(String(payload.readmePath)).toMatch(
			/node_modules\/@mariozechner\/pi-coding-agent\/README\.md$/,
		);
		expect(payload.themesDirExists).toBe(true);
		expect(String(payload.themesDir)).toMatch(
			/node_modules\/@mariozechner\/pi-coding-agent\/dist\/modes\/interactive\/theme$/,
		);
	});

	it("imports the Pi SDK after loader and unicode-regex compatibility fixes", async () => {
		const stdout: string[] = [];
		const stderr: string[] = [];

		runtime = new NodeRuntime({
			onStdio: (event) => {
				if (event.channel === "stdout") stdout.push(event.message);
				if (event.channel === "stderr") stderr.push(event.message);
			},
			systemDriver: createNodeDriver({
				moduleAccess: { cwd: SECURE_EXEC_ROOT },
				permissions: allowAll,
			}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
		});

		const result = await runtime.exec(
			`
      (async () => {
        try {
          const pi = await import(${JSON.stringify(PI_SDK_ENTRY)});
          console.log(JSON.stringify({
            ok: true,
            createAgentSessionType: typeof pi.createAgentSession,
            runPrintModeType: typeof pi.runPrintMode,
          }));
        } catch (error) {
          const errorMessage = error instanceof Error ? error.message : String(error);
          console.log(JSON.stringify({
            ok: false,
            error: errorMessage.split("\\n")[0].slice(0, 600),
            code: error && typeof error === "object" && "code" in error ? error.code : undefined,
          }));
          process.exitCode = 1;
        }
      })();
    `,
			{ cwd: SECURE_EXEC_ROOT },
		);

		expect(result.code, stderr.join("")).toBe(0);

		const payload = parseLastJsonLine(stdout.join(""));
		expect(payload.ok).toBe(true);
		expect(payload.createAgentSessionType).toBe("function");
		expect(payload.runPrintModeType).toBe("function");
	});
});
