## 1. Bridge Host Randomness Into Runtime

- [x] 1.1 Add host `node:crypto` bridge hooks in `packages/sandboxed-node/src/index.ts` for secure random fill and UUID generation.
- [x] 1.2 Update bridge/global declarations so `packages/sandboxed-node/src/bridge/process.ts` can call the host randomness hooks from inside the isolate.
- [x] 1.3 Replace `Math.random()`-based `cryptoPolyfill.getRandomValues()` implementation with host-backed secure fill semantics.
- [x] 1.4 Replace `cryptoPolyfill.randomUUID()` byte-derivation logic with host-backed UUID generation semantics.
- [x] 1.5 Enforce fail-closed behavior: when host entropy hooks are unavailable or fail, throw deterministic unsupported errors instead of falling back.

## 2. Compatibility and Governance Artifacts

- [x] 2.1 Update `docs/node-compatability.mdx` crypto entry to remove the insecurity warning and document secure-or-throw randomness behavior.
- [x] 2.2 Update `docs-internal/friction/sandboxed-node.md` to mark the weak-randomness issue resolved with fix notes.
- [x] 2.3 Ensure OpenSpec follow-up/checklist references for this security gap are updated to reflect implementation completion.

## 3. Compatibility Matrix Coverage

- [x] 3.1 Add or update black-box fixture project(s) under `packages/sandboxed-node/tests/projects/` to exercise `crypto.getRandomValues()` and `crypto.randomUUID()`.
- [x] 3.2 Update project-matrix expectations so host Node and sandboxed-node outputs are compared for normalized parity (`code`, `stdout`, `stderr`) with no known-mismatch bypass.
- [x] 3.3 Add explicit coverage for deterministic throw behavior when secure randomness cannot be provided by the bridge.

## 4. Validation

- [x] 4.1 Run `pnpm --dir packages/sandboxed-node run check-types:test` after bridge changes and fix any type regressions.
- [x] 4.2 Run targeted project-matrix verification with `pnpm --dir packages/sandboxed-node run test:project-matrix`.
- [x] 4.3 Run focused sandboxed-node tests for crypto randomness paths (Vitest) and record results in the change notes/PR description.
