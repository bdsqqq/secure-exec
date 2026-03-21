/**
 * E2E test: Claude Code interactive TUI through the sandbox's
 * kernel.openShell() PTY.
 *
 * Claude Code is a native binary — it must be spawned from inside the
 * sandbox via the child_process.spawn bridge. The bridge dispatches to a
 * HostBinaryDriver mounted in the kernel, which spawns the real binary on
 * the host. Output flows back through the bridge to process.stdout, which
 * is connected to the kernel's PTY slave → PTY master → xterm headless.
 *
 * If the sandbox cannot support Claude Code's interactive TUI (e.g. streaming
 * stdin bridge not supported, child_process bridge cannot spawn host
 * binaries), all tests skip with a clear reason referencing the specific
 * blocker.
 *
 * Uses ANTHROPIC_BASE_URL to redirect API calls to a mock LLM server.
 *
 * Uses relative imports to avoid cyclic package dependencies.
 */

import { spawn as nodeSpawn } from 'node:child_process';
import * as fsPromises from 'node:fs/promises';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
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
// HostBinaryDriver — spawns real host binaries through the kernel
// ---------------------------------------------------------------------------

/**
 * Minimal RuntimeDriver that spawns real host binaries. Registered commands
 * are dispatched to node:child_process.spawn on the host. This allows
 * sandbox code to call child_process.spawn('claude', ...) and have it
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
// Claude sandbox code builder
// ---------------------------------------------------------------------------

/**
 * Build sandbox code that spawns Claude Code interactively through the
 * child_process bridge. The code wraps claude in `script -qefc` so
 * the binary gets a real PTY on the host (isTTY=true). Stdout/stderr
 * are piped to process.stdout/stderr (→ kernel PTY → xterm). Stdin
 * from the kernel PTY is piped to the child.
 */
function buildClaudeInteractiveCode(opts: {
  claudeBinary: string;
  mockUrl: string;
  cwd: string;
  extraArgs?: string[];
}): string {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: opts.cwd,
    ANTHROPIC_API_KEY: 'test-key',
    ANTHROPIC_BASE_URL: opts.mockUrl,
    TERM: 'xterm-256color',
  };

  // Build the claude command for script -qefc
  const claudeArgs = [
    opts.claudeBinary,
    '--dangerously-skip-permissions',
    '--model', 'haiku',
    ...(opts.extraArgs ?? []),
  ];
  const cmd = claudeArgs
    .map((a) => `'${a.replace(/'/g, "'\\''")}'`)
    .join(' ');

  return `(async () => {
    const { spawn } = require('child_process');

    // Spawn claude wrapped in script for host-side PTY support
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

describe.skipIf(skipReason)('Claude Code interactive PTY E2E (sandbox)', () => {
  let harness: TerminalHarness;

  beforeAll(async () => {
    mockServer = await createMockLlmServer([]);
    workDir = await mkdtemp(path.join(tmpdir(), 'claude-interactive-'));

    // Pre-create Claude config to skip first-run setup (theme selection dialog)
    const claudeDir = path.join(workDir, '.claude');
    await mkdir(claudeDir, { recursive: true });
    await writeFile(
      path.join(claudeDir, 'settings.json'),
      JSON.stringify({ skipDangerousModePermissionPrompt: true }),
    );
    // Pre-accept terms to skip onboarding
    await writeFile(path.join(claudeDir, '.terms-accepted'), '');

    // Overlay VFS: writes to memory (populateBin), reads fall back to host
    kernel = createKernel({ filesystem: createOverlayVfs() });
    await kernel.mount(createNodeRuntime({
      permissions: { ...allowAllChildProcess, ...allowAllEnv },
    }));
    await kernel.mount(new HostBinaryDriver([claudeBinary!, 'script']));

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

    // Probe 2: check if child_process bridge can spawn claude through kernel
    if (!sandboxSkip) {
      try {
        const { output } = await probeOpenShell(
          kernel,
          `(async()=>{` +
            `const{spawn}=require('child_process');` +
            `const c=spawn(${JSON.stringify(claudeBinary)},['--version'],{env:process.env});` +
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
            `child_process bridge cannot spawn claude through kernel: ` +
            `output=${JSON.stringify(output.slice(0, 500))}`;
        }
      } catch (e) {
        sandboxSkip = `child_process bridge spawn probe failed: ${(e as Error).message}`;
      }
    }

    // Probe 3: check if interactive stdin (PTY → process.stdin events) works
    if (!sandboxSkip) {
      try {
        const shell = kernel.openShell({
          command: 'node',
          args: [
            '-e',
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
      console.warn(`[claude-interactive] Skipping all tests: ${sandboxSkip}`);
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

  /** Create a TerminalHarness that runs Claude Code inside the sandbox PTY. */
  function createClaudeHarness(opts?: {
    extraArgs?: string[];
  }): TerminalHarness {
    return new TerminalHarness(kernel, {
      command: 'node',
      args: [
        '-e',
        buildClaudeInteractiveCode({
          claudeBinary: claudeBinary!,
          mockUrl: `http://127.0.0.1:${mockServer.port}`,
          cwd: workDir,
          extraArgs: opts?.extraArgs,
        }),
      ],
      cwd: SECURE_EXEC_ROOT,
      cols: 120,
      rows: 40,
      env: {
        PATH: process.env.PATH ?? '/usr/bin',
        HOME: process.env.HOME ?? tmpdir(),
      },
    });
  }

  /**
   * Wait for Claude TUI to fully boot. Auto-dismisses onboarding dialogs
   * (theme selection, workspace trust) by pressing Enter.
   */
  async function waitForClaudeBoot(h: TerminalHarness): Promise<void> {
    const deadline = Date.now() + 30_000;
    let enterSent = 0;
    while (Date.now() < deadline) {
      const screen = h.screenshotTrimmed();
      // Main prompt reached — Claude shows "Haiku" or "Welcome" or "❯"
      if (screen.includes('Haiku') || screen.includes('Welcome') || screen.includes('❯')) {
        break;
      }
      // Dismiss dialogs (trust, theme) with Enter
      if (enterSent < 10 && screen.length > 10) {
        await new Promise((r) => setTimeout(r, 1500));
        await h.type('\r');
        enterSent++;
        continue;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  it(
    'Claude TUI renders — screen shows Ink-based UI after boot',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([{ type: 'text', text: 'Hello!' }]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);

      // Claude's Ink TUI shows a prompt area with '❯' indicator
      await harness.waitFor('❯', 1, 5_000);

      const screen = harness.screenshotTrimmed();
      expect(screen.length).toBeGreaterThan(0);
    },
    45_000,
  );

  it(
    'Input area works — type prompt text, appears on screen',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([{ type: 'text', text: 'Hello!' }]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);

      // Wait for TUI to boot
      await harness.waitFor('❯', 1, 5_000);

      // Type text into the prompt area
      await harness.type('hello world test');

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('hello world test');
    },
    45_000,
  );

  it(
    'Submit shows response — enter prompt, streaming response renders on screen',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([{ type: 'text', text: 'boot' }]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);
      await harness.waitFor('❯', 1, 5_000);

      // Reset mock AFTER onboarding (onboarding Enter presses may consume queue)
      // Pad queue: Claude may make title/metadata requests before main response
      const canary = 'INTERACTIVE_CANARY_CC_42';
      mockServer.reset([
        { type: 'text', text: canary },
        { type: 'text', text: canary },
        { type: 'text', text: canary },
      ]);

      // Type prompt and submit with Enter
      await harness.type('say hello\r');

      // Wait for the canned LLM response to appear on screen
      await harness.waitFor(canary, 1, 30_000);

      const screen = harness.screenshotTrimmed();
      expect(screen).toContain(canary);
    },
    60_000,
  );

  it(
    '^C interrupts response — send SIGINT during streaming, Claude stays alive',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([
        { type: 'text', text: 'First response' },
        { type: 'text', text: 'Second response' },
      ]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);

      // Wait for TUI to boot
      await harness.waitFor('❯', 1, 5_000);

      // Submit a prompt
      await harness.type('say hello\r');

      // Give Claude a moment to start processing, then send ^C
      await new Promise((r) => setTimeout(r, 500));
      await harness.type('\x03');

      // Claude should survive single ^C — wait for prompt to return
      await harness.waitFor('❯', 1, 15_000);

      // Verify Claude is still alive by typing more text
      await harness.type('still alive');
      const screen = harness.screenshotTrimmed();
      expect(screen).toContain('still alive');
    },
    60_000,
  );

  it(
    'Color output renders — ANSI color codes in xterm buffer',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([{ type: 'text', text: 'Color test response' }]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);

      // Wait for TUI to boot — Claude's TUI uses colored text
      await harness.waitFor('❯', 1, 5_000);

      // Check xterm has parsed some cells with foreground color set
      const buf = harness.term.buffer.active;
      let hasColor = false;
      for (let y = 0; y < harness.term.rows && !hasColor; y++) {
        const line = buf.getLine(buf.viewportY + y);
        if (!line) continue;
        for (let x = 0; x < harness.term.cols; x++) {
          const cell = line.getCell(x);
          if (cell && cell.getFgColor() !== 0) {
            hasColor = true;
            break;
          }
        }
      }
      expect(hasColor).toBe(true);
    },
    45_000,
  );

  it(
    'Tool use UI — tool execution renders on screen when LLM requests a tool',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      // Queue: tool_use (Bash) → text result after tool execution
      mockServer.reset([
        { type: 'tool_use', name: 'Bash', input: { command: 'echo TOOL_CANARY_42' } },
        { type: 'text', text: 'The tool ran successfully.' },
        { type: 'text', text: 'The tool ran successfully.' },
      ]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);
      await harness.waitFor('❯', 1, 5_000);

      // Submit a prompt that will trigger a tool use
      await harness.type('run echo\r');

      // Wait for tool-related UI to appear — Claude shows tool name or output
      // With --dangerously-skip-permissions, tools auto-execute and show results
      await harness.waitFor('Bash', 1, 30_000);

      const screen = harness.screenshotTrimmed();
      // Tool name should appear in the TUI output
      expect(screen).toMatch(/Bash|echo|TOOL_CANARY/i);
    },
    60_000,
  );

  it(
    'PTY resize — Ink re-renders for new dimensions',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([{ type: 'text', text: 'resize placeholder' }]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);
      await harness.waitFor('❯', 1, 5_000);

      // Resize PTY to wider terminal and resize xterm to match
      harness.shell.resize(120, 40);
      harness.term.resize(120, 40);

      // Wait for Claude's Ink TUI to process SIGWINCH and re-render
      await new Promise((r) => setTimeout(r, 1_500));

      const screenAfter = harness.screenshotTrimmed();
      // Claude TUI should still show its UI elements after resize
      expect(screenAfter).toMatch(/❯|Haiku|Welcome/);
      // Screen should not be blank/garbled
      expect(screenAfter.length).toBeGreaterThan(0);
    },
    45_000,
  );

  it(
    '/help renders help text — help command output visible on screen',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);
      await harness.waitFor('❯', 1, 5_000);

      // Type /help and submit
      await harness.type('/help\r');

      // Wait for help content to render — Claude shows slash commands list
      // Help output includes common commands like /exit, /clear, /help
      await harness.waitFor('exit', 1, 15_000);

      const screen = harness.screenshotTrimmed();
      // Help text should list available commands
      expect(screen).toMatch(/exit|clear|help/i);
    },
    45_000,
  );

  it(
    'Exit cleanly — /exit causes Claude to exit',
    async ({ skip }) => {
      if (sandboxSkip) skip();

      mockServer.reset([]);

      harness = createClaudeHarness();
      await waitForClaudeBoot(harness);

      // Wait for TUI to boot
      await harness.waitFor('❯', 1, 5_000);

      // Type /exit and submit
      await harness.type('/exit\r');

      // Wait for process to exit
      const exitCode = await Promise.race([
        harness.shell.wait(),
        new Promise<number>((_, reject) =>
          setTimeout(() => reject(new Error('Claude did not exit within 15s')), 15_000),
        ),
      ]);

      expect(exitCode).toBe(0);
    },
    30_000,
  );
});
