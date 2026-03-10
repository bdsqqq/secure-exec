import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import ivm from "isolated-vm";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllEnv,
	allowAllFs,
	NodeFileSystem,
	NodeRuntime,
} from "../../../src/index.js";
import { createTestNodeRuntime } from "../../test-utils.js";

const execFileAsync = promisify(execFile);
const TEST_TIMEOUT_MS = 55_000;
const COMMAND_TIMEOUT_MS = 45_000;
const TESTS_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const FIXTURE_ROOT = path.join(TESTS_ROOT, "fixtures", "hono-fetch-external");

const allowFsNetworkEnv = {
	...allowAllFs,
	...allowAllEnv,
};

describe("hono fetch external invocation", () => {
	let proc: NodeRuntime | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it(
		"calls router fetch directly from host-triggered executions multiple times",
		async () => {
			await ensureFixtureDependencies();
			proc = createTestNodeRuntime({
				filesystem: new NodeFileSystem(),
				permissions: allowFsNetworkEnv,
				processConfig: {
					cwd: FIXTURE_ROOT,
				},
			});

			const unsafeProc = proc as NodeRuntime & {
				__unsafeIsoalte: ivm.Isolate;
				__unsafeCreateContext(options: {
					env?: Record<string, string>;
					cwd?: string;
					filePath?: string;
				}): Promise<ivm.Context>;
			};
			let context: ivm.Context | undefined;
			let routerFetchRef:
				| ivm.Reference<
						(input: {
							url: string;
							method: string;
							headers: Record<string, string>;
						}) => Promise<{
							status: number;
							headers: Record<string, string>;
							bodyBase64: string;
						}>
				  >
				| undefined;
			try {
				context = await unsafeProc.__unsafeCreateContext({
					cwd: FIXTURE_ROOT,
					filePath: path.join(FIXTURE_ROOT, "src/__unsafe-bootstrap.js"),
				});
				const bootstrap = await unsafeProc.__unsafeIsoalte.compileScript(
					`
            const { routerFetchEnvelope } = require('./index.js');
            globalThis.__routerFetchEnvelope = routerFetchEnvelope;
          `,
					{
						filename: path.join(FIXTURE_ROOT, "src/__unsafe-bootstrap.js"),
					},
				);
				await bootstrap.run(context);

				routerFetchRef = (await context.global.get("__routerFetchEnvelope", {
					reference: true,
				})) as ivm.Reference<
					(input: {
						url: string;
						method: string;
						headers: Record<string, string>;
					}) => Promise<{
						status: number;
						headers: Record<string, string>;
						bodyBase64: string;
					}>
				>;

				const first = await invokeRouterFetchRef(routerFetchRef, {
					url: "http://sandbox.local/increment",
					method: "GET",
					headers: {},
				});
				const second = await invokeRouterFetchRef(routerFetchRef, {
					url: "http://sandbox.local/increment",
					method: "GET",
					headers: {},
				});
				const third = await invokeRouterFetchRef(routerFetchRef, {
					url: "http://sandbox.local/increment",
					method: "GET",
					headers: {},
				});
				const hello = await invokeRouterFetchRef(routerFetchRef, {
					url: "http://sandbox.local/hello",
					method: "GET",
					headers: {},
				});

				expect(first.status).toBe(200);
				expect(second.status).toBe(200);
				expect(third.status).toBe(200);
				expect(Buffer.from(first.bodyBase64, "base64").toString("utf8")).toBe(
					"1",
				);
				expect(Buffer.from(second.bodyBase64, "base64").toString("utf8")).toBe(
					"2",
				);
				expect(Buffer.from(third.bodyBase64, "base64").toString("utf8")).toBe(
					"3",
				);
				expect(hello.status).toBe(200);
				expect(Buffer.from(hello.bodyBase64, "base64").toString("utf8")).toBe(
					"hello from sandboxed hono",
				);
			} finally {
				routerFetchRef?.release();
				context?.release();
			}
		},
		TEST_TIMEOUT_MS,
	);
});

async function ensureFixtureDependencies(): Promise<void> {
	try {
		await access(path.join(FIXTURE_ROOT, "node_modules", "hono"));
		return;
	} catch {
		// Install only when fixture dependencies are missing.
	}

	await execFileAsync(
		"pnpm",
		["install", "--ignore-workspace", "--prefer-offline"],
		{
			cwd: FIXTURE_ROOT,
			timeout: COMMAND_TIMEOUT_MS,
			maxBuffer: 10 * 1024 * 1024,
		},
	);
}

async function invokeRouterFetchRef(
	routerFetchRef: ivm.Reference<
		(input: {
			url: string;
			method: string;
			headers: Record<string, string>;
		}) => Promise<{ status: number; headers: Record<string, string>; bodyBase64: string }>
	>,
	input: {
		url: string;
		method: string;
		headers: Record<string, string>;
	},
): Promise<{ status: number; headers: Record<string, string>; bodyBase64: string }> {
	return (await routerFetchRef.apply(undefined, [input], {
		arguments: {
			copy: true,
		},
		result: {
			copy: true,
			promise: true,
		},
	})) as {
		status: number;
		headers: Record<string, string>;
		bodyBase64: string;
	};
}
