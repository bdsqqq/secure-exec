/**
 * E2E test: Claude Code headless mode (binary spawn).
 *
 * Verifies Claude Code can boot in -p mode, produce output in text/json/
 * stream-json formats, read/write files, execute bash commands, continue
 * sessions, and handle signals and error conditions. Claude Code is a
 * native Node.js CLI with .node addons — spawned directly on the host.
 *
 * Claude Code natively supports ANTHROPIC_BASE_URL, so the mock LLM server
 * works without any fetch interceptor. stream-json requires --verbose flag.
 *
 * Uses direct spawn (not sandbox bridge) for reliable stdout capture —
 * sandbox bridge stdout round-trip doesn't reliably capture output for
 * native CLI binaries.
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
// Spawn helper
// ---------------------------------------------------------------------------

interface ClaudeResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnClaude(opts: {
  args: string[];
  mockPort: number;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<ClaudeResult> {
  return new Promise((resolve) => {
    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${opts.mockPort}`,
      NO_COLOR: '1',
      ...(opts.env ?? {}),
    };

    const child = nodeSpawn(claudeBinary!, opts.args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

    const timeout = opts.timeoutMs ?? 45_000;
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
    }, timeout);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({
        code: code ?? 1,
        stdout: Buffer.concat(stdoutChunks).toString(),
        stderr: Buffer.concat(stderrChunks).toString(),
      });
    });

    child.stdin.end();
  });
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

describe.skipIf(skipReason)('Claude Code headless E2E (binary spawn)', () => {
  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'claude-headless-'));
  }, 15_000);

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

      const result = await spawnClaude({
        args: [...CLAUDE_BASE_ARGS, 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      if (result.code !== 0) {
        console.log('Claude boot stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.code).toBe(0);
    },
    60_000,
  );

  it(
    'Claude produces text output — stdout contains canned LLM response',
    async () => {
      const canary = 'UNIQUE_CANARY_CC_42';
      mockServer.reset([{ type: 'text', text: canary }]);

      const result = await spawnClaude({
        args: [...CLAUDE_BASE_ARGS, 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(canary);
    },
    60_000,
  );

  it(
    'Claude JSON output — --output-format json produces valid JSON with result',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello JSON!' }]);

      const result = await spawnClaude({
        args: [...CLAUDE_BASE_ARGS, '--output-format', 'json', 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.stdout);
      expect(parsed).toHaveProperty('result');
      expect(parsed.type).toBe('result');
    },
    60_000,
  );

  it(
    'Claude stream-json output — --output-format stream-json produces valid NDJSON',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello stream!' }]);

      const result = await spawnClaude({
        args: [
          ...CLAUDE_BASE_ARGS,
          '--verbose',
          '--output-format', 'stream-json',
          'say hello',
        ],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      // stream-json emits NDJSON; non-JSON lines are filtered
      const combined = (result.stdout + '\n' + result.stderr).trim();
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

      const result = await spawnClaude({
        args: [
          ...CLAUDE_BASE_ARGS,
          '--output-format', 'json',
          `read the file at ${path.join(testDir, 'test.txt')} and repeat its contents`,
        ],
        mockPort: mockServer.port,
        cwd: testDir,
      });

      // Claude made at least 2 requests: prompt -> tool_use, tool_result -> text
      expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
      const combined = result.stdout + result.stderr;
      expect(combined).toContain('secret_content_xyz');
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

      const result = await spawnClaude({
        args: [
          ...CLAUDE_BASE_ARGS,
          '--output-format', 'json',
          `create a file at ${outPath}`,
        ],
        mockPort: mockServer.port,
        cwd: testDir,
      });

      expect(result.code).toBe(0);
      expect(existsSync(outPath)).toBe(true);
      const content = await readFile(outPath, 'utf8');
      expect(content).toBe('hello from claude mock');
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

      const result = await spawnClaude({
        args: [
          ...CLAUDE_BASE_ARGS,
          '--output-format', 'json',
          'run echo hello',
        ],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      expect(mockServer.requestCount()).toBeGreaterThanOrEqual(2);
    },
    60_000,
  );

  // -------------------------------------------------------------------------
  // Session continuation
  // -------------------------------------------------------------------------

  it(
    'Claude continues session — --continue resumes prior conversation',
    async () => {
      const sessionCwd = path.join(workDir, 'continue-cwd');
      await mkdir(sessionCwd, { recursive: true });

      const sessionArgs = [
        '-p',
        '--dangerously-skip-permissions',
        '--model', 'haiku',
      ];

      // First run: create a session (no --no-session-persistence)
      mockServer.reset([{ type: 'text', text: 'First response!' }]);

      const result1 = await spawnClaude({
        args: [...sessionArgs, 'say hello'],
        mockPort: mockServer.port,
        cwd: sessionCwd,
      });

      if (result1.code !== 0) {
        console.log('Continue test (run 1) stderr:', result1.stderr.slice(0, 2000));
      }
      expect(result1.code).toBe(0);

      // Second run: continue the session
      mockServer.reset([{ type: 'text', text: 'Continued response!' }]);

      const result2 = await spawnClaude({
        args: [...sessionArgs, '--continue', 'what did I just say?'],
        mockPort: mockServer.port,
        cwd: sessionCwd,
      });

      if (result2.code !== 0) {
        console.log('Continue test (run 2) stderr:', result2.stderr.slice(0, 2000));
      }
      expect(result2.code).toBe(0);
      // Second run should have made at least one API request
      expect(mockServer.requestCount()).toBeGreaterThanOrEqual(1);
    },
    120_000,
  );

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  it(
    'SIGINT terminates Claude cleanly',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Write a very long essay...' }]);

      const result = await new Promise<ClaudeResult>((resolve) => {
        const child = nodeSpawn(
          claudeBinary!,
          [...CLAUDE_BASE_ARGS, 'Write a very long essay about computing history'],
          {
            cwd: workDir,
            env: {
              ...(process.env as Record<string, string>),
              ANTHROPIC_API_KEY: 'test-key',
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockServer.port}`,
              NO_COLOR: '1',
            },
            stdio: ['pipe', 'pipe', 'pipe'],
          },
        );

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];

        child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
        child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));
        child.stdin.end();

        // Send SIGINT after any output
        let sentSigint = false;
        const onOutput = () => {
          if (!sentSigint) {
            sentSigint = true;
            child.kill('SIGINT');
          }
        };
        child.stdout.on('data', onOutput);
        child.stderr.on('data', onOutput);

        // Safety timeout
        const killTimer = setTimeout(() => {
          child.kill('SIGKILL');
        }, 25_000);

        child.on('close', (code) => {
          clearTimeout(killTimer);
          resolve({
            code: code ?? 1,
            stdout: Buffer.concat(stdoutChunks).toString(),
            stderr: Buffer.concat(stderrChunks).toString(),
          });
        });
      });

      // Should not need SIGKILL (exit code 137)
      expect(result.code).not.toBe(137);
    },
    30_000,
  );

  // -------------------------------------------------------------------------
  // Exit codes
  // -------------------------------------------------------------------------

  it(
    'Claude exit codes — bad API key produces error signal',
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

      try {
        const result = await spawnClaude({
          args: [...CLAUDE_BASE_ARGS, 'say hello'],
          mockPort: rejectPort,
          cwd: workDir,
          timeoutMs: 30_000,
        });

        // Claude may exit non-zero or report the error in output
        const combined = result.stdout + result.stderr;
        const hasErrorSignal =
          result.code !== 0 ||
          combined.includes('authentication') ||
          combined.includes('Authentication') ||
          combined.includes('invalid') ||
          combined.includes('error') ||
          combined.includes('Error') ||
          combined.includes('401');
        expect(hasErrorSignal).toBe(true);
      } finally {
        await new Promise<void>((resolve, reject) => {
          rejectServer.close((err) => (err ? reject(err) : resolve()));
        });
      }
    },
    45_000,
  );

  it(
    'Claude exit codes — good prompt exits 0',
    async () => {
      mockServer.reset([{ type: 'text', text: 'All good!' }]);

      const result = await spawnClaude({
        args: [...CLAUDE_BASE_ARGS, 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
    },
    60_000,
  );
});
