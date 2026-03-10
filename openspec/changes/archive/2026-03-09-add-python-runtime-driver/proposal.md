## Why

The runtime stack is currently Node-centric and cannot host Python execution without leaking Node assumptions into cross-runtime APIs. We need first-class Python runtime support now so hosts can run Python code with the same safety and permission model used by existing system drivers.

## What Changes

- Add a new Python runtime surface (`PythonRuntime`) with a dedicated driver interface and a concrete Pyodide-based driver implementation.
- Split runtime driver contracts so Node and Python use separate interfaces (`NodeRuntimeDriver` and `PythonRuntimeDriver`) while preserving shared execution-result semantics for `exec()`.
- Keep `SystemDriver` runtime-agnostic and require Python execution to use the same filesystem/network/child-process/env permission gates already enforced by system drivers.
- Define Python `run()` contract as a runtime-neutral structured wrapper (not raw Pyodide-specific objects).
- Keep warm-runtime behavior for Python execution, matching current Node runtime lifecycle expectations.
- Explicitly keep runtime package installation/loading (`micropip`, import-triggered package install) out of scope for this change.

## Capabilities

### New Capabilities
- `python-runtime`: Python runtime API and driver contracts, including Pyodide-backed execution behavior and Python-specific run semantics.

### Modified Capabilities
- `node-runtime`: Runtime-driver architecture and naming/contracts updated to split Node and Python runtime drivers while preserving Node behavior.
- `compatibility-governance`: Runtime-driver test governance expanded so shared `exec()` parity and Python abuse/safety regressions are covered.

## Impact

- Affected code: runtime contracts/types, runtime API exports, driver factories, and new Python runtime/driver modules.
- Affected tests: new Python runtime-driver contract tests and cross-runtime `exec()` parity tests, plus abuse-path regressions for output/memory/CPU amplification.
- Affected docs/specs: architecture overview and runtime specs will add Python runtime components and clarify shared-vs-runtime-specific contracts.
- Dependencies: introduces Pyodide runtime integration for the Python driver implementation.
