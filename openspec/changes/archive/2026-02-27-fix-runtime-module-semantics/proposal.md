## Why

Current sandboxed-node behavior does not fully match documented module execution semantics: `run()` ESM behavior and dynamic import ordering remain unresolved in the TODO backlog. Capturing this as a focused change turns known runtime gaps into an implementable spec delta.

## What Changes

- Align `run()` ESM behavior so module exports/default are returned according to documented runtime expectations.
- Fix dynamic import execution ordering so imports are not eagerly evaluated before user code.
- Add or update requirement scenarios that make module execution semantics testable.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: tighten and clarify module evaluation and result-return semantics for ESM and dynamic import behavior.

## Impact

- Affected code: `packages/sandboxed-node/src/index.ts` module loading/evaluation path.
- Affected tests: runtime execution and module behavior tests under `packages/sandboxed-node/tests`.
- Reduced ambiguity between docs and runtime behavior for ESM execution.
