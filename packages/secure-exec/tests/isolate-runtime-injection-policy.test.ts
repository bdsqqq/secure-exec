import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readSource(relativePath: string): string {
	return readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

describe("isolate runtime injection policy", () => {
	it("avoids template-literal isolate eval snippets in Node runtime loader", () => {
		// The Node runtime loader spans execution-driver.ts (facade) and its
		// extracted modules; check the full set of node/ source files.
		const nodeModulePaths = [
			"src/node/execution-driver.ts",
			"src/node/isolate-bootstrap.ts",
			"src/node/module-resolver.ts",
			"src/node/esm-compiler.ts",
			"src/node/bridge-setup.ts",
			"src/node/execution-lifecycle.ts",
		];
		const loaderSource = nodeModulePaths.map(readSource).join("\n");
		expect(loaderSource).not.toMatch(/context\.eval\(\s*`/);
		expect(loaderSource).not.toContain(
			"${ISOLATE_GLOBAL_EXPOSURE_HELPER_SOURCE}",
		);
		expect(loaderSource).toContain(
			'getIsolateRuntimeSource("globalExposureHelpers")',
		);
		expect(loaderSource).toContain(
			'getIsolateRuntimeSource("setupDynamicImport")',
		);
		expect(loaderSource).toContain('getIsolateRuntimeSource("setupFsFacade")');
		expect(loaderSource).toContain(
			'getIsolateRuntimeSource("initCommonjsModuleGlobals")',
		);
	});

	it("keeps bridge/require setup loaders on static isolate-runtime sources", () => {
		const bridgeLoader = readSource("src/bridge-loader.ts");
		const bridgeSetup = readSource("src/bridge-setup.ts");
		// require-setup.ts canonical source is in @secure-exec/core
		const requireSetup = readFileSync(
			new URL("../../secure-exec-core/src/shared/require-setup.ts", import.meta.url),
			"utf8",
		);

		expect(bridgeLoader).not.toMatch(/return\s*`/);
		expect(bridgeSetup).not.toMatch(/return\s*`/);
		expect(requireSetup).not.toMatch(/return\s*`/);

		expect(bridgeLoader).toContain("getIsolateRuntimeSource");
		expect(bridgeSetup).toContain("getIsolateRuntimeSource");
		expect(requireSetup).toContain('getIsolateRuntimeSource("requireSetup")');
	});

	it("browser worker no longer injects fs module code via code strings", () => {
		const workerSource = readSource("src/browser/worker.ts");
		expect(workerSource).not.toContain("_fsModuleCode");
		expect(workerSource).toContain('getIsolateRuntimeSource("globalExposureHelpers")');
	});

	it("builds isolate runtime from src/inject entrypoints with shared common modules", () => {
		const buildScript = readSource("scripts/build-isolate-runtime.mjs");
		expect(buildScript).toContain('path.join(process.cwd(), "isolate-runtime", "src")');
		expect(buildScript).toContain('path.join(runtimeSourceDir, "inject")');
		expect(buildScript).toContain("bundle: true");
	});
});
