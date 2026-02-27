## 1. ESM `run()` Export Semantics

- [x] 1.1 Update the ESM `run()` execution path in `packages/sandboxed-node/src/index.ts` so `run()` returns the evaluated entry namespace object (default + named exports) instead of evaluation return values.
- [x] 1.2 Keep CommonJS `run()` behavior unchanged (`module.exports`) and ensure `exec()` output contract remains unaffected.

## 2. Dynamic Import Ordering Semantics

- [x] 2.1 Ensure dynamic-import precompile remains compile-only (no instantiate/evaluate side effects before user code reaches `import()`).
- [x] 2.2 Ensure `__dynamicImport` evaluates modules on demand via async host bridge behavior and preserves call-time side-effect ordering.
- [x] 2.3 Ensure repeated dynamic imports reuse cached namespace results and avoid duplicate evaluation.

## 3. Regression Coverage

- [x] 3.1 Add/maintain tests for ESM `run()` export shapes: default-only, named-only, and mixed exports.
- [x] 3.2 Add/maintain tests proving dynamic-import ordering (`before -> side-effect -> after`) and untaken-branch non-evaluation.
- [x] 3.3 Add/maintain tests for repeated dynamic-import caching and missing-module rejection fidelity.

## 4. Validation and Tracking

- [x] 4.1 Run targeted sandboxed-node verification (`pnpm --filter sandboxed-node test -- tests/index.test.ts`) and confirm runtime-module scenarios pass.
  - 2026-02-27: `pnpm --filter sandboxed-node test -- tests/index.test.ts` passed (1 file, 27 tests).
- [x] 4.2 Run sandboxed-node type checks (`pnpm --filter sandboxed-node check-types`) and capture any pre-existing unrelated failures separately.
  - 2026-02-27: `pnpm --filter sandboxed-node check-types` failed with pre-existing bridge/browser typing errors outside this change scope (for example `src/bridge/network.ts`, `src/bridge/process.ts`, `src/browser/*`).
- [x] 4.3 Update change notes and friction tracking (`docs-internal/friction/sandboxed-node.md`) if implementation uncovers remaining Node-compat deltas.
  - 2026-02-27: No additional module-semantics friction discovered beyond existing logged items.
