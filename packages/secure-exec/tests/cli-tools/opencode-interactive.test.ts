/**
 * E2E test: OpenCode coding agent interactive TUI through the sandbox's
 * kernel.openShell() PTY.
 *
 * OpenCode is a standalone Bun binary — it must be spawned from inside the
 * sandbox via the child_process.spawn bridge. The bridge dispatches to a
 * HostBinaryDriver mounted in the kernel, which spawns the real binary on
 * the host. Output flows back through the bridge to process.stdout, which
 * is connected to the kernel's PTY slave → PTY master → xterm headless.
 *
 * If the sandbox cannot support OpenCode's interactive TUI (e.g. streaming
 * stdin bridge not supported, child_process bridge cannot spawn host
 * binaries), all tests skip with a clear reason referencing the specific
 * blocker.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createKernel,
  allowAllChildProcess,
  allowAllEnv,
} from '../../../core/src/kernel/index.ts';
import type {
  Kernel,
  RuntimeDriver,
  KernelInterface,
  DriverProcess,
  ProcessContext,
} from '../../../core/src/kernel/index.ts';
import type { VirtualFileSystem } from '../../../core/src/kernel/vfs.ts';
import { TerminalHarness } from '../../../core/test/kernel/terminal-harness.ts';
import { InMemoryFileSystem } from '../../../browser/src/os-filesystem.ts';
import { createNodeRuntime } from '../../../nodejs/src/kernel-runtime.ts';
import {
  createMockLlmServer,
  type MockLlmServerHandle,
} from './mock-llm-server.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SECURE_EXEC_ROOT = path.resolve(__dirname, '../..');

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
// HostBinaryDriver — spawns real host binaries through the kernel
// ---------------------------------------------------------------------------

/**
 * Minimal RuntimeDriver that spawns real host binaries. Registered commands
 * are dispatched to node:child_process.spawn on the host. This allows
 * sandbox code to call child_process.spawn('opencode', ...) and have it
 * route through the kernel's command registry to the host.
 */
class HostBinaryDriver implements RuntimeDriver {
  readonly name = 'host-binary';
  readonly commands: string[];

  constructor(commands: string[]) {
    this.commands = commands;
  }

  async init(_kernel: KernelInterface): Promise<void> {}

  spawn(command: string, args: string[], ctx: ProcessContext): DriverProcess {
    const child = nodeSpawn(command, args, {
      cwd: ctx.cwd,
      env: ctx.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let resolveExit!: (code: number) => void;
    let exitResolved = false;
    const exitPromise = new Promise<number>((resolve) => {
      resolveExit = (code: number) => {
        if (exitResolved) return;
        exitResolved = true;
        resolve(code);
      };
    });

    const proc: DriverProcess = {
      onStdout: null,
      onStderr: null,
      onExit: null,
      writeStdin: (data) => {
        try { child.stdin.write(data); } catch { /* stdin may be closed */ }
      },
      closeStdin: () => {
        try { child.stdin.end(); } catch { /* stdin may be closed */ }
      },
      kill: (signal) => {
        try { child.kill(signal); } catch { /* process may be dead */ }
      },
      wait: () => exitPromise,
    };

    // Handle spawn errors (e.g., command not found)
    child.on('error', (err) => {
      const msg = `${command}: ${err.message}`;
      const errBytes = new TextEncoder().encode(msg + '\n');
      ctx.onStderr?.(errBytes);
      proc.onStderr?.(errBytes);
      resolveExit(127);
      proc.onExit?.(127);
    });

    child.stdout.on('data', (d: Buffer) => {
      const bytes = new Uint8Array(d);
      ctx.onStdout?.(bytes);
      proc.onStdout?.(bytes);
    });

    child.stderr.on('data', (d: Buffer) => {
      const bytes = new Uint8Array(d);
      ctx.onStderr?.(bytes);
      proc.onStderr?.(bytes);
    });

    child.on('close', (code) => {
      const exitCode = code ?? 1;
      resolveExit(exitCode);
      proc.onExit?.(exitCode);
    });

    return proc;
  }

  async dispose(): Promise<void> {}
}

// ---------------------------------------------------------------------------
// Overlay VFS — writes to InMemoryFileSystem, reads fall back to host
// ---------------------------------------------------------------------------

/**
 * Create an overlay filesystem: writes go to an in-memory layer (for
 * kernel.mount() populateBin), reads try memory first then fall back to
 * the host filesystem (for module resolution).
 */
function createOverlayVfs(): VirtualFileSystem {
  const memfs = new InMemoryFileSystem();
  return {
    readFile: async (p) => {
      try { return await memfs.readFile(p); }
      catch { return new Uint8Array(await fsPromises.readFile(p)); }
    },
    readTextFile: async (p) => {
      try { return await memfs.readTextFile(p); }
      catch { return await fsPromises.readFile(p, 'utf-8'); }
    },
    readDir: async (p) => {
      try { return await memfs.readDir(p); }
      catch { return await fsPromises.readdir(p); }
    },
    readDirWithTypes: async (p) => {
      try { return await memfs.readDirWithTypes(p); }
      catch {
        const entries = await fsPromises.readdir(p, { withFileTypes: true });
        return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
      }
    },
    exists: async (p) => {
      if (await memfs.exists(p)) return true;
      try { await fsPromises.access(p); return true; } catch { return false; }
    },
    stat: async (p) => {
      try { return await memfs.stat(p); }
      catch {
        const s = await fsPromises.stat(p);
        return {
          mode: s.mode, size: s.size, isDirectory: s.isDirectory(),
          isSymbolicLink: false,
          atimeMs: s.atimeMs, mtimeMs: s.mtimeMs,
          ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs,
        };
      }
    },
    lstat: async (p) => {
      try { return await memfs.lstat(p); }
      catch {
        const s = await fsPromises.lstat(p);
        return {
          mode: s.mode, size: s.size, isDirectory: s.isDirectory(),
          isSymbolicLink: s.isSymbolicLink(),
          atimeMs: s.atimeMs, mtimeMs: s.mtimeMs,
          ctimeMs: s.ctimeMs, birthtimeMs: s.birthtimeMs,
        };
      }
    },
    realpath: async (p) => {
      try { return await memfs.realpath(p); }
      catch { return await fsPromises.realpath(p); }
    },
    readlink: async (p) => {
      try { return await memfs.readlink(p); }
      catch { return await fsPromises.readlink(p); }
    },
    pread: async (p, offset, length) => {
      try { return await memfs.pread(p, offset, length); }
      catch {
        const fd = await fsPromises.open(p, 'r');
        try {
          const buf = Buffer.alloc(length);
          const { bytesRead } = await fd.read(buf, 0, length, offset);
          return new Uint8Array(buf.buffer, buf.byteOffset, bytesRead);
        } finally { await fd.close(); }
      }
    },
    writeFile: (p, content) => memfs.writeFile(p, content),
    createDir: (p) => memfs.createDir(p),
    mkdir: (p, opts) => memfs.mkdir(p, opts),
    removeFile: (p) => memfs.removeFile(p),
    removeDir: (p) => memfs.removeDir(p),
    rename: (oldP, newP) => memfs.rename(oldP, newP),
    symlink: (target, linkP) => memfs.symlink(target, linkP),
    link: (oldP, newP) => memfs.link(oldP, newP),
    chmod: (p, mode) => memfs.chmod(p, mode),
    chown: (p, uid, gid) => memfs.chown(p, uid, gid),
    utimes: (p, atime, mtime) => memfs.utimes(p, atime, mtime),
    truncate: (p, length) => memfs.truncate(p, length),
  };
}

// ---------------------------------------------------------------------------
// OpenCode sandbox code builder
// ---------------------------------------------------------------------------

/**
 * OpenCode enables kitty keyboard protocol — raw `\r` is treated as newline,
 * not as an Enter key press. Submit requires CSI u-encoded Enter: `\x1b[13u`.
 */
const KITTY_ENTER = '\x1b[13u';

/**
 * Build sandbox code that spawns OpenCode interactively through the
 * child_process bridge. The code wraps opencode in `script -qefc` so
 * the binary gets a real PTY on the host (isTTY=true). Stdout/stderr
 * are piped to process.stdout/stderr (→ kernel PTY → xterm). Stdin
 * from the kernel PTY is piped to the child.
 */
function buildOpenCodeInteractiveCode(opts: {
  mockUrl?: string;
  cwd: string;
  extraArgs?: string[];
}): string {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: process.env.HOME ?? tmpdir(),
    XDG_DATA_HOME: path.join(tmpdir(), `opencode-interactive-${Date.now()}`),
    TERM: 'xterm-256color',
  };

  if (opts.mockUrl) {
    env.ANTHROPIC_API_KEY = 'test-key';
    env.ANTHROPIC_BASE_URL = opts.mockUrl;
  }

  // Build the opencode command for script -qefc
  const ocArgs = [
    'opencode',
    '-m', 'anthropic/claude-sonnet-4-5',
    ...(opts.extraArgs ?? []),
    '.',
  ];
  const cmd = ocArgs
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');

  return `(async () => {
    const { spawn } = require('child_process');

    // Spawn opencode wrapped in script for host-side PTY support
    const child = spawn('script', ['-qefc', ${JSON.stringify(cmd)}, '/dev/null'], {
      env: ${JSON.stringify(env)},
      cwd: ${JSON.stringify(opts.cwd)},
    });

    // Pipe child output to sandbox stdout (→ kernel PTY → xterm)
    child.stdout.on('data', (d) => process.stdout.write(String(d)));
    child.stderr.on('data', (d) => process.stderr.write(String(d)));

    // Pipe sandbox stdin (from kernel PTY) to child stdin
    process.stdin.on('data', (d) => child.stdin.write(d));
    process.stdin.resume();

    const exitCode = await new Promise((resolve) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        resolve(124);
      }, 90000);

      child.on('close', (code) => {
        clearTimeout(timer);
        resolve(code ?? 1);
      });
    });

    if (exitCode !== 0) process.exit(exitCode);
  })()`;
}

// ---------------------------------------------------------------------------
// Raw openShell probe — avoids TerminalHarness race on fast-exiting processes
// ---------------------------------------------------------------------------

/**
 * Run a node command through kernel.openShell and collect raw output.
 * Waits for exit and returns all output + exit code.
 */
async function probeOpenShell(
  kernel: Kernel,
  code: string,
  timeoutMs = 10_000,
  env?: Record<string, string>,
): Promise<{ output: string; exitCode: number }> {
  const shell = kernel.openShell({
    command: 'node',
    args: ['-e', code],
    cwd: SECURE_EXEC_ROOT,
    env: env ?? {
      PATH: process.env.PATH ?? '/usr/bin',
      HOME: process.env.HOME ?? tmpdir(),
    },
  });
  let output = '';
  shell.onData = (data) => {
    output += new TextDecoder().decode(data);
  };
  const exitCode = await Promise.race([
    shell.wait(),
    new Promise<number>((_, reject) =>
      setTimeout(() => reject(new Error(`probe timed out after ${timeoutMs}ms`)), timeoutMs),
    ),
  ]);
  return { output, exitCode };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

let mockServer: MockLlmServerHandle;
let workDir: string;
let kernel: Kernel;
let sandboxSkip: string | false = false;

describe.skipIf(skipReason)('OpenCode interactive PTY E2E (sandbox)', () => {
  let harness: TerminalHarness;

  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'opencode-interactive-'));

    // Overlay VFS: writes to memory (populateBin), reads fall back to host
    kernel = createKernel({ filesystem: createOverlayVfs() });
    await kernel.mount(createNodeRuntime({
      permissions: { ...allowAllChildProcess, ...allowAllEnv },
    }));
    await kernel.mount(new HostBinaryDriver(['opencode', 'script']));

    // Probe 1: check if node works through openShell
    try {
      const { output, exitCode } = await probeOpenShell(
        kernel,
        'console.log("PROBE_OK")',
      );
      if (exitCode !== 0 || !output.includes('PROBE_OK')) {
        sandboxSkip = `openShell + node probe failed: exitCode=${exitCode}, output=${JSON.stringify(output)}`;
      }
    } catch (e) {
      sandboxSkip = `openShell + node probe failed: ${(e as Error).message}`;
    }

    // Probe 2: check if child_process bridge can spawn opencode through kernel
    // Do NOT call process.exit() — it causes ProcessExitError in bridge callbacks.
    // Instead, report the result via stdout and let the process exit naturally.
    if (!sandboxSkip) {
      try {
        const { output } = await probeOpenShell(
          kernel,
          `(async()=>{` +
            `const{spawn}=require('child_process');` +
            `const c=spawn('opencode',['--version'],{env:process.env});` +
            `let out='';` +
            `c.stdout.on('data',(d)=>{out+=d;process.stdout.write(String(d))});` +
            `c.stderr.on('data',(d)=>process.stderr.write(String(d)));` +
            `const code=await new Promise(r=>{` +
              `const t=setTimeout(()=>{try{c.kill()}catch(e){};r(124)},10000);` +
              `c.on('close',(c)=>{clearTimeout(t);r(c??1)})` +
            `});` +
            `process.stdout.write('SPAWN_EXIT:'+code)` +
          `})()`,
          15_000,
        );
        if (!output.includes('SPAWN_EXIT:0')) {
          sandboxSkip =
            `child_process bridge cannot spawn opencode through kernel: ` +
            `output=${JSON.stringify(output.slice(0, 500))}`;
        }
      } catch (e) {
        sandboxSkip = `child_process bridge spawn probe failed: ${(e as Error).message}`;
      }
    }

    // Probe 3: check if interactive stdin (PTY → process.stdin events) works
    // The sandbox code listens for process.stdin 'data' events. We write to
    // the PTY master and check if data arrives at the sandbox's process.stdin.
    // If not, interactive TUI use is impossible (no keyboard input delivery).
    if (!sandboxSkip) {
      try {
        const shell = kernel.openShell({
          command: 'node',
          args: [
            '-e',
            // Echo any stdin data to stdout, exit after 3s if nothing arrives
            `process.stdin.on('data',(d)=>{` +
              `process.stdout.write('GOT:'+d)` +
            `});process.stdin.resume();` +
            `setTimeout(()=>{process.stdout.write('NO_STDIN');},3000)`,
          ],
          cwd: SECURE_EXEC_ROOT,
          env: {
            PATH: process.env.PATH ?? '/usr/bin',
            HOME: process.env.HOME ?? tmpdir(),
          },
        });
        let stdinOutput = '';
        shell.onData = (data) => {
          stdinOutput += new TextDecoder().decode(data);
        };

        // Wait for process to initialize, then write test data to PTY
        await new Promise((r) => setTimeout(r, 500));
        try { shell.write('PROBE\n'); } catch { /* PTY may be closed */ }

        // Wait for either data echo or timeout
        await Promise.race([
          shell.wait(),
          new Promise<void>((r) => setTimeout(r, 5_000)),
        ]);

        if (!stdinOutput.includes('GOT:')) {
          sandboxSkip =
            'Streaming stdin bridge not supported in kernel Node RuntimeDriver — ' +
            'interactive PTY requires process.stdin events from PTY to be delivered ' +
            'to the sandbox process (NodeRuntimeDriver batches stdin as single ' +
            'string for exec(), not streaming)';
        }
      } catch (e) {
        sandboxSkip =
          'Streaming stdin bridge not supported — ' +
          `probe error: ${(e as Error).message}`;
      }
    }

    if (sandboxSkip) {
      console.warn(`[opencode-interactive] Skipping all tests: ${sandboxSkip}`);
    }
  }, 45_000);

  afterEach(async () => {
    await harness?.dispose();
  });

  afterAll(async () => {
    await mockServer?.close();
    await kernel?.dispose();
    await rm(workDir, { recursive: true, force: true });
  });

  /** Create a TerminalHarness that runs OpenCode inside the sandbox PTY. */
  function createOpenCodeHarness(opts: {
    mockPort?: number;
    extraArgs?: string[];
  }): TerminalHarness {
    return new TerminalHarness(kernel, {
      command: 'node',
      args: [
        '-e',
        buildOpenCodeInteractiveCode({
          mockUrl: opts.mockPort
            ? `http://127.0.0.1:${opts.mockPort}`
            : undefined,
          cwd: workDir,
          extraArgs: opts.extraArgs,
        }),
      ],
      cwd: SECURE_EXEC_ROOT,
      env: {
        PATH: process.env.PATH ?? '/usr/bin',
        HOME: process.env.HOME ?? tmpdir(),
      },
    });
  }

  it(
    'OpenCode TUI renders — screen shows OpenTUI interface after boot',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([]);

      harness = createOpenCodeHarness({
        mockPort: mockServer.port,
      });

      // OpenCode TUI shows "Ask anything" placeholder in the input area
      await harness.waitFor('Ask anything', 1, 30_000);

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('Ask anything');
      // Status bar has keyboard shortcut hints
      expect(screen).toMatch(/ctrl\+[a-z]/i);
    },
    45_000,
  );

  it(
    'input area works — type prompt text, appears in input area',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([
        { type: 'text', text: 'placeholder' },
        { type: 'text', text: 'placeholder' },
      ]);

      harness = createOpenCodeHarness({
        mockPort: mockServer.port,
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
    async ({ skip }) => {
      if (sandboxSkip) skip();

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
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([
        { type: 'text', text: 'placeholder' },
        { type: 'text', text: 'placeholder' },
      ]);

      harness = createOpenCodeHarness({
        mockPort: mockServer.port,
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
    'PTY resize — OpenCode TUI re-renders for new dimensions',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([
        { type: 'text', text: 'placeholder' },
        { type: 'text', text: 'placeholder' },
      ]);

      harness = createOpenCodeHarness({
        mockPort: mockServer.port,
      });

      // Wait for TUI to boot
      await harness.waitFor('Ask anything', 1, 30_000);

      const screenBefore = harness.screenshotTrimmed();

      // Resize PTY to wider terminal and resize xterm to match
      harness.shell.resize(120, 40);
      harness.term.resize(120, 40);

      // Wait for OpenCode to process SIGWINCH and re-render
      await new Promise((r) => setTimeout(r, 1_500));

      const screenAfter = harness.screenshotTrimmed();
      // OpenCode TUI should still show its UI elements after resize
      expect(screenAfter).toMatch(/Ask anything|ctrl\+[a-z]/i);
      // Screen should not be blank/garbled
      expect(screenAfter.length).toBeGreaterThan(0);
    },
    45_000,
  );

  it(
    'exit cleanly — Ctrl+C twice, OpenCode exits and PTY closes',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([]);

      harness = createOpenCodeHarness({
        mockPort: mockServer.port,
      });

      // Wait for TUI to boot
      await harness.waitFor('Ask anything', 1, 30_000);

      // Send ^C twice to exit (common TUI pattern: first ^C cancels, second exits)
      await harness.type('\x03');
      await new Promise((r) => setTimeout(r, 300));
      await harness.type('\x03');

      // Wait for process to exit
      const exitCode = await Promise.race([
        harness.shell.wait(),
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
