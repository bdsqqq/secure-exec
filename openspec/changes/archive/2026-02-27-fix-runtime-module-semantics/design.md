## Context

`NodeProcess` currently has two module-oriented execution semantics that need to be locked to Node-like behavior:

1. `run()` uses different return paths for CommonJS and ESM. CommonJS callers expect `module.exports`; ESM callers need the entry module namespace (`default` + named exports).
2. Dynamic `import()` goes through a transform/precompile bridge to satisfy `isolated-vm` constraints. Precompilation must remain side-effect free so imported modules execute only when user code reaches `import()`.

The canonical baseline for this change is `openspec/specs/node-runtime/spec.md`, with implementation centered in `packages/sandboxed-node/src/index.ts` and regressions covered in `packages/sandboxed-node/tests/index.test.ts`.

## Goals / Non-Goals

**Goals:**
- Make `run()` return CommonJS `module.exports` for CJS and ESM namespace objects for ESM entries.
- Preserve lazy dynamic import execution order so side effects do not run before user code reaches `import()`.
- Keep repeated dynamic imports stable (single evaluation, shared namespace) and preserve descriptive failures.
- Encode behavior in OpenSpec deltas and regression tests.

**Non-Goals:**
- Rewriting loader architecture to exactly mirror Node internals.
- Expanding stdlib/bridge capability surface.
- Changing `exec()` output contract beyond dynamic import ordering fidelity.

## Decisions

### 1. Return the ESM namespace from `run()`

**Decision:** Evaluate the entry ESM module, then materialize and return its namespace object (`{ default, ...named }`) from `run()`.

**Rationale:** This mirrors module semantics (the ESM equivalent of `module.exports`) and keeps `run()` useful for both default-only and mixed export modules.

**Alternative considered:** Return only `default` when present. Rejected because it loses named exports and makes return shape inconsistent.

### 2. Keep dynamic-import precompile compile-only

**Decision:** Use precompile only to resolve/compile modules; defer instantiation/evaluation to the async dynamic-import path.

**Rationale:** This preserves deadlock avoidance for `isolated-vm` while preventing eager side effects during setup.

**Alternative considered:** Fully lazy compile+evaluate inside `import()`. Rejected due higher reentrancy/deadlock risk in the isolate callback path.

### 3. Evaluate dynamic imports on demand with cache + in-flight dedupe

**Decision:** `__dynamicImport` resolves and evaluates modules on first call, caches namespace by resolved path, and coalesces concurrent imports.

**Rationale:** Matches Node-like single-evaluation behavior and preserves deterministic ordering.

**Alternative considered:** Keep synchronous bridge and pre-evaluate everything. Rejected because it violates lazy ordering guarantees.

## Risks / Trade-offs

- [Serialization limits for namespace copies] -> Mitigation: Return plain-object snapshots across isolate boundaries, consistent with existing host-copy semantics.
- [Behavior shift for callers relying on old ESM `run()` output] -> Mitigation: Document explicitly in spec delta and enforce with regression tests.
- [Dynamic-import fallback ambiguity] -> Mitigation: Restrict fallback usage to explicit CJS/JSON cases and keep ESM-origin failures intact.

## Migration Plan

1. Update runtime execution flow in `packages/sandboxed-node/src/index.ts` for ESM `run()` and dynamic import ordering guarantees.
2. Add/adjust runtime tests in `packages/sandboxed-node/tests/index.test.ts` for export-shape and dynamic-import ordering scenarios.
3. Validate with targeted `vitest` and `tsc` checks for `sandboxed-node`.
4. Mark OpenSpec tasks complete during apply and capture any unresolved compatibility friction.

## Open Questions

- Should additional `run()` namespace-copy edge cases (functions/classes/symbol exports) be documented as explicit compatibility notes, or remain implied by current isolate copy constraints?
