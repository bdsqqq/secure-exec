/**
 * E2E project-matrix test: run existing fixture projects through the kernel.
 *
 * For each fixture in tests/projects/:
 *   1. Prepare project (package-manager install, cached by content hash)
 *   2. Run entry via host Node (baseline)
 *   3. Run entry via kernel (NodeFileSystem rooted at project dir, WasmVM + Node)
 *   4. Compare output parity
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createKernel } from "../../../core/src/index.ts";
import {
	createNodeRuntime,
	NodeFileSystem,
} from "../../../nodejs/src/index.ts";
import { createWasmVmRuntime } from "../../../wasmvm/src/index.ts";
import {
	assertPathExists,
	type PackageManagerFixtureMetadata,
	parsePackageManagerFixtureMetadata,
	type PreparedFixture,
	type ResultEnvelope,
	prepareFixtureProject as prepareSharedFixtureProject,
	runHostExecution,
} from "../project-matrix/shared.js";
import { skipUnlessWasmBuilt } from "./helpers.ts";

const TEST_TIMEOUT_MS = 55_000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TESTS_ROOT = path.resolve(__dirname, "..");
const PACKAGE_ROOT = path.resolve(TESTS_ROOT, "..");
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const FIXTURES_ROOT = path.join(TESTS_ROOT, "projects");
const CACHE_ROOT = path.join(PACKAGE_ROOT, ".cache", "project-matrix");

const COMMANDS_DIR = path.resolve(
	__dirname,
	"../../../wasmvm/target/wasm32-wasip1/release/commands",
);

type FixtureProject = {
	name: string;
	sourceDir: string;
	metadata: PackageManagerFixtureMetadata;
};

async function discoverFixtures(): Promise<FixtureProject[]> {
	const entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
	const fixtureDirs = entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort((left, right) => left.localeCompare(right));

	const fixtures: FixtureProject[] = [];
	for (const fixtureName of fixtureDirs) {
		const sourceDir = path.join(FIXTURES_ROOT, fixtureName);
		const metadataPath = path.join(sourceDir, "fixture.json");
		const metadataText = await readFile(metadataPath, "utf8");
		const metadata = parsePackageManagerFixtureMetadata(
			JSON.parse(metadataText) as unknown,
			fixtureName,
		);
		const entryPath = path.join(sourceDir, metadata.entry);
		await assertPathExists(
			entryPath,
			`Fixture "${fixtureName}" entry file not found: ${metadata.entry}`,
		);
		await assertPathExists(
			path.join(sourceDir, "package.json"),
			`Fixture "${fixtureName}" requires package.json`,
		);
		fixtures.push({ name: fixtureName, sourceDir, metadata });
	}

	return fixtures;
}

async function prepareFixtureProject(
	fixture: FixtureProject,
): Promise<PreparedFixture> {
	return prepareSharedFixtureProject({
		cacheRoot: CACHE_ROOT,
		workspaceRoot: WORKSPACE_ROOT,
		fixtureName: fixture.name,
		sourceDir: fixture.sourceDir,
		packageManager: fixture.metadata.packageManager,
	});
}

async function runKernelExecution(
	projectDir: string,
	entryRelativePath: string,
): Promise<ResultEnvelope> {
	const vfs = new NodeFileSystem({ root: projectDir });
	const kernel = createKernel({ filesystem: vfs, cwd: "/" });

	await kernel.mount(createWasmVmRuntime({ commandDirs: [COMMANDS_DIR] }));
	await kernel.mount(createNodeRuntime());

	try {
		const vfsEntry = `/${entryRelativePath.replace(/\\/g, "/")}`;
		const result = await kernel.exec(`node ${vfsEntry}`, { cwd: "/" });
		return {
			code: result.exitCode,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} finally {
		await kernel.dispose();
	}
}

function assertHostFixtureBaseline(host: ResultEnvelope): void {
	// Validate the fixture in plain Node before treating any mismatch as a sandbox bug.
	expect(host.code).toBe(0);
}

const skipReason = skipUnlessWasmBuilt();
const discoveredFixtures = await discoverFixtures();

describe.skipIf(skipReason)("e2e project-matrix through kernel", () => {
	it("discovers at least one fixture project", () => {
		expect(discoveredFixtures.length).toBeGreaterThan(0);
	});

	for (const fixture of discoveredFixtures) {
		it(
			`runs fixture ${fixture.name} through kernel with host-node parity`,
			async () => {
				const prepared = await prepareFixtureProject(fixture);
				const host = await runHostExecution(
					prepared.projectDir,
					fixture.metadata.entry,
				);
				assertHostFixtureBaseline(host);

				const kernel = await runKernelExecution(
					prepared.projectDir,
					fixture.metadata.entry,
				);

				if (fixture.metadata.expectation === "pass") {
					expect(kernel.code).toBe(0);
					expect(kernel.stdout).toBe(host.stdout);
					expect(kernel.stderr).toBe(host.stderr);
					return;
				}

				expect(kernel.code).toBe(fixture.metadata.fail.code);
				expect(kernel.stderr).toContain(
					fixture.metadata.fail.stderrIncludes,
				);
			},
			TEST_TIMEOUT_MS,
		);
	}
});
