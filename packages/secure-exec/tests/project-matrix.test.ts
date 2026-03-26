import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
	allowAllEnv,
	allowAllFs,
	allowAllNetwork,
	createDefaultNetworkAdapter,
	createNodeDriver,
	NodeFileSystem,
} from "../src/index.js";
import {
	assertPathExists,
	type CapturedConsoleEvent,
	formatConsoleChannel,
	formatErrorOutput,
	normalizeEnvelope,
	parsePackageManagerFixtureMetadata,
	type PreparedFixture,
	prepareFixtureProject as prepareSharedFixtureProject,
	type ResultEnvelope,
	runHostExecution,
	type PackageManagerFixtureMetadata,
} from "./project-matrix/shared.js";
import { createTestNodeRuntime } from "./test-utils.js";

const TEST_TIMEOUT_MS = 55_000;

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TESTS_ROOT, "..");
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const FIXTURES_ROOT = path.join(TESTS_ROOT, "projects");
const CACHE_ROOT = path.join(PACKAGE_ROOT, ".cache", "project-matrix");

const fixturePermissions = {
	...allowAllFs,
	...allowAllEnv,
	...allowAllNetwork,
};

type FixtureMetadata = PackageManagerFixtureMetadata;

type FixtureProject = {
	name: string;
	sourceDir: string;
	metadata: FixtureMetadata;
};

const discoveredFixtures = await discoverFixtures();

describe("compatibility project matrix", () => {
	it("discovers at least one fixture project", () => {
		expect(discoveredFixtures.length).toBeGreaterThan(0);
	});

	it(
		"runs module-access-pass fixture in overlay mode with host node parity",
		async () => {
			const fixture = discoveredFixtures.find(
				(item) => item.name === "module-access-pass",
			);
			if (!fixture) {
				throw new Error('Fixture "module-access-pass" was not discovered');
			}

			const prepared = await prepareFixtureProject(fixture);
			const host = await runHostExecution(prepared.projectDir, fixture.metadata.entry);
			assertHostFixtureBaseline(host);
			const sandbox = await runOverlaySandboxExecution(
				prepared.projectDir,
				fixture.metadata.entry,
			);

			expect(sandbox.code).toBe(host.code);
			expect(sandbox.stdout).toBe(host.stdout);
			expect(sandbox.stderr).toBe(host.stderr);
		},
		TEST_TIMEOUT_MS,
	);

	for (const fixture of discoveredFixtures) {
		it(
			`runs fixture ${fixture.name} in host node and secure-exec`,
			async () => {
				const firstPrepare = await prepareFixtureProject(fixture);
				const secondPrepare = await prepareFixtureProject(fixture);

				expect(secondPrepare.cacheKey).toBe(firstPrepare.cacheKey);
				expect(secondPrepare.cacheHit).toBe(true);

				const host = await runHostExecution(
					secondPrepare.projectDir,
					fixture.metadata.entry,
				);
				assertHostFixtureBaseline(host);
				const sandbox = await runSandboxExecution(
					secondPrepare.projectDir,
					fixture.metadata.entry,
				);

				if (fixture.metadata.expectation === "pass") {
					expect(sandbox.code).toBe(0);
					expect(sandbox.stdout).toBe(host.stdout);
					expect(sandbox.stderr).toBe(host.stderr);
					return;
				}

				expect(sandbox.code).toBe(fixture.metadata.fail.code);
				expect(sandbox.stderr).toContain(fixture.metadata.fail.stderrIncludes);
			},
			TEST_TIMEOUT_MS,
		);
	}
});

function assertHostFixtureBaseline(host: ResultEnvelope): void {
	// Validate the fixture in plain Node before treating any mismatch as a sandbox bug.
	expect(host.code).toBe(0);
}

async function discoverFixtures(): Promise<FixtureProject[]> {
	// Get project directories and validate metadata before running tests.
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
		const parsed = JSON.parse(metadataText) as unknown;
		const metadata = parsePackageManagerFixtureMetadata(parsed, fixtureName);
		const entryPath = path.join(sourceDir, metadata.entry);
		await assertPathExists(
			entryPath,
			`Fixture "${fixtureName}" entry file not found: ${metadata.entry}`,
		);
		await assertPathExists(
			path.join(sourceDir, "package.json"),
			`Fixture "${fixtureName}" requires package.json`,
		);
		fixtures.push({
			name: fixtureName,
			sourceDir,
			metadata,
		});
	}

	return fixtures;
}

async function prepareFixtureProject(fixture: FixtureProject): Promise<PreparedFixture> {
	return prepareSharedFixtureProject({
		cacheRoot: CACHE_ROOT,
		workspaceRoot: WORKSPACE_ROOT,
		fixtureName: fixture.name,
		sourceDir: fixture.sourceDir,
		packageManager: fixture.metadata.packageManager,
	});
}

async function runSandboxExecution(
	projectDir: string,
	entryRelativePath: string,
): Promise<ResultEnvelope> {
	// Execute the same entrypoint code against secure-exec.
	const entryPath = path.join(projectDir, entryRelativePath);
	const entryCode = await readFile(entryPath, "utf8");
	const capturedEvents: CapturedConsoleEvent[] = [];
	const proc = createTestNodeRuntime({
		filesystem: new NodeFileSystem(),
		networkAdapter: createDefaultNetworkAdapter(),
		permissions: fixturePermissions,
		onStdio: (event) => {
			capturedEvents.push(event);
		},
		processConfig: {
			cwd: projectDir,
			env: {},
		},
	});

	try {
		const result = await proc.exec(entryCode, {
			filePath: entryPath,
			cwd: projectDir,
			env: {},
		});
		return normalizeEnvelope(
			{
				code: result.code,
				stdout: formatConsoleChannel(capturedEvents, "stdout"),
				stderr:
					formatConsoleChannel(capturedEvents, "stderr") +
					formatErrorOutput(result.errorMessage),
			},
			projectDir,
		);
	} finally {
		proc.dispose();
	}
}

async function runOverlaySandboxExecution(
	projectDir: string,
	entryRelativePath: string,
): Promise<ResultEnvelope> {
	// Execute the fixture entrypoint with overlay-only node_modules access.
	const entryPath = path.join(projectDir, entryRelativePath);
	const entryCode = await readFile(entryPath, "utf8");
	const capturedEvents: CapturedConsoleEvent[] = [];
	const driver = createNodeDriver({
		moduleAccess: {
			cwd: projectDir,
		},
		permissions: fixturePermissions,
	});
	const sandboxEntry = `/root/${entryRelativePath
		.replace(/\\/g, "/")
		.replace(/^\/+/, "")}`;
	const proc = createTestNodeRuntime({
		driver,
		onStdio: (event) => {
			capturedEvents.push(event);
		},
		processConfig: {
			cwd: "/root",
			env: {},
		},
	});

	try {
		const result = await proc.exec(entryCode, {
			filePath: sandboxEntry,
			cwd: "/root",
			env: {},
		});
		return normalizeEnvelope(
			{
				code: result.code,
				stdout: formatConsoleChannel(capturedEvents, "stdout"),
				stderr:
					formatConsoleChannel(capturedEvents, "stderr") +
					formatErrorOutput(result.errorMessage),
			},
			projectDir,
		);
	} finally {
		proc.dispose();
	}
}
