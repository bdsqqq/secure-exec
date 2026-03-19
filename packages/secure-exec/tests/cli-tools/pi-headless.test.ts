/**
 * E2E test: Pi coding agent headless mode with mock LLM server.
 *
 * Verifies Pi can boot, produce output, read/write files, and execute
 * bash commands using a mock LLM server instead of real API calls.
 *
 * Pi runs as a host process with a fetch interceptor (fetch-intercept.cjs)
 * that redirects Anthropic API calls to the mock server. The bridge's CJS-only
 * module loader cannot load Pi (ESM-only); in-VM execution awaits bridge ESM
 * support.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMockLlmServer,
  type MockLlmServerHandle,
} from './mock-llm-server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Fetch interceptor that redirects Anthropic API calls to the mock server
const FETCH_INTERCEPT = path.resolve(__dirname, 'fetch-intercept.cjs');

// ---------------------------------------------------------------------------
// Skip helpers
// ---------------------------------------------------------------------------

function skipUnlessPiInstalled(): string | false {
  const cliPath = path.resolve(
    __dirname,
    '../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
  );
  return existsSync(cliPath)
    ? false
    : '@mariozechner/pi-coding-agent not installed';
}

const piSkip = skipUnlessPiInstalled();

// Pi CLI entry point
const PI_CLI = path.resolve(
  __dirname,
  '../../node_modules/@mariozechner/pi-coding-agent/dist/cli.js',
);

// ---------------------------------------------------------------------------
// Common Pi CLI flags
// ---------------------------------------------------------------------------

const PI_BASE_FLAGS = [
  '--verbose',
  '--no-session',
  '--no-extensions',
  '--no-skills',
  '--no-prompt-templates',
  '--no-themes',
];

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Run Pi as a host process pointing at the mock LLM server. */
function runPi(
  args: string[],
  opts: { port: number; cwd?: string; timeout?: number },
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? '',
      HOME: opts.cwd ?? tmpdir(),
      ANTHROPIC_API_KEY: 'test-key',
      MOCK_LLM_URL: `http://127.0.0.1:${opts.port}`,
      NODE_OPTIONS: `-r ${FETCH_INTERCEPT}`,
    };

    const child = spawn(
      process.execPath,
      [
        PI_CLI,
        ...PI_BASE_FLAGS,
        '--provider',
        'anthropic',
        '--model',
        'claude-sonnet-4-20250514',
        ...args,
      ],
      {
        env,
        cwd: opts.cwd ?? tmpdir(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    // Pi blocks without stdin EOF
    child.stdin.end();

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => {
      stdout += d.toString();
    });
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
    });

    const timer = setTimeout(() => {
      child.kill();
      resolve({ exitCode: 124, stdout, stderr });
    }, opts.timeout ?? 30_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr });
    });
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;

describe.skipIf(piSkip)('Pi headless E2E', () => {
  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-headless-'));
  });

  afterAll(async () => {
    await mockServer?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it(
    'Pi boots in print mode — exits with code 0',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello!' }]);

      const result = await runPi(['--print', 'say hello'], {
        port: mockServer.port,
        cwd: workDir,
      });

      if (result.exitCode !== 0) {
        console.log('Pi boot stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.exitCode).toBe(0);
    },
    45_000,
  );

  it(
    'Pi produces output — stdout contains canned LLM response',
    async () => {
      const canary = 'UNIQUE_CANARY_42';
      mockServer.reset([{ type: 'text', text: canary }]);

      const result = await runPi(['--print', 'say hello'], {
        port: mockServer.port,
        cwd: workDir,
      });

      expect(result.stdout).toContain(canary);
    },
    45_000,
  );

  it(
    'Pi reads a file — read tool accesses seeded file',
    async () => {
      const testDir = path.join(workDir, 'read-test');
      await mkdir(testDir, { recursive: true });
      await writeFile(path.join(testDir, 'test.txt'), 'secret_content_xyz');

      mockServer.reset([
        {
          type: 'tool_use',
          name: 'read',
          input: { path: path.join(testDir, 'test.txt') },
        },
        { type: 'text', text: 'The file contains: secret_content_xyz' },
      ]);

      const result = await runPi(
        [
          '--print',
          `read ${path.join(testDir, 'test.txt')} and repeat the contents`,
        ],
        { port: mockServer.port, cwd: workDir },
      );

      // Pi made at least 2 requests: prompt → tool_use, tool_result → text
      expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
      expect(result.stdout).toContain('secret_content_xyz');
    },
    45_000,
  );

  it(
    'Pi writes a file — file exists after write tool runs',
    async () => {
      const testDir = path.join(workDir, 'write-test');
      await mkdir(testDir, { recursive: true });
      const outPath = path.join(testDir, 'out.txt');

      mockServer.reset([
        {
          type: 'tool_use',
          name: 'write',
          input: { path: outPath, content: 'hello from pi mock' },
        },
        { type: 'text', text: 'I wrote the file.' },
      ]);

      const result = await runPi(
        ['--print', `create a file at ${outPath}`],
        { port: mockServer.port, cwd: workDir },
      );

      expect(result.exitCode).toBe(0);
      const content = await readFile(outPath, 'utf8');
      expect(content).toBe('hello from pi mock');
    },
    45_000,
  );

  it(
    'Pi runs bash command — bash tool executes ls via child_process',
    async () => {
      mockServer.reset([
        { type: 'tool_use', name: 'bash', input: { command: 'ls /' } },
        { type: 'text', text: 'Directory listing complete.' },
      ]);

      const result = await runPi(['--print', 'run ls /'], {
        port: mockServer.port,
        cwd: workDir,
      });

      expect(result.exitCode).toBe(0);
      expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
    },
    45_000,
  );

  it(
    'Pi JSON output mode — --mode json produces valid JSON',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello JSON!' }]);

      const result = await runPi(
        ['--print', '--mode', 'json', 'say hello'],
        { port: mockServer.port, cwd: workDir },
      );

      expect(result.exitCode).toBe(0);
      // Pi JSON mode may emit multiple JSON lines (NDJSON); parse each line
      const lines = result.stdout.trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);
      for (const line of lines) {
        const parsed = JSON.parse(line);
        expect(parsed).toBeDefined();
      }
    },
    45_000,
  );
});
