import {
	readFile,
	readdir,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	allowAllEnv,
	allowAllFs,
	allowAllNetwork,
	createDefaultNetworkAdapter,
	NodeFileSystem,
} from "../src/index.js";
import {
	assertPathExists,
	type CapturedConsoleEvent,
	formatConsoleChannel,
	formatErrorOutput,
	isRecord,
	normalizeEnvelope,
	pathExists,
	type PreparedFixture,
	prepareFixtureProject as prepareSharedFixtureProject,
	type ResultEnvelope,
	runHostExecution,
} from "./project-matrix/shared.js";
import { createTestNodeRuntime } from "./test-utils.js";
import {
	buildImage,
	getContainerInternalIp,
	skipUnlessDocker,
	startContainer,
	type Container,
} from "./utils/docker.js";

const TEST_TIMEOUT_MS = 55_000;

const TESTS_ROOT = path.dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = path.resolve(TESTS_ROOT, "..");
const WORKSPACE_ROOT = path.resolve(PACKAGE_ROOT, "..", "..");
const FIXTURES_ROOT = path.join(TESTS_ROOT, "e2e-docker");
const CACHE_ROOT = path.join(PACKAGE_ROOT, ".cache", "e2e-docker");

const fixturePermissions = {
	...allowAllFs,
	...allowAllEnv,
	...allowAllNetwork,
};

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

type ServiceName = "postgres" | "mysql" | "redis" | "ssh";

const validServices = new Set<string>(["postgres", "mysql", "redis", "ssh"]);

type PassFixtureMetadata = {
	entry: string;
	expectation: "pass";
	services: ServiceName[];
};

type FailFixtureMetadata = {
	entry: string;
	expectation: "fail";
	services: ServiceName[];
	fail: {
		code: number;
		stderrIncludes: string;
	};
};

type FixtureMetadata = PassFixtureMetadata | FailFixtureMetadata;

type FixtureProject = {
	name: string;
	sourceDir: string;
	metadata: FixtureMetadata;
};

type ServiceConnection = { host: string; port: number };
type ServiceConnections = Partial<Record<ServiceName, ServiceConnection>>;

/* ------------------------------------------------------------------ */
/*  Skip logic                                                         */
/* ------------------------------------------------------------------ */

const skipReason = skipUnlessDocker();

/* ------------------------------------------------------------------ */
/*  Container lifecycle state                                          */
/* ------------------------------------------------------------------ */

const activeContainers: Container[] = [];
let services: ServiceConnections = {};
let internalAddresses: Partial<
	Record<ServiceName, { host: string; port: number }>
> = {};

/* ------------------------------------------------------------------ */
/*  Fixture discovery (runs at module load)                            */
/* ------------------------------------------------------------------ */

const discoveredFixtures = await discoverFixtures();

/* ------------------------------------------------------------------ */
/*  Test suite                                                         */
/* ------------------------------------------------------------------ */

describe.skipIf(skipReason)("e2e-docker", () => {
	beforeAll(async () => {
		// Build custom images
		const sshdDockerfile = path.join(
			FIXTURES_ROOT,
			"dockerfiles",
			"sshd.Dockerfile",
		);
		buildImage(sshdDockerfile, "secure-exec-test-sshd");

		const pgSslDockerfile = path.join(
			FIXTURES_ROOT,
			"dockerfiles",
			"postgres-ssl.Dockerfile",
		);
		buildImage(pgSslDockerfile, "secure-exec-test-postgres-ssl");

		// Start containers (startContainer is synchronous — sequential start)
		const pg = startContainer("secure-exec-test-postgres-ssl", {
			ports: { 5432: 0 },
			env: {
				POSTGRES_USER: "testuser",
				POSTGRES_PASSWORD: "testpass",
				POSTGRES_DB: "testdb",
			},
			healthCheck: ["pg_isready", "-U", "testuser", "-d", "testdb"],
			healthCheckTimeout: 30_000,
			args: ["--tmpfs", "/var/lib/postgresql/data"],
			// Enable SSL with self-signed certificate from custom image
			command: [
				"-c", "ssl=on",
				"-c", "ssl_cert_file=/var/lib/postgresql/server.crt",
				"-c", "ssl_key_file=/var/lib/postgresql/server.key",
			],
		});

		const mysql = startContainer("mysql:8.0", {
			ports: { 3306: 0 },
			env: {
				MYSQL_ROOT_PASSWORD: "rootpass",
				MYSQL_DATABASE: "testdb",
				MYSQL_USER: "testuser",
				MYSQL_PASSWORD: "testpass",
			},
			healthCheck: [
				"mysql",
				"-u",
				"testuser",
				"-ptestpass",
				"-e",
				"SELECT 1",
			],
			healthCheckTimeout: 60_000,
			args: ["--tmpfs", "/var/lib/mysql"],
			// Use mysql_native_password to bypass caching_sha2_password which
			// requires crypto.publicEncrypt() not yet available in the sandbox
			command: ["--default-authentication-plugin=mysql_native_password"],
		});

		const redis = startContainer("redis:7-alpine", {
			ports: { 6379: 0 },
			healthCheck: ["redis-cli", "ping"],
			healthCheckTimeout: 15_000,
		});

		const ssh = startContainer("secure-exec-test-sshd", {
			ports: { 22: 0 },
			healthCheck: ["sshd", "-t"],
			healthCheckTimeout: 15_000,
		});

		activeContainers.push(pg, mysql, redis, ssh);

		services = {
			postgres: { host: pg.host, port: pg.port },
			mysql: { host: mysql.host, port: mysql.port },
			redis: { host: redis.host, port: redis.port },
			ssh: { host: ssh.host, port: ssh.port },
		};

		// Internal Docker bridge IPs for tunnel tests (SSH container can reach
		// other containers on the same bridge by their internal IP)
		internalAddresses = {
			redis: {
				host: getContainerInternalIp(redis.containerId),
				port: 6379,
			},
		};
	}, 180_000);

	afterAll(() => {
		for (const container of activeContainers) {
			container.stop();
		}
	});

	it("services are configured", () => {
		expect(services.postgres).toBeDefined();
		expect(services.mysql).toBeDefined();
		expect(services.redis).toBeDefined();
		expect(services.ssh).toBeDefined();
	});

	for (const fixture of discoveredFixtures) {
		it(
			`parity: ${fixture.name}`,
			async () => {
				const prepared = await prepareFixtureProject(fixture);
				const serviceEnv = getServiceEnvVars(
					fixture.metadata.services,
					services,
				);

				const host = await runHostExecution(
					prepared.projectDir,
					fixture.metadata.entry,
					serviceEnv,
				);
				assertHostFixtureBaseline(host);
				const sandbox = await runSandboxExecution(
					prepared.projectDir,
					fixture.metadata.entry,
					serviceEnv,
				);

				if (fixture.metadata.expectation === "pass") {
					expect(sandbox.code).toBe(host.code);
					expect(sandbox.stdout).toBe(host.stdout);
					expect(sandbox.stderr).toBe(host.stderr);
					return;
				}

				// Fail expectation: host should succeed, sandbox should fail predictably
				expect(sandbox.code).toBe(fixture.metadata.fail.code);
				expect(sandbox.stderr).toContain(
					fixture.metadata.fail.stderrIncludes,
				);
			},
			TEST_TIMEOUT_MS,
		);
	}
});

function assertHostFixtureBaseline(host: ResultEnvelope): void {
	// Validate the fixture in plain Node before treating any mismatch as a sandbox bug.
	expect(host.code).toBe(0);
}

/* ------------------------------------------------------------------ */
/*  Service env var injection                                          */
/* ------------------------------------------------------------------ */

function getServiceEnvVars(
	neededServices: ServiceName[],
	connections: ServiceConnections,
): Record<string, string> {
	const env: Record<string, string> = {};
	for (const svc of neededServices) {
		const conn = connections[svc];
		if (!conn) continue;
		switch (svc) {
			case "postgres":
				env.PG_HOST = conn.host;
				env.PG_PORT = String(conn.port);
				break;
			case "mysql":
				env.MYSQL_HOST = conn.host;
				env.MYSQL_PORT = String(conn.port);
				break;
			case "redis": {
				env.REDIS_HOST = conn.host;
				env.REDIS_PORT = String(conn.port);
				const internal = internalAddresses.redis;
				if (internal) {
					env.REDIS_INTERNAL_HOST = internal.host;
					env.REDIS_INTERNAL_PORT = String(internal.port);
				}
				break;
			}
			case "ssh":
				env.SSH_HOST = conn.host;
				env.SSH_PORT = String(conn.port);
				break;
		}
	}
	return env;
}

/* ------------------------------------------------------------------ */
/*  Fixture discovery and metadata                                     */
/* ------------------------------------------------------------------ */

async function discoverFixtures(): Promise<FixtureProject[]> {
	let entries;
	try {
		entries = await readdir(FIXTURES_ROOT, { withFileTypes: true });
	} catch {
		return [];
	}

	const fixtureDirs = entries
		.filter((e) => e.isDirectory())
		.map((e) => e.name)
		.sort((left, right) => left.localeCompare(right));

	const fixtures: FixtureProject[] = [];
	for (const name of fixtureDirs) {
		const sourceDir = path.join(FIXTURES_ROOT, name);
		const metadataPath = path.join(sourceDir, "fixture.json");
		if (!(await pathExists(metadataPath))) continue;

		const metadataText = await readFile(metadataPath, "utf8");
		const metadata = parseFixtureMetadata(
			JSON.parse(metadataText) as unknown,
			name,
		);

		const entryPath = path.join(sourceDir, metadata.entry);
		await assertPathExists(
			entryPath,
			`Fixture "${name}" entry file not found: ${metadata.entry}`,
		);
		await assertPathExists(
			path.join(sourceDir, "package.json"),
			`Fixture "${name}" requires package.json`,
		);

		fixtures.push({ name, sourceDir, metadata });
	}

	return fixtures;
}

function parseFixtureMetadata(
	raw: unknown,
	fixtureName: string,
): FixtureMetadata {
	if (!isRecord(raw)) {
		throw new Error(`Fixture "${fixtureName}" metadata must be an object`);
	}
	if (typeof raw.entry !== "string" || raw.entry.length === 0) {
		throw new Error(`Fixture "${fixtureName}" requires a non-empty entry`);
	}
	if (raw.expectation !== "pass" && raw.expectation !== "fail") {
		throw new Error(
			`Fixture "${fixtureName}" expectation must be "pass" or "fail"`,
		);
	}

	// Validate services array
	if (!Array.isArray(raw.services)) {
		throw new Error(`Fixture "${fixtureName}" requires a services array`);
	}
	for (const s of raw.services) {
		if (typeof s !== "string" || !validServices.has(s)) {
			throw new Error(
				`Fixture "${fixtureName}" has invalid service: ${s}`,
			);
		}
	}
	const svcs = raw.services as ServiceName[];

	if (raw.expectation === "pass") {
		return { entry: raw.entry, expectation: "pass", services: svcs };
	}

	// Fail expectation requires a fail contract
	if (!isRecord(raw.fail)) {
		throw new Error(
			`Fixture "${fixtureName}" with expectation "fail" requires a fail contract`,
		);
	}
	if (typeof raw.fail.code !== "number") {
		throw new Error(
			`Fixture "${fixtureName}" fail contract requires numeric code`,
		);
	}
	if (
		typeof raw.fail.stderrIncludes !== "string" ||
		raw.fail.stderrIncludes.length === 0
	) {
		throw new Error(
			`Fixture "${fixtureName}" fail contract requires stderrIncludes`,
		);
	}

	return {
		entry: raw.entry,
		expectation: "fail",
		services: svcs,
		fail: {
			code: raw.fail.code,
			stderrIncludes: raw.fail.stderrIncludes,
		},
	};
}

/* ------------------------------------------------------------------ */
/*  Fixture preparation (cache + install)                              */
/* ------------------------------------------------------------------ */

async function prepareFixtureProject(
	fixture: FixtureProject,
): Promise<PreparedFixture> {
	return prepareSharedFixtureProject({
		cacheRoot: CACHE_ROOT,
		workspaceRoot: WORKSPACE_ROOT,
		fixtureName: fixture.name,
		sourceDir: fixture.sourceDir,
	});
}

/* ------------------------------------------------------------------ */
/*  Execution                                                          */
/* ------------------------------------------------------------------ */

async function runSandboxExecution(
	projectDir: string,
	entryRelativePath: string,
	serviceEnv: Record<string, string>,
): Promise<ResultEnvelope> {
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
			env: serviceEnv,
		},
	});

	try {
		const result = await proc.exec(entryCode, {
			filePath: entryPath,
			cwd: projectDir,
			env: serviceEnv,
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

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */
