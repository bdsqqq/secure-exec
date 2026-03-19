/**
 * E2E test: Pi coding agent interactive TUI through a real PTY.
 *
 * Spawns Pi as a host process inside a PTY (via Linux `script -qefc`) so that
 * process.stdout.isTTY is true and Pi renders its full TUI. Output is fed into
 * @xterm/headless for deterministic screen-state assertions.
 *
 * Pi is ESM-only and cannot run inside the CJS-only V8 isolate bridge; it runs
 * as a host process with a fetch interceptor redirecting API calls to a mock
 * LLM server.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Terminal } from '@xterm/headless';
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
// PtyHarness — host process with real PTY + xterm headless
// ---------------------------------------------------------------------------

/** Settlement window: resolve type() after this many ms of no new output. */
const SETTLE_MS = 100;
/** Poll interval for waitFor(). */
const POLL_MS = 50;
/** Default waitFor() timeout. */
const DEFAULT_WAIT_TIMEOUT_MS = 15_000;

/**
 * Wraps a host process in a real PTY via Linux `script -qefc` and wires
 * output to an @xterm/headless Terminal for screen-state assertions.
 */
class PtyHarness {
  readonly term: Terminal;
  private child: ChildProcess;
  private disposed = false;
  private typing = false;
  private exitCode: number | null = null;
  private exitPromise: Promise<number>;

  constructor(
    command: string,
    args: string[],
    options: {
      env: Record<string, string>;
      cwd: string;
      cols?: number;
      rows?: number;
    },
  ) {
    const cols = options.cols ?? 80;
    const rows = options.rows ?? 24;

    this.term = new Terminal({ cols, rows, allowProposedApi: true });

    // Build the full command string for script -c
    const fullCmd = [command, ...args]
      .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
      .join(' ');

    this.child = spawn(
      'script',
      ['-qefc', fullCmd, '/dev/null'],
      {
        env: {
          ...options.env,
          TERM: 'xterm-256color',
          COLUMNS: String(cols),
          LINES: String(rows),
        },
        cwd: options.cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    // Wire PTY output → xterm
    this.child.stdout!.on('data', (data: Buffer) => {
      this.term.write(data);
    });
    // Merge stderr into the terminal (PTY normally merges both)
    this.child.stderr!.on('data', (data: Buffer) => {
      this.term.write(data);
    });

    this.exitPromise = new Promise<number>((resolve) => {
      this.child.on('close', (code) => {
        this.exitCode = code ?? 1;
        resolve(this.exitCode);
      });
    });
  }

  /** Send input through the PTY stdin. Resolves after output settles. */
  async type(input: string): Promise<void> {
    if (this.typing) {
      throw new Error(
        'PtyHarness.type() called while previous type() is still in-flight',
      );
    }
    this.typing = true;
    try {
      await this.typeInternal(input);
    } finally {
      this.typing = false;
    }
  }

  private typeInternal(input: string): Promise<void> {
    return new Promise<void>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null;
      let dataListener: ((data: Buffer) => void) | null = null;

      const resetTimer = () => {
        if (timer !== null) clearTimeout(timer);
        timer = setTimeout(() => {
          // Unhook and resolve
          if (dataListener) this.child.stdout!.removeListener('data', dataListener);
          resolve();
        }, SETTLE_MS);
      };

      // Listen for new output to reset settlement timer
      dataListener = (_data: Buffer) => {
        resetTimer();
      };
      this.child.stdout!.on('data', dataListener);

      // Start settlement timer before writing
      resetTimer();

      // Write input to PTY
      this.child.stdin!.write(input);
    });
  }

  /**
   * Full screen as a string: viewport rows only, trailing whitespace
   * trimmed per line, trailing empty lines dropped, joined with '\n'.
   */
  screenshotTrimmed(): string {
    const buf = this.term.buffer.active;
    const rows = this.term.rows;
    const lines: string[] = [];

    for (let y = 0; y < rows; y++) {
      const line = buf.getLine(buf.viewportY + y);
      lines.push(line ? line.translateToString(true) : '');
    }

    // Drop trailing empty lines
    while (lines.length > 0 && lines[lines.length - 1] === '') {
      lines.pop();
    }

    return lines.join('\n');
  }

  /** Single trimmed row from the screen buffer (0-indexed). */
  line(row: number): string {
    const buf = this.term.buffer.active;
    const line = buf.getLine(buf.viewportY + row);
    return line ? line.translateToString(true) : '';
  }

  /**
   * Poll screen buffer every POLL_MS until `text` is found.
   * Throws a descriptive error on timeout with expected text and actual
   * screen content.
   */
  async waitFor(
    text: string,
    occurrence: number = 1,
    timeoutMs: number = DEFAULT_WAIT_TIMEOUT_MS,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;

    while (true) {
      const screen = this.screenshotTrimmed();

      // Count occurrences
      let count = 0;
      let idx = -1;
      while (true) {
        idx = screen.indexOf(text, idx + 1);
        if (idx === -1) break;
        count++;
        if (count >= occurrence) return;
      }

      // Check if process has exited
      if (this.exitCode !== null) {
        throw new Error(
          `waitFor("${text}") failed: process exited with code ${this.exitCode} before text appeared.\n` +
            `Screen:\n${screen}`,
        );
      }

      if (Date.now() >= deadline) {
        throw new Error(
          `waitFor("${text}", ${occurrence}) timed out after ${timeoutMs}ms.\n` +
            `Expected: "${text}" (occurrence ${occurrence})\n` +
            `Screen:\n${screen}`,
        );
      }

      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  /** Wait for the process to exit. Returns exit code. */
  async wait(): Promise<number> {
    return this.exitPromise;
  }

  /** Kill process and dispose terminal. Safe to call multiple times. */
  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;

    try {
      if (this.exitCode === null) {
        this.child.kill('SIGTERM');
        // Wait briefly, escalate to SIGKILL
        const exited = await Promise.race([
          this.exitPromise.then(() => true),
          new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
        ]);
        if (!exited) {
          this.child.kill('SIGKILL');
          await Promise.race([
            this.exitPromise,
            new Promise((r) => setTimeout(r, 500)),
          ]);
        }
      }
    } catch {
      // Process may already be dead
    }

    this.term.dispose();
  }
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/** Create a PtyHarness that spawns Pi in interactive mode with a PTY. */
function createPiHarness(opts: {
  port: number;
  cwd: string;
  extraArgs?: string[];
}): PtyHarness {
  return new PtyHarness(
    process.execPath,
    [
      PI_CLI,
      ...PI_BASE_FLAGS,
      '--provider',
      'anthropic',
      '--model',
      'claude-sonnet-4-20250514',
      ...(opts.extraArgs ?? []),
    ],
    {
      env: {
        PATH: process.env.PATH ?? '',
        HOME: opts.cwd,
        ANTHROPIC_API_KEY: 'test-key',
        MOCK_LLM_URL: `http://127.0.0.1:${opts.port}`,
        NODE_OPTIONS: `-r ${FETCH_INTERCEPT}`,
      },
      cwd: opts.cwd,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;

describe.skipIf(piSkip)('Pi interactive PTY E2E', () => {
  let harness: PtyHarness;

  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'pi-interactive-'));
  });

  afterEach(async () => {
    await harness?.dispose();
  });

  afterAll(async () => {
    await mockServer?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it(
    'Pi TUI renders — screen shows Pi prompt/editor UI after boot',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello!' }]);

      harness = createPiHarness({ port: mockServer.port, cwd: workDir });

      // Pi TUI shows separator lines and a model status bar on boot
      await harness.waitFor('claude-sonnet', 1, 30_000);

      const screen = harness.screenshotTrimmed();
      // Verify TUI elements: separator lines, model indicator
      expect(screen).toContain('────');
      expect(screen).toContain('claude-sonnet');
    },
    45_000,
  );

  it(
    'input appears on screen — type text, text appears in editor area',
    async () => {
      mockServer.reset([{ type: 'text', text: 'Hello!' }]);

      harness = createPiHarness({ port: mockServer.port, cwd: workDir });

      // Wait for TUI to boot
      await harness.waitFor('claude-sonnet', 1, 30_000);

      // Type text into the editor area
      await harness.type('hello world');

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('hello world');
    },
    45_000,
  );

  it(
    'submit prompt renders response — type prompt + Enter, LLM response renders',
    async () => {
      const canary = 'INTERACTIVE_CANARY_99';
      mockServer.reset([{ type: 'text', text: canary }]);

      harness = createPiHarness({ port: mockServer.port, cwd: workDir });

      // Wait for TUI to boot
      await harness.waitFor('claude-sonnet', 1, 30_000);

      // Type a prompt and submit with Enter (\r = CR = Enter key in PTY)
      await harness.type('say hello\r');

      // Wait for the canned LLM response to appear on screen
      await harness.waitFor(canary, 1, 30_000);

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain(canary);
    },
    60_000,
  );

  it(
    '^C interrupts — send SIGINT during response, Pi stays alive',
    async () => {
      // Queue a response — Pi should handle ^C gracefully
      mockServer.reset([
        { type: 'text', text: 'First response' },
        { type: 'text', text: 'Second response' },
      ]);

      harness = createPiHarness({ port: mockServer.port, cwd: workDir });

      // Wait for TUI to boot
      await harness.waitFor('claude-sonnet', 1, 30_000);

      // Submit a prompt (CR = Enter in PTY)
      await harness.type('say hello\r');

      // Give Pi a moment to start processing, then send ^C
      await new Promise((r) => setTimeout(r, 500));
      await harness.type('\x03');

      // Pi should survive single ^C — wait for TUI to settle
      // The editor area and status bar should still render
      await harness.waitFor('claude-sonnet', 1, 15_000);

      // Verify Pi is still alive by typing more text
      await harness.type('still alive');
      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('still alive');
    },
    60_000,
  );

  it(
    'exit cleanly — ^D on empty editor, Pi exits and PTY closes',
    async () => {
      mockServer.reset([]);

      harness = createPiHarness({ port: mockServer.port, cwd: workDir });

      // Wait for TUI to boot
      await harness.waitFor('claude-sonnet', 1, 30_000);

      // Send ^D (ctrl+d) to exit on empty editor
      await harness.type('\x04');

      // Wait for process to exit
      const exitCode = await Promise.race([
        harness.wait(),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('Pi did not exit within 10s')), 10_000),
        ),
      ]);

      expect(exitCode).toBe(0);
    },
    45_000,
  );
});
