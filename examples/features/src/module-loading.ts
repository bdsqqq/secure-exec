import path from "node:path";
import { fileURLToPath } from "node:url";
import {
	NodeRuntime,
	allowAllFs,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "../../../packages/secure-exec/src/index.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

const runtime = new NodeRuntime({
	systemDriver: createNodeDriver({
		moduleAccess: { cwd: repoRoot },
		permissions: { ...allowAllFs },
	}),
	runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
	const result = await runtime.run<{ version: string }>(
		`
    const typescript = require("/root/node_modules/typescript/lib/typescript.js");
    module.exports = { version: typescript.version };
  `,
		"/app/example.js",
	);

	if (result.code !== 0 || typeof result.exports?.version !== "string") {
		throw new Error(`Unexpected runtime result: ${JSON.stringify(result)}`);
	}

	console.log(
		JSON.stringify({
			ok: true,
			version: result.exports.version,
			summary: "sandbox resolved the host typescript package from the overlay",
		}),
	);
} finally {
	runtime.dispose();
}
