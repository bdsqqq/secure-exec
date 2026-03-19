/**
 * E2E test: OpenCode coding agent interactive TUI through a real PTY.
 *
 * Spawns OpenCode as a host process inside a PTY (via Linux `script -qefc`)
 * so that process.stdout.isTTY is true and OpenCode renders its full OpenTUI
 * interface. Output is fed into @xterm/headless for deterministic screen-state
 * assertions.
 *
 * OpenCode is a standalone Bun binary — uses ANTHROPIC_BASE_URL to redirect
 * API calls to a mock LLM server. Some opencode versions hang with BASE_URL
 * redirects from temp dirs, so the test probes redirect viability first and
 * skips API-dependent tests if it fails.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Terminal } from '@xterm/headless';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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
// Mock server redirect probe
// ---------------------------------------------------------------------------

/**
 * Probe whether ANTHROPIC_BASE_URL redirects work for interactive mode.
 * Runs a quick headless `opencode run` to verify the mock server is reachable.
 */
async function probeBaseUrlRedirect(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(
      'opencode',
      ['run', '-m', 'anthropic/claude-sonnet-4-5', '--format', 'json', 'say ok'],
      {
        env: {
          PATH: process.env.PATH ?? '',
          HOME: process.env.HOME ?? tmpdir(),
          ANTHROPIC_API_KEY: 'probe-key',
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${port}`,
          XDG_DATA_HOME: path.join(tmpdir(), `opencode-probe-${Date.now()}`),
        },
        cwd: process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );

    child.stdin.end();

    const timer = setTimeout(() => {
      child.kill();
      resolve(false);
    }, 20_000);

    child.on('close', (code) => {
      clearTimeout(timer);
      resolve(code === 0);
    });
  });
}

// ---------------------------------------------------------------------------
// PtyHarness — host process with real PTY + xterm headless
// ---------------------------------------------------------------------------

/** Settlement window: resolve type() after this many ms of no new output. */
const SETTLE_MS = 150;
/** Poll interval for waitFor(). */
const POLL_MS = 50;
/** Default waitFor() timeout. */
const DEFAULT_WAIT_TIMEOUT_MS = 20_000;

/**
 * OpenCode enables kitty keyboard protocol — raw `\r` is treated as newline,
 * not as an Enter key press. Submit requires CSI u-encoded Enter: `\x1b[13u`.
 */
const KITTY_ENTER = '\x1b[13u';

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

    this.child = spawn('script', ['-qefc', fullCmd, '/dev/null'], {
      env: {
        ...options.env,
        TERM: 'xterm-256color',
        COLUMNS: String(cols),
        LINES: String(rows),
      },
      cwd: options.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    // Wire PTY output → xterm
    this.child.stdout!.on('data', (data: Buffer) => {
      this.term.write(data);
    });
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
          if (dataListener)
            this.child.stdout!.removeListener('data', dataListener);
          resolve();
        }, SETTLE_MS);
      };

      dataListener = (_data: Buffer) => {
        resetTimer();
      };
      this.child.stdout!.on('data', dataListener);

      resetTimer();
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

      let count = 0;
      let idx = -1;
      while (true) {
        idx = screen.indexOf(text, idx + 1);
        if (idx === -1) break;
        count++;
        if (count >= occurrence) return;
      }

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

/** Create a PtyHarness that spawns OpenCode in interactive TUI mode. */
function createOpenCodeHarness(opts: {
  mockPort?: number;
  cwd: string;
  extraArgs?: string[];
}): PtyHarness {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    XDG_DATA_HOME: path.join(tmpdir(), `opencode-interactive-${Date.now()}`),
  };

  if (opts.mockPort) {
    env.ANTHROPIC_API_KEY = 'test-key';
    env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${opts.mockPort}`;
  }

  return new PtyHarness(
    'opencode',
    [
      '-m',
      'anthropic/claude-sonnet-4-5',
      ...(opts.extraArgs ?? []),
      '.',
    ],
    {
      env,
      cwd: opts.cwd,
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;
let mockRedirectWorks: boolean;

describe.skipIf(skipReason)('OpenCode interactive PTY E2E', () => {
  let harness: PtyHarness;

  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);

    // Probe mock redirect before running API-dependent tests
    mockServer.reset([
      { type: 'text', text: 'PROBE_OK' },
      { type: 'text', text: 'PROBE_OK' },
    ]);
    mockRedirectWorks = await probeBaseUrlRedirect(mockServer.port);

    workDir = await mkdtemp(path.join(tmpdir(), 'opencode-interactive-'));
  }, 30_000);

  afterEach(async () => {
    await harness?.dispose();
  });

  afterAll(async () => {
    await mockServer?.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it(
    'OpenCode TUI renders — screen shows OpenTUI interface after boot',
    async () => {
      mockServer.reset([]);

      harness = createOpenCodeHarness({
        mockPort: mockRedirectWorks ? mockServer.port : undefined,
        cwd: workDir,
      });

      // OpenCode TUI shows "Ask anything" placeholder in the input area
      await harness.waitFor('Ask anything', 1, 30_000);

      const screen = harness.screenshotTrimmed();
      // Verify TUI elements: input placeholder, keyboard hints
      expect(screen).toContain('Ask anything');
      // Status bar has keyboard shortcut hints
      expect(screen).toMatch(/ctrl\+[a-z]/i);
    },
    45_000,
  );

  it(
    'input area works — type prompt text, appears in input area',
    async () => {
      mockServer.reset([
        { type: 'text', text: 'placeholder' },
        { type: 'text', text: 'placeholder' },
      ]);

      harness = createOpenCodeHarness({
        mockPort: mockRedirectWorks ? mockServer.port : undefined,
        cwd: workDir,
      });

      // Wait for TUI to boot
      await harness.waitFor('Ask anything', 1, 30_000);

      // Type text into the input area
      await harness.type('hello opencode world');

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('hello opencode world');
    },
    45_000,
  );

  it(
    'submit shows response — enter prompt, streaming response renders on screen',
    async (ctx) => {
      if (!mockRedirectWorks) {
        ctx.skip();
        return;
      }

      const canary = 'INTERACTIVE_OC_CANARY_42';
      // Pad queue: title request + main response (+ extras for safety)
      mockServer.reset([
        { type: 'text', text: 'title' },
        { type: 'text', text: canary },
        { type: 'text', text: canary },
        { type: 'text', text: canary },
      ]);

      harness = createOpenCodeHarness({
        mockPort: mockServer.port,
        cwd: workDir,
      });

      // Wait for TUI to boot
      await harness.waitFor('Ask anything', 1, 30_000);

      // Type prompt and submit with kitty-encoded Enter
      await harness.type('say the magic word');
      await harness.type(KITTY_ENTER);

      // Wait for mock LLM response to render on screen
      await harness.waitFor(canary, 1, 30_000);

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain(canary);
    },
    60_000,
  );

  it(
    '^C interrupts — send SIGINT on idle TUI, OpenCode stays alive',
    async () => {
      mockServer.reset([
        { type: 'text', text: 'placeholder' },
        { type: 'text', text: 'placeholder' },
      ]);

      harness = createOpenCodeHarness({
        mockPort: mockRedirectWorks ? mockServer.port : undefined,
        cwd: workDir,
      });

      // Wait for TUI to boot
      await harness.waitFor('Ask anything', 1, 30_000);

      // Type text into input (OpenCode treats ^C on non-empty input as clear)
      await harness.type('some draft text');
      await harness.waitFor('some draft text', 1, 5_000);

      // Send ^C — should clear input, not exit
      await harness.type('\x03');

      // Wait for the placeholder to reappear (input was cleared)
      await harness.waitFor('Ask anything', 1, 15_000);

      // Verify OpenCode is still alive by typing more text
      await harness.type('still alive');
      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('still alive');
    },
    60_000,
  );

  it(
    'exit cleanly — Ctrl+C twice, OpenCode exits and PTY closes',
    async () => {
      mockServer.reset([]);

      harness = createOpenCodeHarness({
        mockPort: mockRedirectWorks ? mockServer.port : undefined,
        cwd: workDir,
      });

      // Wait for TUI to boot
      await harness.waitFor('Ask anything', 1, 30_000);

      // Send ^C twice to exit (common TUI pattern: first ^C cancels, second exits)
      await harness.type('\x03');
      await new Promise((r) => setTimeout(r, 300));
      await harness.type('\x03');

      // Wait for process to exit
      const exitCode = await Promise.race([
        harness.wait(),
        new Promise<number>((_, reject) =>
          setTimeout(
            () => reject(new Error('OpenCode did not exit within 15s')),
            15_000,
          ),
        ),
      ]);

      // OpenCode should exit cleanly (0 or 130 for SIGINT)
      expect([0, 130]).toContain(exitCode);
    },
    45_000,
  );
});
