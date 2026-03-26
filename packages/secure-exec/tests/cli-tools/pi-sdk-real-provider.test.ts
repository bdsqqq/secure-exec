/**
 * E2E test: Pi SDK programmatic surface through the secure-exec sandbox.
 *
 * Uses the vendored `@mariozechner/pi-coding-agent` SDK entrypoint
 * `createAgentSession()` inside `NodeRuntime`, with real provider traffic and
 * opt-in runtime credentials loaded from the host.
 */

import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  NodeRuntime,
  NodeFileSystem,
  allowAll,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from '../../src/index.js';
import { loadRealProviderEnv } from './real-provider-env.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECURE_EXEC_ROOT = path.resolve(__dirname, '../..');
const REAL_PROVIDER_FLAG = 'SECURE_EXEC_PI_REAL_PROVIDER_E2E';

function skipUnlessPiInstalled(): string | false {
  const piPath = path.resolve(
    SECURE_EXEC_ROOT,
    'node_modules/@mariozechner/pi-coding-agent/dist/index.js',
  );
  return existsSync(piPath)
    ? false
    : '@mariozechner/pi-coding-agent not installed';
}

const PI_SDK_ENTRY = path.resolve(
  SECURE_EXEC_ROOT,
  'node_modules/@mariozechner/pi-coding-agent/dist/index.js',
);

function getSkipReason(): string | false {
  const piSkip = skipUnlessPiInstalled();
  if (piSkip) return piSkip;

  if (process.env[REAL_PROVIDER_FLAG] !== '1') {
    return `${REAL_PROVIDER_FLAG}=1 required for real provider E2E`;
  }

  return loadRealProviderEnv(['ANTHROPIC_API_KEY']).skipReason ?? false;
}

function buildSandboxSource(opts: { workDir: string }): string {
  return [
    'import path from "node:path";',
    `const workDir = ${JSON.stringify(opts.workDir)};`,
    'let session;',
    'try {',
    `  const pi = await globalThis.__dynamicImport(${JSON.stringify(PI_SDK_ENTRY)}, "/entry.mjs");`,
    '  const authStorage = pi.AuthStorage.create(path.join(workDir, "auth.json"));',
    '  const modelRegistry = new pi.ModelRegistry(authStorage);',
    '  const available = await modelRegistry.getAvailable();',
    '  const preferredAnthropicIds = [',
    '    "claude-haiku-4-5-20251001",',
    '    "claude-sonnet-4-6",',
    '    "claude-sonnet-4-20250514",',
    '  ];',
    '  const model = preferredAnthropicIds',
    '    .map((id) => available.find((candidate) => candidate.provider === "anthropic" && candidate.id === id))',
    '    .find(Boolean) ?? available.find((candidate) => candidate.provider === "anthropic") ?? available[0];',
    '  if (!model) throw new Error("No Pi model available from real-provider credentials");',
    '  ({ session } = await pi.createAgentSession({',
    '    cwd: workDir,',
    '    authStorage,',
    '    modelRegistry,',
    '    model,',
    '    tools: pi.createCodingTools(workDir),',
    '    sessionManager: pi.SessionManager.inMemory(),',
    '  }));',
    '  const toolEvents = [];',
    '  session.subscribe((event) => {',
    '    if (event.type === "tool_execution_start") {',
    '      toolEvents.push({ type: event.type, toolName: event.toolName });',
    '    }',
    '    if (event.type === "tool_execution_end") {',
    '      toolEvents.push({ type: event.type, toolName: event.toolName, isError: event.isError });',
    '    }',
    '  });',
    '  await pi.runPrintMode(session, {',
    '    mode: "text",',
    '    initialMessage: "Read note.txt and answer with the exact file contents only.",',
    '  });',
    '  console.log(JSON.stringify({',
    '    ok: true,',
    '    api: "runPrintMode + createAgentSession + SessionManager.inMemory + createCodingTools",',
    '    model: `${model.provider}/${model.id}`,',
    '    toolEvents,',
    '  }));',
    '  session.dispose();',
    '} catch (error) {',
    '  const errorMessage = error instanceof Error ? error.message : String(error);',
    '  console.log(JSON.stringify({',
    '    ok: false,',
    '    error: errorMessage.split("\\n")[0].slice(0, 600),',
    '    stack: error instanceof Error ? error.stack : String(error),',
    '    lastStopReason: session?.state?.messages?.at(-1)?.stopReason,',
    '    lastErrorMessage: session?.state?.messages?.at(-1)?.errorMessage,',
    '    code: error && typeof error === "object" && "code" in error ? error.code : undefined,',
    '  }));',
    '  process.exitCode = 1;',
    '}',
  ].join('\n');
}

function parseLastJsonLine(stdout: string): Record<string, unknown> {
  const trimmed = stdout.trim();
  if (!trimmed) {
    throw new Error(`sandbox produced no JSON output: ${JSON.stringify(stdout)}`);
  }

  for (let index = trimmed.lastIndexOf('{'); index >= 0; index = trimmed.lastIndexOf('{', index - 1)) {
    const candidate = trimmed.slice(index);
    try {
      return JSON.parse(candidate) as Record<string, unknown>;
    } catch {
      // Keep scanning backward until the final complete JSON object is found.
    }
  }

  throw new Error(`sandbox produced no trailing JSON object: ${JSON.stringify(stdout)}`);
}

const skipReason = getSkipReason();

describe.skipIf(skipReason)('Pi SDK real-provider E2E (sandbox VM)', () => {
  let runtime: NodeRuntime | undefined;
  let workDir: string | undefined;

  afterAll(async () => {
    await runtime?.terminate();
    if (workDir) {
      await rm(workDir, { recursive: true, force: true });
    }
  });

  it(
    'runs createAgentSession end-to-end with a real provider and read tool inside NodeRuntime',
    async () => {
      const providerEnv = loadRealProviderEnv(['ANTHROPIC_API_KEY']);
      expect(providerEnv.skipReason).toBeUndefined();

      workDir = await mkdtemp(path.join(tmpdir(), 'pi-sdk-real-provider-'));
      const canary = `PI_REAL_PROVIDER_${Date.now()}_${Math.random().toString(36).slice(2)}`;
      await writeFile(path.join(workDir, 'note.txt'), canary);

      const stdout: string[] = [];
      const stderr: string[] = [];

      runtime = new NodeRuntime({
        onStdio: (event) => {
          if (event.channel === 'stdout') stdout.push(event.message);
          if (event.channel === 'stderr') stderr.push(event.message);
        },
        systemDriver: createNodeDriver({
          filesystem: new NodeFileSystem(),
          moduleAccess: { cwd: SECURE_EXEC_ROOT },
          permissions: allowAll,
          useDefaultNetwork: true,
        }),
        runtimeDriverFactory: createNodeRuntimeDriverFactory(),
      });

      const result = await runtime.exec(buildSandboxSource({ workDir }), {
        cwd: workDir,
        filePath: '/entry.mjs',
        env: {
          ...providerEnv.env!,
          HOME: workDir,
          NO_COLOR: '1',
        },
      });

      expect(result.code, stderr.join('')).toBe(0);

      const payload = parseLastJsonLine(stdout.join(''));
      expect(payload.ok, JSON.stringify(payload)).toBe(true);
      expect(payload.api).toBe(
        'runPrintMode + createAgentSession + SessionManager.inMemory + createCodingTools',
      );

      expect(stdout.join('')).toContain(canary);

      const toolEvents = Array.isArray(payload.toolEvents)
        ? payload.toolEvents as Array<Record<string, unknown>>
        : [];
      expect(
        toolEvents.some((event) => event.toolName === 'read' && event.type === 'tool_execution_start'),
      ).toBe(true);
      expect(
        toolEvents.some((event) => event.toolName === 'read' && event.type === 'tool_execution_end' && event.isError === false),
      ).toBe(true);
    },
    90_000,
  );
});
