/**
 * E2E test: Python + WasmVM integration through kernel.
 *
 * Exercises Python execution, stdlib imports, cross-runtime pipes
 * (WasmVM → Python), Python spawning shell commands through kernel,
 * and exit code propagation.
 *
 * Skipped when WASM binary is not built or Pyodide is not installed.
 */

import { describe, expect, it } from 'vitest';
import {
  createIntegrationKernel,
  skipUnlessWasmBuilt,
  skipUnlessPyodide,
} from './helpers.ts';

const skipReason = skipUnlessWasmBuilt() || skipUnlessPyodide();

describe.skipIf(skipReason)('e2e Python + WasmVM through kernel', () => {
  it('basic Python execution: print(42)', async () => {
    const { kernel, dispose } = await createIntegrationKernel({
      runtimes: ['wasmvm', 'python'],
    });

    try {
      const result = await kernel.exec('python -c "print(42)"', { timeout: 20000 });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('42\n');
    } finally {
      await dispose();
    }
  }, 30_000);

  it('Python stdlib import: json.dumps', async () => {
    const { kernel, dispose } = await createIntegrationKernel({
      runtimes: ['wasmvm', 'python'],
    });

    try {
      const result = await kernel.exec(
        'python -c "import json; print(json.dumps({\\"ok\\": True}))"',
        { timeout: 20000 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain('{"ok": true}');
    } finally {
      await dispose();
    }
  }, 30_000);

  it('WasmVM-to-Python pipe: echo | python stdin', async () => {
    const { kernel, dispose } = await createIntegrationKernel({
      runtimes: ['wasmvm', 'python'],
    });

    try {
      const result = await kernel.exec(
        'echo hello | python -c "import sys; print(sys.stdin.read().strip().upper())"',
        { timeout: 20000 },
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe('HELLO\n');
    } finally {
      await dispose();
    }
  }, 30_000);

  it('Python spawning shell through kernel: os.system', async () => {
    const { kernel, dispose } = await createIntegrationKernel({
      runtimes: ['wasmvm', 'python'],
    });

    try {
      const result = await kernel.exec(
        'python -c "import os; os.system(\\"echo from-shell\\")"',
        { timeout: 20000 },
      );
      expect(result.stdout).toContain('from-shell');
    } finally {
      await dispose();
    }
  }, 30_000);

  it('Python exit code propagation: sys.exit(42)', async () => {
    const { kernel, dispose } = await createIntegrationKernel({
      runtimes: ['wasmvm', 'python'],
    });

    try {
      const result = await kernel.exec(
        'python -c "import sys; sys.exit(42)"',
        { timeout: 20000 },
      );
      expect(result.exitCode).toBe(42);
    } finally {
      await dispose();
    }
  }, 30_000);
});
