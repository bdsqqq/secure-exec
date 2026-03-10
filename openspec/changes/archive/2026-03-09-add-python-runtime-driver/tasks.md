## 1. Runtime Contract Split

- [x] 1.1 Add runtime-driver type split in `packages/secure-exec/src/types.ts` and `src/runtime-driver.ts` (`NodeRuntimeDriver`, `PythonRuntimeDriver`, and shared exec/lifecycle base contracts).
- [x] 1.2 Update `NodeRuntime` wiring and public exports to use the Node-specific runtime-driver contract without changing existing Node behavior.
- [x] 1.3 Add `PythonRuntime` public API surface and Python run-result wrapper types (backend-neutral structured return contract).

## 2. Pyodide Python Driver

- [x] 2.1 Implement `PyodideRuntimeDriver` under `packages/secure-exec/src/python/` and wire `PythonRuntime` to delegate `exec`/`run` to it.
- [x] 2.2 Enforce warm-runtime lifecycle semantics so consecutive executions on one `PythonRuntime` instance share interpreter state until `dispose`/`terminate`.
- [x] 2.3 Route Python capability access through the existing `SystemDriver` adapters and permission gates (`fs`, `network`, `childProcess`, `env`) with deny-by-default behavior.
- [x] 2.4 Keep runtime package installation/loading out of scope by returning deterministic unsupported errors for package-install/load pathways.
- [x] 2.5 Enforce bounded output handling and deterministic timeout mapping so Python `exec()` matches shared result semantics and avoids unbounded host buffering.

## 3. Tests

- [x] 3.1 Add `packages/secure-exec/tests/runtime-driver/python.test.ts` covering Python driver contract behavior and warm-state semantics.
- [x] 3.2 Add Python exec behavior coverage under `packages/secure-exec/tests/test-suite/` covering success, exception, and timeout result semantics.
- [x] 3.3 Update/add shared behavior tests in `packages/secure-exec/tests/test-suite.test.ts` (and shared helpers) to verify Node/Python `exec()` parity.
- [x] 3.4 Add abuse-path regressions for high-volume Python stdout/stderr and timeout recovery behavior (no unbounded host-memory accumulation).
- [x] 3.5 Update Node runtime-driver tests for renamed Node runtime-driver contracts and ensure existing Node semantics remain unchanged.

## 4. Documentation And Validation

- [x] 4.1 Update `docs-internal/arch/overview.md` with the new component map (`NodeRuntime`, `PythonRuntime`, `NodeRuntimeDriver`, `PythonRuntimeDriver`, `SystemDriver`).
- [x] 4.2 Update `docs-internal/friction.md` with Python runtime trade-offs (warm state, package install out-of-scope, parity constraints).
- [x] 4.3 Run validation commands: `pnpm --filter secure-exec tsc -p tsconfig.json --noEmit`, `pnpm --filter secure-exec vitest --run tests/test-suite.test.ts tests/test-suite-python.test.ts`, and `pnpm --filter secure-exec vitest --run tests/runtime-driver/node.test.ts tests/runtime-driver/python.test.ts`.

## 5. Test Naming Cleanup

- [x] 5.1 Rename test files that include `contract` in the filename (migrated `packages/secure-exec/tests/bridge-contract.test.ts` to `packages/secure-exec/tests/bridge-registry-policy.test.ts`) and update related scripts/imports.
