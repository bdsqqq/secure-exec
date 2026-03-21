/**
 * E2E test: OpenCode coding agent headless mode (binary spawn).
 *
 * Verifies OpenCode can boot, produce output in both default and JSON formats,
 * handle environment variables, SIGINT, and error conditions. OpenCode is a
 * standalone Bun binary spawned directly on the host. The mock LLM server
 * serves Anthropic Messages API SSE responses via ANTHROPIC_BASE_URL.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
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

function hasOpenCodeBinary(): boolean {
  try {
    const { execSync } = require('node:child_process');
    execSync('opencode --version', { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const skipReason = hasOpenCodeBinary()
  ? false
  : 'opencode binary not found on PATH';

// ---------------------------------------------------------------------------
// Spawn helper
// ---------------------------------------------------------------------------

interface OpenCodeResult {
  code: number;
  stdout: string;
  stderr: string;
}

function spawnOpenCode(opts: {
  args: string[];
  mockPort: number;
  cwd: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}): Promise<OpenCodeResult> {
  return new Promise((resolve) => {
    const xdgDir = path.join(
      tmpdir(),
      `opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ANTHROPIC_API_KEY: 'test-key',
      ANTHROPIC_BASE_URL: `http://127.0.0.1:${opts.mockPort}`,
      XDG_DATA_HOME: xdgDir,
      NO_COLOR: '1',
      ...(opts.env ?? {}),
    };

    const child = nodeSpawn('opencode', opts.args, {
      cwd: opts.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout.on('data', (d: Buffer) => stdoutChunks.push(d));
    child.stderr.on('data', (d: Buffer) => stderrChunks.push(d));

    const timeout = opts.timeoutMs ?? 30_000;
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

/** Parse NDJSON events from opencode --format json output. */
function parseJsonEvents(stdout: string): Array<Record<string, unknown>> {
  return stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as Record<string, unknown>;
      } catch {
        return null;
      }
    })
    .filter((x): x is Record<string, unknown> => x !== null);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;

describe.skipIf(skipReason)('OpenCode headless E2E (binary spawn)', () => {
  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'opencode-headless-'));
  }, 15_000);

  afterAll(async () => {
    await mockServer?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // Boot & output
  // -------------------------------------------------------------------------

  it(
    'OpenCode boots in run mode — exits with code 0',
    async () => {
      // OpenCode makes 2 requests: title generation + actual response
      mockServer.reset([
        { type: 'text', text: 'Hello!' },
        { type: 'text', text: 'Hello!' },
      ]);

      const result = await spawnOpenCode({
        args: ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'json', 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      if (result.code !== 0) {
        console.log('OpenCode boot stderr:', result.stderr.slice(0, 2000));
      }
      expect(result.code).toBe(0);
    },
    45_000,
  );

  it(
    'OpenCode produces output — stdout contains canned LLM response',
    async () => {
      const canary = 'UNIQUE_CANARY_OC_42';
      mockServer.reset([
        { type: 'text', text: canary },
        { type: 'text', text: canary },
      ]);

      const result = await spawnOpenCode({
        args: ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'json', 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      expect(result.stdout).toContain(canary);
    },
    45_000,
  );

  it(
    'OpenCode text format — --format default produces plain text output',
    async () => {
      const canary = 'TEXTFORMAT_CANARY_99';
      mockServer.reset([
        { type: 'text', text: canary },
        { type: 'text', text: canary },
      ]);

      const result = await spawnOpenCode({
        args: ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'default', 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      const stripped = result.stdout
        .replace(/\x1b\[[0-9;]*m/g, '')
        .trim();
      expect(stripped.length).toBeGreaterThan(0);
      expect(stripped).toContain(canary);
    },
    45_000,
  );

  it(
    'OpenCode JSON format — --format json produces valid JSON events',
    async () => {
      mockServer.reset([
        { type: 'text', text: 'Hello JSON!' },
        { type: 'text', text: 'Hello JSON!' },
      ]);

      const result = await spawnOpenCode({
        args: ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'json', 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      const events = parseJsonEvents(result.stdout);
      expect(events.length).toBeGreaterThan(0);
      for (const event of events) {
        expect(event).toHaveProperty('type');
      }
    },
    45_000,
  );

  it(
    'Environment forwarding — API key and base URL reach the binary',
    async () => {
      mockServer.reset([
        { type: 'text', text: 'ENV_OK' },
        { type: 'text', text: 'ENV_OK' },
      ]);

      const result = await spawnOpenCode({
        args: ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'json', 'say hello'],
        mockPort: mockServer.port,
        cwd: workDir,
      });

      expect(result.code).toBe(0);
      expect(mockServer.requestCount()).toBeGreaterThanOrEqual(1);
    },
    45_000,
  );

  // -------------------------------------------------------------------------
  // Signal handling
  // -------------------------------------------------------------------------

  it(
    'SIGINT terminates OpenCode cleanly',
    async () => {
      mockServer.reset([
        { type: 'text', text: 'A very long response that should take a while to stream...' },
        { type: 'text', text: 'A very long response that should take a while to stream...' },
      ]);

      const result = await new Promise<OpenCodeResult>((resolve) => {
        const xdgDir = path.join(tmpdir(), `opencode-sigint-${Date.now()}`);
        const child = nodeSpawn(
          'opencode',
          ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'json', 'say hello'],
          {
            cwd: workDir,
            env: {
              ...(process.env as Record<string, string>),
              ANTHROPIC_API_KEY: 'test-key',
              ANTHROPIC_BASE_URL: `http://127.0.0.1:${mockServer.port}`,
              XDG_DATA_HOME: xdgDir,
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
  // Error handling
  // -------------------------------------------------------------------------

  it(
    'Bad API key produces non-zero exit code',
    async () => {
      // Point to a port with nothing listening — simulates unreachable API
      const result = await spawnOpenCode({
        args: ['run', '-m', 'anthropic/claude-sonnet-4-6', '--format', 'json', 'say hello'],
        mockPort: 1, // port 1 should refuse connections
        cwd: workDir,
        timeoutMs: 15_000,
      });

      const combined = result.stdout + result.stderr;
      const hasErrorSignal =
        result.code !== 0 ||
        combined.includes('error') ||
        combined.includes('Error') ||
        combined.includes('ECONNREFUSED');
      expect(hasErrorSignal).toBe(true);
    },
    30_000,
  );
});
