## Why

Sandboxed code can currently overwrite several runtime-owned globals that the runtime and bridge rely on for lifecycle, module loading, and host callback dispatch. This creates integrity and availability risk in the isolate, so we need a consistent hardening rule for custom globals now that active-handle hooks are already being hardened.

## What Changes

- Define a shared global-exposure helper for runtime/bridge setup code that installs custom globals on `globalThis` with `writable: false` and `configurable: false` by default.
- Apply that helper to custom, runtime-owned globals exposed into the isolate (bridge dispatch hooks, bridge module handles, and other non-stdlib control-plane globals).
- Preserve Node compatibility by explicitly excluding Node stdlib globals from forced freezing (for example `process`, timers, `console`, `Buffer`, `URL`, `fetch`).
- Keep intentional mutable execution-state globals mutable where required for runtime operation (for example per-execution module/stdin state), with explicit allowlist rationale.
- Maintain a canonical inventory of custom global exposures and require exhaustive per-global immutability coverage for all hardened custom globals.
- Add compatibility tests that verify stdlib globals remain Node-compatible and mutable allowlisted runtime-state globals still function.
- Update compatibility/friction documentation with the global hardening policy and any intentional exceptions.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-bridge`: require bridge-defined custom globals to be installed through a hardened descriptor policy (`writable: false`, `configurable: false`) unless explicitly documented mutable runtime state.
- `node-runtime`: require runtime bootstrap global exposure paths to use the same custom-global hardening helper and policy for non-stdlib globals.
- `compatibility-governance`: require policy docs to distinguish hardened custom globals from intentionally mutable Node stdlib globals and runtime state.

## Impact

- Affected code:
  - `packages/sandboxed-node/src/bridge/*.ts`
  - `packages/sandboxed-node/src/index.ts`
  - `packages/sandboxed-node/src/shared/*.ts`
  - `packages/sandboxed-node/src/browser/worker.ts` (policy alignment for non-Node runtime surface where applicable)
- Affected tests:
  - `packages/sandboxed-node/tests/index.test.ts`
  - bridge/runtime exhaustive custom-global tamper-resistance tests
- Documentation:
  - `docs-internal/friction/sandboxed-node.md`
  - `docs-internal/node/ACTIVE_HANDLES.md` and related bridge/runtime notes where globals are described
