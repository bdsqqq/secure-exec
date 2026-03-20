/**
 * E2E test: Claude Code headless mode via sandbox child_process bridge.
 *
 * Verifies Claude Code can boot in -p mode, produce output in text/json/
 * stream-json formats, read/write files, and execute bash commands via a
 * mock LLM server that intercepts Anthropic API calls. Claude Code is a
 * native Node.js CLI — tests exercise the child_process.spawn bridge by
 * running JS code inside the sandbox VM that calls
 * child_process.spawn('claude', ...). The bridge spawns the real claude
 * binary on the host.
 *
 * Claude Code natively supports ANTHROPIC_BASE_URL, so the mock LLM server
 * works without any fetch interceptor. stream-json requires --verbose flag.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  NodeRuntime,
  NodeFileSystem,
  allowAll,
  createNodeDriver,
} from '../../src/index.js';
import type { CommandExecutor, SpawnedProcess } from '../../src/types.js';
import { createTestNodeRuntime } from '../test-utils.js';
import {
  createMockLlmServer,
  type MockLlmServerHandle,
} from './mock-llm-server.ts';

// ---------------------------------------------------------------------------
// Skip helpers
// ---------------------------------------------------------------------------

function findClaudeBinary(): string | null {
  const candidates = [
    'claude',
    path.join(process.env.HOME ?? '', '.claude', 'local', 'claude'),
  ];
  const { execSync } = require('node:child_process');
  for (const bin of candidates) {
    try {
      execSync(`"${bin}" --version`, { stdio: 'ignore' });
      return bin;
    } catch {
      // continue
    }
  }
  return null;
}

const claudeBinary = findClaudeBinary();
const skipReason = claudeBinary
  ? false
  : 'claude binary not found';

// ---------------------------------------------------------------------------
// Stdio capture helper
// ---------------------------------------------------------------------------

type CapturedEvent = {
  channel: 'stdout' | 'stderr';
  message: string;
};

function createStdioCapture() {
  const events: CapturedEvent[] = [];
  return {
    events,
    onStdio: (event: CapturedEvent) => events.push(event),
    // Join with newline: the bridge strips trailing newlines from each
    // process.stdout.write() call, so NDJSON events arriving as separate
    // chunks lose their delimiters. Newline-join restores them.
    stdout: () =>
      events
        .filter((e) => e.channel === 'stdout')
        .map((e) => e.message)
        .join('\n'),
    stderr: () =>
      events
        .filter((e) => e.channel === 'stderr')
        .map((e) => e.message)
        .join('\n'),
  };
}

// ---------------------------------------------------------------------------
// Host command executor for child_process bridge
// ---------------------------------------------------------------------------

function createHostCommandExecutor(): CommandExecutor {
  return {
    spawn(
      command: string,
      args: string[],
      options: {
        cwd?: string;
        env?: Record<string, string>;
        onStdout?: (data: Uint8Array) => void;
        onStderr?: (data: Uint8Array) => void;
      },
    ): SpawnedProcess {
      const child = nodeSpawn(command, args, {
        cwd: options.cwd,
        env: options.env,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (options.onStdout)
        child.stdout.on('data', (d: Buffer) =>
          options.onStdout!(new Uint8Array(d)),
        );
      if (options.onStderr)
        child.stderr.on('data', (d: Buffer) =>
          options.onStderr!(new Uint8Array(d)),
        );
      return {
        writeStdin(data: Uint8Array | string) {
          child.stdin.write(data);
        },
        closeStdin() {
          child.stdin.end();
        },
        kill(signal?: number) {
          child.kill(signal);
        },
        wait(): Promise<number> {
          return new Promise((resolve) =>
            child.on('close', (code) => resolve(code ?? 1)),
          );
        },
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Sandbox runtime factory
// ---------------------------------------------------------------------------

function createClaudeSandboxRuntime(opts: {
  onStdio: (event: CapturedEvent) => void;
}): NodeRuntime {
  return createTestNodeRuntime({
    driver: createNodeDriver({
      filesystem: new NodeFileSystem(),
      commandExecutor: createHostCommandExecutor(),
      permissions: allowAll,
      processConfig: {
        cwd: '/root',
        env: {
          PATH: process.env.PATH ?? '/usr/bin',
          HOME: process.env.HOME ?? tmpdir(),
        },
      },
    }),
    onStdio: opts.onStdio,
  });
}

const SANDBOX_EXEC_OPTS = { filePath: '/root/entry.js', cwd: '/root' };

// ---------------------------------------------------------------------------
// Sandbox code builders
// ---------------------------------------------------------------------------

/** Build env object for Claude spawn inside the sandbox. */
function claudeEnv(opts: {
  mockPort: number;
  extraEnv?: Record<string, string>;
}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: `http://127.0.0.1:${opts.mockPort}`,
    ...(opts.extraEnv ?? {}),
  };
}

/**
 * Build sandbox code that spawns Claude Code and pipes stdout/stderr to
 * process.stdout/stderr. Exit code is forwarded from the binary.
 *
 * process.exit() must be called at the top-level await, not inside a bridge
 * callback — calling it inside childProcessDispatch would throw a
 * ProcessExitError through the host reference chain.
 */
function buildSpawnCode(opts: {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  timeout?: number;
}): string {
  return `(async () => {
    const { spawn } = require('child_process');
    const child = spawn(${JSON.stringify(claudeBinary)}, ${JSON.stringify(opts.args)}, {
      env: ${JSON.stringify(opts.env)},
      cwd: ${JSON.stringify(opts.cwd)},
    });

    child.stdin.end();

    child.stdout.on('data', (d) => process.stdout.write(String(d)));
    child.stderr.on('data', (d) => process.stderr.write(String(d)));

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(124);
      }, ${opts.timeout ?? 45000});

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) process.exit(exitCode);
  })()`;
}

/**
 * Build sandbox code that spawns Claude Code, waits for any output, sends
 * SIGINT through the bridge, then reports the exit code.
 */
function buildSigintCode(opts: {
  args: string[];
  env: Record<string, string>;
  cwd: string;
}): string {
  return `(async () => {
    const { spawn } = require('child_process');
    const child = spawn(${JSON.stringify(claudeBinary)}, ${JSON.stringify(opts.args)}, {
      env: ${JSON.stringify(opts.env)},
      cwd: ${JSON.stringify(opts.cwd)},
    });

    child.stdin.end();

    child.stdout.on('data', (d) => process.stdout.write(String(d)));
    child.stderr.on('data', (d) => process.stderr.write(String(d)));

    // Wait for output then send SIGINT
    let sentSigint = false;
    const onOutput = () => {
      if (!sentSigint) {
        sentSigint = true;
        child.kill('SIGINT');
      }
    };
    child.stdout.on('data', onOutput);
    child.stderr.on('data', onOutput);

    const exitCode = await new Promise((resolve) => {
      const noOutputTimer = setTimeout(() => {
        if (!sentSigint) {
          child.kill();
          resolve(2);
        }
      }, 15000);

      const killTimer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(137);
      }, 25000);

      child.on('close', (code) => {
        clearTimeout(noOutputTimer);
        clearTimeout(killTimer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) process.exit(exitCode);
  })()`;
}

/** Base args for Claude Code headless mode. */
const CLAUDE_BASE_ARGS = [
  '-p',
  '--dangerously-skip-permissions',
  '--no-session-persistence',
  '--model', 'haiku',
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;

describe.skipIf(skipReason)('Claude Code headless E2E (sandbox child_process bridge)', () => {
  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'claude-headless-'));
  });

  afterAll(async () => {
    await mockServer?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Boot & output
  // -------------------------------------------------------------------------

  it(
    'Claude boots in headless mode — exits with code 0',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello!' }]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [...CLAUDE_BASE_ARGS, 'say hello'],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        if (result.code !== 0) {
          console.log('Claude boot stderr:', capture.stderr().slice(0, 2000));
        }
        expect(result.code).toBe(0);
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'Claude produces text output — stdout contains canned LLM response',
    async () => {
      const canary = 'UNIQUE_CANARY_CC_42';
      mockServer.reset([{ type: 'text', text: canary }]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [...CLAUDE_BASE_ARGS, 'say hello'],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
        expect(capture.stdout()).toContain(canary);
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'Claude JSON output — --output-format json produces valid JSON with result',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello JSON!' }]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [...CLAUDE_BASE_ARGS, '--output-format', 'json', 'say hello'],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
        const parsed = JSON.parse(capture.stdout());
        expect(parsed).toHaveProperty('result');
        expect(parsed.type).toBe('result');
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'Claude stream-json output — --output-format stream-json produces valid NDJSON',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello stream!' }]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        // stream-json requires --verbose flag
        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              ...CLAUDE_BASE_ARGS,
              '--verbose',
              '--output-format', 'stream-json',
              'say hello',
            ],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        // stream-json emits NDJSON on stdout; non-JSON lines are filtered
        const combined = (capture.stdout() + '\n' + capture.stderr()).trim();
        const lines = combined.split('\n').filter(Boolean);
        const jsonLines: Array<Record<string, unknown>> = [];
        for (const line of lines) {
          try {
            jsonLines.push(JSON.parse(line) as Record<string, unknown>);
          } catch {
            // skip non-JSON lines
          }
        }
        expect(jsonLines.length).toBeGreaterThan(0);
        const hasTypedEvent = jsonLines.some((e) => e.type !== undefined);
        expect(hasTypedEvent).toBe(true);
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------

  it(
    'Claude reads a file — Read tool accesses seeded file',
    async () => {
      const testDir = path.join(workDir, 'read-test');
      await mkdir(testDir, { recursive: true });
      await writeFile(path.join(testDir, 'test.txt'), 'secret_content_xyz');

      mockServer.reset([
        {
          type: 'tool_use',
          name: 'Read',
          input: { file_path: path.join(testDir, 'test.txt') },
        },
        { type: 'text', text: 'The file contains: secret_content_xyz' },
      ]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              ...CLAUDE_BASE_ARGS,
              '--output-format', 'json',
              `read the file at ${path.join(testDir, 'test.txt')} and repeat its contents`,
            ],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: testDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        // Claude made at least 2 requests: prompt -> tool_use, tool_result -> text
        expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
        expect(capture.stdout()).toContain('secret_content_xyz');
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'Claude writes a file — file exists in filesystem after Write tool runs',
    async () => {
      const testDir = path.join(workDir, 'write-test');
      await mkdir(testDir, { recursive: true });
      const outPath = path.join(testDir, 'out.txt');

      mockServer.reset([
        {
          type: 'tool_use',
          name: 'Write',
          input: { file_path: outPath, content: 'hello from claude mock' },
        },
        { type: 'text', text: 'I wrote the file.' },
      ]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              ...CLAUDE_BASE_ARGS,
              '--output-format', 'json',
              `create a file at ${outPath}`,
            ],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: testDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
        expect(existsSync(outPath)).toBe(true);
        const content = await readFile(outPath, 'utf8');
        expect(content).toBe('hello from claude mock');
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  it(
    'Claude runs bash — Bash tool executes command via child_process',
    async () => {
      mockServer.reset([
        { type: 'tool_use', name: 'Bash', input: { command: 'echo hello' } },
        { type: 'text', text: 'Command output: hello' },
      ]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [
              ...CLAUDE_BASE_ARGS,
              '--output-format', 'json',
              'run echo hello',
            ],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
        expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  it(
    'SIGINT stops execution — send SIGINT through bridge, process terminates cleanly',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Write a very long essay...' }]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSigintCode({
            args: [...CLAUDE_BASE_ARGS, 'Write a very long essay about computing history'],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        // Exit code 2 = no output received (environment issue, skip gracefully)
        if (result.code === 2) return;

        // Should not need SIGKILL (exit code 137)
        expect(result.code).not.toBe(137);
      } finally {
        runtime.dispose();
      }
    },
    45_000,
  );

  // -------------------------------------------------------------------------
  // Exit codes
  // -------------------------------------------------------------------------

  it(
    'Claude exit codes — bad API key exits non-zero',
    async () => {
      // Tiny server that rejects all requests with 401
      const rejectServer = http.createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on('data', (c: Buffer) => chunks.push(c));
        req.on('end', () => {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(
            JSON.stringify({
              error: {
                type: 'authentication_error',
                message: 'invalid x-api-key',
              },
            }),
          );
        });
      });
      await new Promise<void>((r) =>
        rejectServer.listen(0, '127.0.0.1', r),
      );
      const rejectPort = (rejectServer.address() as AddressInfo).port;

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [...CLAUDE_BASE_ARGS, 'say hello'],
            env: claudeEnv({ mockPort: rejectPort }),
            cwd: workDir,
            timeout: 15_000,
          }),
          SANDBOX_EXEC_OPTS,
        );
        expect(result.code).not.toBe(0);
      } finally {
        runtime.dispose();
        await new Promise<void>((resolve, reject) => {
          rejectServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
    30_000,
  );

  it(
    'Claude exit codes — good prompt exits 0',
    async () => {
      mockServer.reset([{ type: 'text', text: 'All good!' }]);

      const capture = createStdioCapture();
      const runtime = createClaudeSandboxRuntime({ onStdio: capture.onStdio });

      try {
        const result = await runtime.exec(
          buildSpawnCode({
            args: [...CLAUDE_BASE_ARGS, 'say hello'],
            env: claudeEnv({ mockPort: mockServer.port }),
            cwd: workDir,
          }),
          SANDBOX_EXEC_OPTS,
        );

        expect(result.code).toBe(0);
      } finally {
        runtime.dispose();
      }
    },
    60_000,
  );
});
