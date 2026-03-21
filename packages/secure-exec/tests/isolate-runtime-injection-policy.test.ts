import { afterEach, describe, expect, it } from "vitest";
import {
	NodeRuntime,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../src/index.js";
import {
	getIsolateRuntimeSource,
	type IsolateRuntimeSourceId,
} from "../../core/src/generated/isolate-runtime.js";

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		onStdio: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () =>
			events
				.filter((e) => e.channel === "stdout")
				.map((e) => e.message)
				.join("\n"),
	};
}

describe("isolate runtime injection policy", () => {
	const runtimes = new Set<NodeRuntime>();

	function createRuntime(onStdio?: CapturedConsoleEvent["channel"] extends string ? (event: CapturedConsoleEvent) => void : never) {
		const runtime = new NodeRuntime({
			systemDriver: createNodeDriver({}),
			runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			onStdio,
		});
		runtimes.add(runtime);
		return runtime;
	}

	afterEach(async () => {
		const list = Array.from(runtimes);
		runtimes.clear();
		for (const runtime of list) {
			try {
				await runtime.terminate();
			} catch {
				runtime.dispose();
			}
		}
	});

	it("all isolate runtime sources are valid self-contained IIFEs", () => {
		const ids: IsolateRuntimeSourceId[] = [
			"applyCustomGlobalPolicy",
			"applyTimingMitigationFreeze",
			"applyTimingMitigationOff",
			"bridgeAttach",
			"bridgeInitialGlobals",
			"evalScriptResult",
			"globalExposureHelpers",
			"initCommonjsModuleGlobals",
			"overrideProcessCwd",
			"overrideProcessEnv",
			"requireSetup",
			"setCommonjsFileGlobals",
			"setStdinData",
			"setupDynamicImport",
			"setupFsFacade",
		];

		for (const id of ids) {
			const source = getIsolateRuntimeSource(id);
			expect(source, `${id} should be a non-empty string`).toBeTruthy();
			// Each source must be a self-contained IIFE — no template-literal
			// interpolation holes or unresolved placeholders
			expect(source).not.toContain("${");
			// Parseable as JavaScript
			expect(() => new Function(source), `${id} should parse as valid JS`).not.toThrow();
		}
	});

	it("filePath injection payload does not execute as code", async () => {
		// If the loader used template-literal eval (`context.eval(\`...\``)),
		// a crafted filePath could break out of the string boundary and inject
		// arbitrary code.  With static getIsolateRuntimeSource() this is impossible.
		const capture = createConsoleCapture();
		const runtime = createRuntime(capture.onStdio);

		const maliciousPath = `"; globalThis.__INJECTED__ = true; "`;
		const result = await runtime.exec(
			`console.log("injected:" + (typeof globalThis.__INJECTED__));`,
			{ filePath: maliciousPath },
		);

		expect(result.code).toBe(0);
		expect(capture.stdout()).toContain("injected:undefined");
	});

	it("bridge setup provides require, module, and CJS file globals", async () => {
		const capture = createConsoleCapture();
		const runtime = createRuntime(capture.onStdio);

		const result = await runtime.exec(
			`
			const checks = [
				"require:" + (typeof require === "function"),
				"module:" + (typeof module === "object"),
				"exports:" + (typeof exports === "object"),
				"__filename:" + (typeof __filename === "string"),
				"__dirname:" + (typeof __dirname === "string"),
			];
			console.log(checks.join(","));
			`,
			{ filePath: "/app/entry.js" },
		);

		expect(result.code).toBe(0);
		const out = capture.stdout();
		expect(out).toContain("require:true");
		expect(out).toContain("module:true");
		expect(out).toContain("exports:true");
		expect(out).toContain("__filename:true");
		expect(out).toContain("__dirname:true");
	});

	it("hardened bridge globals cannot be reassigned by user code", async () => {
		const capture = createConsoleCapture();
		const runtime = createRuntime(capture.onStdio);

		const result = await runtime.exec(`
			let overwritten = false;
			try {
				Object.defineProperty(globalThis, "require", { value: null, configurable: true });
				overwritten = (typeof require !== "function");
			} catch {
				overwritten = false;
			}
			console.log("require-overwritten:" + overwritten);
		`);

		expect(result.code).toBe(0);
		expect(capture.stdout()).toContain("require-overwritten:false");
	});
});
