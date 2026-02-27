## Why

Sandboxed-node currently accepts unbounded payloads from the isolate for base64 file I/O references and multiple JSON-encoded bridge messages. A crafted large payload can force host-side allocation spikes or OOM before runtime checks run, so the runtime needs explicit boundary limits and fail-fast validation.

## What Changes

- Add runtime-enforced size limits for base64 payloads crossing the isolate boundary in `readFileBinaryRef` and `writeFileBinaryRef` paths.
- Add host-side byte-length validation before every `JSON.parse` call that consumes isolate-originated payloads in `packages/sandboxed-node/src/index.ts`.
- Add bounded host configuration for payload limits so deployments can tune limits without disabling boundary protection.
- Define deterministic failure behavior when payload-size limits are exceeded (structured bridge/runtime error contract instead of host OOM).
- Add targeted regression tests that prove oversized isolate payloads are rejected safely and normal-sized payloads preserve existing behavior.
- Document intentional compatibility constraints for isolate-boundary transfer limits in friction/security documentation.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-bridge`: require bounded isolate-to-host payload handling for binary file references and JSON bridge messages.
- `node-runtime`: require pre-parse payload-size validation for isolate-originated JSON strings and deterministic failure semantics on overflow.
- `compatibility-governance`: require compatibility/friction/security documentation updates when runtime boundary size limits intentionally differ from default Node host behavior.

## Impact

- Affected code:
  - `packages/sandboxed-node/src/index.ts`
  - related runtime/bridge tests under `packages/sandboxed-node/tests/`
- Affected behavior:
  - oversized isolate payloads fail with deterministic runtime errors instead of risking host OOM
- Documentation impact:
  - `docs-internal/friction/sandboxed-node.md`
  - `docs/security-model.mdx` (boundary hardening and limit rationale)
