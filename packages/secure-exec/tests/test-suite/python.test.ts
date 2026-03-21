import { describe } from "vitest";
import { allowAll } from "../../src/shared/permissions.js";
import {
	runPythonNetworkSuite,
} from "./python/network.js";
import {
	runPythonParitySuite,
	runPythonRuntimeSuite,
	type PythonCreateRuntimeOptions,
	type PythonSuiteContext,
} from "./python/runtime.js";

type DisposableRuntime = {
	dispose(): void;
	terminate(): Promise<void>;
};

function isNodeTargetAvailable(): boolean {
	return typeof process !== "undefined" && Boolean(process.versions?.node);
}

function createPythonSuiteContext(): PythonSuiteContext {
	const runtimes = new Set<DisposableRuntime>();

	return {
		async teardown(): Promise<void> {
			const runtimeList = Array.from(runtimes);
			runtimes.clear();

			for (const runtime of runtimeList) {
				try {
					await runtime.terminate();
				} catch {
					runtime.dispose();
				}
			}
		},
		async createNodeRuntime(options: PythonCreateRuntimeOptions = {}) {
			const { systemDriver, ...runtimeOptions } = options;
			const {
				NodeRuntime: NodeRuntimeClass,
				createNodeDriver,
				createNodeRuntimeDriverFactory,
			} = await import("../../src/index.js");
			const runtime = new NodeRuntimeClass({
				...runtimeOptions,
				systemDriver:
					systemDriver ??
					createNodeDriver({
						useDefaultNetwork: true,
						permissions: allowAll,
					}),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});
			runtimes.add(runtime);
			return runtime;
		},
		async createPythonRuntime(options: PythonCreateRuntimeOptions = {}) {
			const { systemDriver, ...runtimeOptions } = options;
			const {
				PythonRuntime: PythonRuntimeClass,
				createNodeDriver,
			} = await import("../../src/index.js");
			const { createPyodideRuntimeDriverFactory } = await import(
				"@secure-exec/python"
			);
			const runtime = new PythonRuntimeClass({
				...runtimeOptions,
				systemDriver:
					systemDriver ??
					createNodeDriver({
						useDefaultNetwork: true,
						permissions: allowAll,
					}),
				runtimeDriverFactory: createPyodideRuntimeDriverFactory(),
			});
			runtimes.add(runtime);
			return runtime;
		},
	};
}

describe.skipIf(!isNodeTargetAvailable())("python runtime integration suite", () => {
	const context = createPythonSuiteContext();
	runPythonParitySuite(context);
	runPythonRuntimeSuite(context);
	runPythonNetworkSuite(context);
});
