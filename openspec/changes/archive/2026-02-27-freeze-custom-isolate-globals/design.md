## Context

The sandbox runtime currently exposes globals into the isolate through multiple mechanisms (bridge bootstrap, runtime `context.eval` setup, and browser worker setup). Some custom bridge/runtime globals are mutable and can be overwritten by untrusted code, while others are already hardened. This inconsistent policy creates avoidable integrity and availability risk in the runtime control plane.

We already hardened active-handle lifecycle hooks, which proved both useful and low-risk. The next step is to make global exposure policy consistent: custom runtime-owned globals should be immutable by default, while Node stdlib globals should preserve Node-like mutability semantics.

## Goals / Non-Goals

**Goals:**
- Define one reusable helper pattern for exposing globals with descriptor policy, rather than ad-hoc property assignment.
- Make custom, non-stdlib globals immutable-by-default (`writable: false`, `configurable: false`) across runtime/bridge setup paths.
- Preserve Node compatibility by not force-freezing stdlib globals purely due to hardening policy.
- Preserve required mutable runtime state through explicit, documented allowlist exceptions.
- Maintain a canonical inventory of custom globals exposed by runtime/bridge code.
- Add exhaustive per-global tamper-resistance coverage for all hardened custom globals and compatibility coverage for stdlib/mutable exceptions.

**Non-Goals:**
- Deep-freezing stdlib objects or changing Node stdlib surface behavior.
- Rewriting all bridge/runtime bootstrap codepaths in one refactor beyond global exposure policy updates.
- Introducing new sandbox capabilities.

## Decisions

### 1. Introduce a shared global-exposure helper and policy

Decision:
- Add a helper API for exposing globals with explicit descriptor intent (hardened vs mutable).
- Use this helper instead of manual `globalThis.foo = ...` and ad-hoc `Object.defineProperty` in bridge/runtime setup code.

Rationale:
- Prevents policy drift and repeated descriptor boilerplate.
- Makes security intent obvious in code review.

Alternatives considered:
- Keep manual `Object.defineProperty` at each callsite: rejected due to inconsistency risk.
- Freeze all globals by default including stdlib: rejected for Node compatibility.

### 2. Classify globals into hardened custom, stdlib compatibility, and mutable state

Decision:
- Hardened custom globals: default to non-writable/non-configurable bindings.
- Node stdlib globals: do not force non-writable descriptors via this policy.
- Mutable runtime state globals: remain mutable only when runtime behavior requires mutation, and must be documented.

Rationale:
- Matches security priority for runtime-owned control hooks while preserving Node-like stdlib behavior.
- Reduces accidental runtime breakage from over-freezing execution state.

Alternatives considered:
- Freeze everything except manual opt-outs added ad hoc: rejected due to high regression risk and poor auditability.

### 3. Apply policy across both Node runtime and browser worker bootstrap surfaces

Decision:
- Use the same descriptor policy model for equivalent custom global exposure paths in Node runtime and browser worker setup.

Rationale:
- Maintains consistent security posture and reduces divergent behavior between runtimes.

Alternatives considered:
- Scope policy to Node runtime only: deferred as incomplete because browser worker exposes similar custom globals.

### 4. Enforce exhaustive descriptor regression tests from inventory

Decision:
- Require one or more descriptor immutability assertions for every hardened custom global in the inventory.
- Add compatibility tests ensuring stdlib globals are not hardened solely by this policy.
- Add execution-path tests for mutable allowlisted globals to confirm required mutation still works.

Rationale:
- Prevents partial hardening from being mistaken as complete policy adoption.
- Ensures newly added custom globals cannot bypass hardening/test coverage expectations.

Alternatives considered:
- Rely only on code review: rejected as insufficient for broad callsite migration.

## Risks / Trade-offs

- [Over-hardening breaks runtime behavior that relies on mutation] -> Mitigation: explicit mutable allowlist and focused execution-path tests.
- [Missed global exposure callsites leave policy gaps] -> Mitigation: canonical inventory of custom globals plus exhaustive per-global descriptor tests.
- [Compatibility drift if stdlib globals become unintentionally frozen] -> Mitigation: add explicit stdlib non-hardening tests and compatibility notes.

## Migration Plan

1. Add helper utility for global exposure policy (hardened/mutable modes).
2. Inventory and classify existing global exposures: custom control-plane, stdlib, mutable runtime state.
3. Migrate custom control-plane exposures to helper with hardened descriptors.
4. Keep stdlib exposures on compatibility path (no forced freezing).
5. Preserve/document mutable runtime-state exposures where mutation is required.
6. Add exhaustive per-global descriptor tests for hardened custom globals and compatibility/mutable-exception tests.
7. Update friction/compatibility docs with policy and exceptions.

Rollback:
- Revert helper-based exposure migration and descriptor hardening changes, restoring prior assignment behavior while acknowledging reintroduced tampering risk.

## Open Questions

- Should the helper default `enumerable` to `true` (current behavior in most hardened globals) or `false` for tighter introspection surface?
- Should mutable allowlist entries require an inline rationale comment at each callsite, or be centralized in one policy table?
- Should browser-worker policy be shipped in the same implementation PR or as a follow-up if parity risk is high?
