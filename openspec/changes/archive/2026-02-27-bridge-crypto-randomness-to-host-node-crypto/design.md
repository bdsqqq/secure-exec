## Context

The current runtime installs `globalThis.crypto` from `packages/sandboxed-node/src/bridge/process.ts`, where `getRandomValues()` fills bytes using `Math.random()` and `randomUUID()` is derived from those weak bytes. This is a security-sensitive compatibility gap because untrusted workloads may assume Web Crypto entropy semantics while receiving predictable randomness.

The runtime architecture requires all privileged capabilities to cross the bridge boundary. Secure entropy therefore must come from host `node:crypto` through explicit bridge wiring, not from isolate-local pseudo-random helpers.

## Goals / Non-Goals

**Goals:**
- Provide host-backed CSPRNG semantics for `crypto.getRandomValues()` in the sandbox runtime.
- Provide host-backed UUID v4 semantics for `crypto.randomUUID()`.
- Enforce fail-closed behavior: if secure host entropy is unavailable, throw deterministic unsupported errors instead of silently degrading.
- Keep compatibility docs and matrix fixtures aligned with the new behavior.

**Non-Goals:**
- Implementing full `crypto.subtle` Web Crypto support.
- Expanding general `node:crypto` API parity beyond randomness primitives in this change.
- Introducing fixture-aware runtime branches or known-mismatch exceptions in compatibility tests.

## Decisions

### Decision: Bridge randomness calls to host `node:crypto`
`getRandomValues()` and `randomUUID()` will delegate to host-side `node:crypto` functionality wired through bridge references during runtime setup.

Rationale:
- Host Node already provides CSPRNG-grade entropy primitives.
- This preserves the isolate/bridge trust model: privileged entropy comes from outside the isolate.
- It avoids reimplementing cryptographic primitives inside sandbox code.

Alternatives considered:
- Keep `Math.random()` fallback: rejected as actively unsafe.
- Rely on bundled `crypto-browserify` randomness behavior alone: rejected because its behavior can vary by environment and does not enforce an explicit fail-closed bridge contract.

### Decision: Fail closed when secure entropy cannot be obtained
If host randomness hooks are missing or fail at runtime, the bridge will throw deterministic unsupported errors for `crypto.getRandomValues` / `crypto.randomUUID`.

Rationale:
- Silent downgrade from secure to insecure randomness is higher risk than explicit failure.
- Deterministic errors keep compatibility expectations testable and debuggable.

Alternatives considered:
- Fallback to non-cryptographic randomness: rejected for security reasons.
- Return empty/zeroed buffers: rejected because it silently corrupts security assumptions.

### Decision: Keep compatibility governance artifacts in sync in the same change
The implementation will update compatibility docs, matrix fixtures, and friction tracking alongside runtime code so spec, docs, and observed behavior stay aligned.

Rationale:
- Randomness behavior is externally visible and security-relevant.
- Existing governance requires synchronized compatibility documentation for bridge/stdlib changes.

## Risks / Trade-offs

- [Risk] Bridge call overhead could slightly increase cost of repeated small randomness calls.
  -> Mitigation: use synchronous host primitives directly and keep marshaling minimal.

- [Risk] TypedArray edge cases (`byteOffset`, view length) may diverge from Node/Web Crypto semantics.
  -> Mitigation: add matrix fixture coverage for representative typed-array views and size/error behavior.

- [Risk] Some host environments may unexpectedly fail entropy APIs.
  -> Mitigation: enforce deterministic throw paths and document fail-closed behavior in compatibility docs/friction notes.

## Migration Plan

1. Add host randomness bridge wiring (`randomFillSync` and UUID generation) in runtime setup and expose bridge hooks to the isolate.
2. Update `cryptoPolyfill` randomness methods in `process.ts` to call host bridge hooks and remove all `Math.random()` entropy logic.
3. Update compatibility matrix documentation to remove the insecurity warning and describe secure-or-throw behavior.
4. Add/adjust compatibility fixture project(s) that run in host Node and sandboxed-node and compare normalized outcomes.
5. Run bridge/type and targeted compatibility tests; resolve mismatches before marking complete.
6. Update `docs-internal/friction/sandboxed-node.md` with resolution notes for this previously known weak-randomness behavior.

## Open Questions

- None.
