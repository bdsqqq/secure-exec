## ADDED Requirements

### Requirement: Python Runtime API and Driver Contract
The project SHALL expose a user-facing `PythonRuntime` API backed by a runtime-specific `PythonRuntimeDriver` interface.

#### Scenario: Python runtime executes through a Python runtime driver
- **WHEN** a caller creates `PythonRuntime` with a valid `SystemDriver` and a `PythonRuntimeDriver`
- **THEN** `exec` and `run` operations MUST delegate execution to that Python runtime driver contract

### Requirement: Python Runtime Uses Pyodide Driver Implementation
The project SHALL provide a concrete Pyodide-based implementation of `PythonRuntimeDriver`.

#### Scenario: Pyodide driver executes basic Python code
- **WHEN** a caller executes `PythonRuntime.exec("print('ok')")` through the default Python runtime-driver implementation
- **THEN** execution MUST run in a Pyodide-backed runtime and return the shared execution result contract

### Requirement: Python Exec Contract Matches Shared Runtime Semantics
`PythonRuntime.exec()` SHALL use the shared runtime execution result semantics used by Node runtime execution.

#### Scenario: Successful Python exec returns success status
- **WHEN** Python code executes without unhandled errors
- **THEN** `exec()` MUST return `code: 0` and MUST NOT set `errorMessage`

#### Scenario: Python exec failure returns deterministic error status
- **WHEN** Python code raises an unhandled exception
- **THEN** `exec()` MUST return non-zero `code` and MUST include deterministic `errorMessage` text

#### Scenario: Python exec timeout returns deterministic timeout contract
- **WHEN** Python execution exceeds configured CPU time budget
- **THEN** `exec()` MUST return the runtime timeout contract shared by runtime execution interfaces

### Requirement: Python Run Result Is Backend-Neutral Structured Data
`PythonRuntime.run()` SHALL return a structured Python run-result wrapper and MUST NOT expose backend-specific runtime objects directly.

#### Scenario: Python run returns structured wrapper
- **WHEN** a caller invokes `PythonRuntime.run()`
- **THEN** the returned value MUST be a structured wrapper contract defined by Python runtime types rather than a raw backend proxy object

### Requirement: Python Runtime Reuses SystemDriver Capability Gates
Python runtime capability access SHALL be enforced through the configured `SystemDriver` adapters and permission checks.

#### Scenario: Python filesystem access is denied by default without fs permission
- **WHEN** Python code attempts filesystem access and `permissions.fs` does not allow it
- **THEN** the operation MUST be denied under the same deny-by-default permission model used by Node runtime execution

#### Scenario: Python network access is denied by default without network permission
- **WHEN** Python code attempts network access and `permissions.network` does not allow it
- **THEN** the operation MUST be denied under the same deny-by-default permission model used by Node runtime execution

### Requirement: Python Runtime Keeps Warm State Per Runtime Instance
Python runtime instances SHALL preserve interpreter state across consecutive executions until disposed or terminated.

#### Scenario: Consecutive runs reuse in-memory state
- **WHEN** code in one Python runtime execution mutates runtime global/interpreter state and a second execution runs on the same `PythonRuntime` instance
- **THEN** the second execution MUST observe the prior state unless the runtime has been disposed or terminated

### Requirement: Python Package Installation Is Out Of Scope For This Change
Python runtime package installation/loading flows are out of scope and MUST NOT be enabled by this change.

#### Scenario: Runtime package installation API is invoked
- **WHEN** caller code attempts to invoke runtime package-install/load pathways in this change scope
- **THEN** runtime behavior MUST fail with a deterministic unsupported contract rather than performing installation/loading

### Requirement: Python Output Paths Must Avoid Unbounded Host Buffering
Python runtime logging/stdio handling SHALL avoid unbounded host-memory accumulation during execution.

#### Scenario: High-volume Python output does not accumulate unbounded result buffers
- **WHEN** Python code emits high-volume stdout/stderr data
- **THEN** runtime handling MUST use bounded/streaming behavior and MUST NOT retain unbounded output buffers in execution results
