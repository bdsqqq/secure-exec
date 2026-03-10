## Context

`secure-exec` runtime architecture is currently optimized for Node-oriented execution drivers and contracts. The current runtime driver naming and shape make Python support ambiguous, while host-facing orchestration needs a stable `exec()` contract across runtimes.

This change introduces an explicit Python runtime path using a Pyodide-backed driver while keeping `SystemDriver` generic and preserving existing permission enforcement behavior. The design must keep warm runtime lifecycle semantics and avoid memory/CPU amplification regressions.

## Goals / Non-Goals

**Goals:**
- Split runtime-driver interfaces into runtime-specific contracts (`NodeRuntimeDriver`, `PythonRuntimeDriver`) while preserving a shared execution result contract for `exec()`.
- Add `PythonRuntime` as a user-facing API and implement a concrete Pyodide-backed Python driver.
- Keep `SystemDriver` runtime-agnostic and reuse existing permissions (`fs`, `network`, `childProcess`, `env`) for Python execution.
- Define a generic Python `run()` result wrapper that does not expose raw Pyodide-specific objects.
- Keep warm-runtime behavior for Python execution on a single runtime instance.
- Add explicit abuse-path coverage (high-volume output and timeout paths).

**Non-Goals:**
- Dynamic runtime package installation/loading (`micropip`, import-triggered package install) behavior.
- Non-Pyodide Python backends (for example host subprocess CPython).
- Full parity between Node `run()` and Python `run()` result semantics.

## Decisions

1. Introduce runtime-specific driver interfaces with a shared execution base contract.
- Decision: Define separate `NodeRuntimeDriver` and `PythonRuntimeDriver` interfaces, plus a shared `exec` lifecycle contract (`exec`, `dispose`, `terminate`).
- Rationale: Prevent Node-only and Python-only concerns from leaking into each other while keeping host orchestration uniform.
- Alternative considered: Keep one generic runtime-driver interface with optional runtime-specific methods. Rejected because it grows ambiguous and weakens type-level guarantees.

2. Keep `SystemDriver` capability-owned and runtime-neutral.
- Decision: `SystemDriver` remains the single capability/permission boundary for both runtimes.
- Rationale: Preserves deny-by-default behavior and avoids runtime-specific capability duplication.
- Alternative considered: Add Python-only capability adapters to `SystemDriver`. Rejected for now to avoid premature surface expansion.

3. Standardize `exec()` parity across Node and Python runtimes.
- Decision: Node and Python `exec()` return the same base result semantics (`code`, `errorMessage`, timeout/cancel expectations).
- Rationale: Enables runtime-agnostic host orchestration and simpler control planes.
- Alternative considered: Runtime-specific `exec()` contracts. Rejected due to host branching and governance complexity.

4. Define Python `run()` as a generic structured wrapper.
- Decision: `PythonRuntime.run()` returns a structured Python run result wrapper (for example value plus optional selected bindings), not raw Pyodide proxies.
- Rationale: Keeps API portable and avoids runtime-specific memory/lifecycle leaks through public contracts.
- Alternative considered: Return raw Pyodide values/proxies. Rejected because it couples API consumers to one backend and increases leak risk.

5. Keep Python runtime warm by default per instance.
- Decision: Consecutive Python executions on the same `PythonRuntime` share runtime state unless explicitly disposed/terminated.
- Rationale: Matches current runtime lifecycle expectations and improves performance.
- Alternative considered: Fresh interpreter per execution. Rejected for now due to startup overhead and changed semantics.

6. Keep package installation/loading out of scope for this change.
- Decision: Python runtime package installation/loading APIs are not enabled in this change and MUST fail deterministically when invoked.
- Rationale: Reduces initial attack surface and keeps scope focused on core runtime contracts.
- Alternative considered: Enable package loading behind permissions in v1. Rejected to avoid mixing supply-chain policy with foundational runtime split.

## Risks / Trade-offs

- [Risk] Warm Python state can leak data across executions on the same instance. → Mitigation: document lifecycle clearly and provide deterministic `dispose`/`terminate` behavior.
- [Risk] High-volume Python stdout/stderr can amplify host memory/CPU if buffered. → Mitigation: enforce streaming-only output behavior and add exploit-oriented high-volume tests.
- [Risk] Timeout/cancellation semantics can drift between Node and Python drivers. → Mitigation: codify shared `exec()` parity requirements and cross-runtime contract suites.
- [Risk] API overfitting to Pyodide backend details. → Mitigation: keep Python runtime public contracts backend-neutral and block direct Pyodide proxy exposure.

## Migration Plan

1. Add new runtime-driver interfaces and type aliases with backwards-compatible export strategy where possible.
2. Introduce `PythonRuntime` and `PyodideRuntimeDriver` behind additive API exports.
3. Update Node runtime wiring to use renamed Node-specific driver interface without behavior regressions.
4. Add shared/runtime-specific contract tests and abuse-path regressions.
5. Update architecture/docs to include Python runtime components and contracts.

## Open Questions

- Do we need a first-class explicit reset API for warm Python runtime instances in this change or follow-up?
- Should timeout error text be strictly identical across runtimes or only semantically equivalent under shared `ExecResult` fields?
