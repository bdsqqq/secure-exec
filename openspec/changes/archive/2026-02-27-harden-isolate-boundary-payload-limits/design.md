## Context

The sandboxed-node runtime currently accepts unbounded isolate-originated strings for two high-risk paths in `packages/sandboxed-node/src/index.ts`: base64 transfer in `readFileBinaryRef` / `writeFileBinaryRef`, and multiple host-side `JSON.parse` calls. Because these payloads cross the bridge from untrusted code, a malicious workload can force large host allocations and terminate the host process via OOM before normal error handling runs. The runtime needs boundary controls that fail predictably while preserving Node-like behavior for normal payload sizes.

## Goals / Non-Goals

**Goals:**
- Add explicit byte-size limits for base64 file-transfer payloads that cross the isolate boundary.
- Validate payload size before every host-side `JSON.parse` of isolate-originated data.
- Define deterministic overflow failure behavior that is testable and does not crash the host.
- Keep normal-sized payload behavior unchanged for compatibility fixtures and existing consumers.
- Record the intentional boundary-guardrail compatibility trade-off in required friction/security docs.

**Non-Goals:**
- Replacing JSON transport with a different serialization protocol.
- General host memory accounting beyond bridge/runtime payload validation points.
- Changing driver contracts unrelated to isolate-boundary payload transfer.

## Decisions

### 1. Enforce explicit isolate-boundary transfer limits for base64 file I/O

Decision:
- Introduce secure default limits for maximum inbound/outbound base64 payload bytes.
- Apply the limits in `readFileBinaryRef` and `writeFileBinaryRef` before decoding/encoding large buffers.
- Convert limit violations into deterministic runtime errors returned through existing bridge error channels.

Rationale:
- These paths currently materialize large base64 strings and are direct OOM vectors.
- A single limit contract keeps behavior consistent across read/write transfer directions.

Alternatives considered:
- No fixed limits with host heap tuning only: rejected because it does not provide deterministic safety.
- Driver-specific limits only: rejected because the risk exists before driver delegation.

### 2. Add pre-parse size guards for all isolate-originated JSON payloads

Decision:
- Add a small helper that validates UTF-8 serialized byte length before `JSON.parse`.
- Replace each direct `JSON.parse` on isolate-originated values with the helper across all current parse entry points in `packages/sandboxed-node/src/index.ts`.
- Apply one configurable/default max JSON payload size for consistency and simpler test coverage.

Rationale:
- OOM risk happens before semantic validation, so checks must run before parsing.
- Centralized parsing guard reduces drift across call sites and future additions.

Alternatives considered:
- Per-callsite bespoke checks: rejected due to inconsistency and maintenance risk.
- Streaming JSON parser: deferred; adds complexity not required to remove current OOM vectors.

### 3. Preserve compatibility for normal workloads while documenting intentional guardrails

Decision:
- Keep default limit values high enough for common project-matrix fixtures.
- Expose host-side payload-limit overrides in `NodeProcessOptions` with strict validation and bounded max/min constraints.
- Emit deterministic overflow errors so parity failures are actionable and non-crashing.
- Update friction/security documentation to describe this intentional runtime guardrail where behavior can differ from unconstrained host Node execution.

Rationale:
- The project targets Node semantics, but the runtime must prioritize host safety at the isolate boundary.
- Explicit documentation avoids implicit behavior drift and aligns governance requirements.

Alternatives considered:
- Silent truncation of payloads: rejected because it creates correctness bugs and non-obvious data loss.
- Process-abort on overflow: rejected because deterministic recoverable failure is safer for host orchestration.
- Fully unbounded host overrides: rejected because it can recreate OOM vectors and silently disable security controls.

## Risks / Trade-offs

- [Limits can reject legitimate large transfers] -> Mitigation: choose conservative defaults, provide clear overflow errors, and document tuning/limitations.
- [Missed `JSON.parse` callsite leaves residual OOM path] -> Mitigation: enumerate and patch all current callsites in `index.ts`, plus add regression tests for guarded parsing.
- [Compatibility deviations from host Node for very large payloads] -> Mitigation: document rationale and constraints in friction/security docs and keep failures deterministic.

## Migration Plan

1. Add default boundary size constants, bounded configuration validation, and shared helper utilities in sandboxed-node runtime code.
2. Apply guards to `readFileBinaryRef` and `writeFileBinaryRef` base64 transfer paths.
3. Replace direct isolate-originated `JSON.parse` calls with guarded parsing helper.
4. Add focused tests for overflow rejection, in-range override behavior, and invalid override rejection.
5. Update required documentation artifacts (`docs-internal/friction/sandboxed-node.md`, `docs/security-model.mdx`) with guardrail rationale and behavior.

Rollback:
- Revert guard helpers/constants and restore previous parsing/transfer behavior, acknowledging reintroduced OOM risk.

## Open Questions

- Should overflow failures map to a specific stable exit code in addition to deterministic stderr text?
