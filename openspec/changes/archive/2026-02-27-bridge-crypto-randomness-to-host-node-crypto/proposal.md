## Why

`crypto.getRandomValues()` currently uses `Math.random()` in the sandbox runtime, which is not cryptographically secure. Silent weak randomness is an unsafe default for security-sensitive code and must be replaced with host-backed CSPRNG behavior (or fail closed).

## What Changes

- Bridge global `crypto.getRandomValues()` to host `node:crypto` entropy (`randomFillSync` or equivalent secure source).
- Bridge global `crypto.randomUUID()` to host `node:crypto.randomUUID()` semantics instead of deriving UUID bytes from weak randomness.
- Require fail-closed behavior when secure host entropy is unavailable (throw deterministic errors instead of falling back to `Math.random()`).
- Update compatibility docs/spec language to remove the current insecurity warning tied to `Math.random()` and document the new secure/throw contract.
- Add compatibility fixture coverage that compares host Node and sandboxed-node behavior for `getRandomValues()` and `randomUUID()`.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-bridge`: Define host-bridge requirements for cryptographic randomness APIs and prohibit weak-RNG fallback inside the bridge.
- `node-stdlib`: Update `crypto` module requirement language to require secure randomness semantics for `getRandomValues()`/`randomUUID()` (or deterministic throw), replacing the existing insecure warning contract.

## Impact

- Bridge/runtime code in `packages/sandboxed-node/src/bridge/process.ts` and related isolate setup in `packages/sandboxed-node/src/index.ts`.
- Compatibility matrix docs in `docs/node-compatability.mdx`.
- OpenSpec deltas under `openspec/changes/bridge-crypto-randomness-to-host-node-crypto/specs/`.
- Compatibility project-matrix fixtures/tests under `packages/sandboxed-node/tests/projects/` and associated matrix assertions.
