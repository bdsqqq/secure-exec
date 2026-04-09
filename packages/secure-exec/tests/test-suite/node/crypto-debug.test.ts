import { describe } from "vitest";
import { allowAllNetwork } from "../../../src/index.js";
import type { NodeRuntimeOptions } from "../../../src/runtime.js";
import { runNodeCryptoDebugSuite } from "./crypto-debug.js";
import {
	type NodeSuiteContext,
} from "./node/runtime.js";

type RuntimeOptions = Omit<NodeRuntimeOptions, "systemDriver" | "runtimeDriverFactory">;

type DisposableRuntime = {
	dispose(): void;
	terminate(): Promise<void>;
};

async function importNodeEntrypoint() {
	const entrypointUrl = new URL("../../../src/index.js", import.meta.url).href;
	return import(/* @vite-ignore */ entrypointUrl);
}

function createSuiteContext(): NodeSuiteContext {
	const runtimes = new Set<DisposableRuntime>();

	return {
		target: "node",
		async createRuntime(options: RuntimeOptions = {}) {
			const {
				NodeRuntime: NodeRuntimeClass,
				createNodeDriver,
				createNodeRuntimeDriverFactory,
			} = await importNodeEntrypoint();
			const runtime = new NodeRuntimeClass({
				...options,
				systemDriver: createNodeDriver({
					useDefaultNetwork: true,
					permissions: allowAllNetwork,
				}),
				runtimeDriverFactory: createNodeRuntimeDriverFactory(),
			});
			runtimes.add(runtime);
			return runtime;
		},
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
	};
}

describe("crypto debug suite", () => {
	const context = createSuiteContext();
	runNodeCryptoDebugSuite(context);
});
