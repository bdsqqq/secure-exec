## MODIFIED Requirements

### Requirement: Unified Sandbox Execution Interface
The project SHALL provide a stable sandbox execution interface for both Node and browser runtimes, with each runtime exposing an `exec` path for running untrusted code and returning structured execution results. The Node runtime SHALL also expose a `run` path that returns module export results (`module.exports` for CommonJS and namespace exports for ESM). Dynamic `import()` expressions within executed code SHALL evaluate lazily at call time rather than eagerly during setup.

#### Scenario: Execute code in Node runtime
- **WHEN** a caller creates `NodeProcess` with a valid driver and invokes `exec`
- **THEN** the sandbox MUST run the provided code in an isolated execution context and return structured output for the caller

#### Scenario: Execute code in browser runtime
- **WHEN** a caller creates `BrowserSandbox` and invokes `exec`
- **THEN** the sandbox MUST execute code in a Worker-backed isolated context and return structured output for the caller

#### Scenario: Run CommonJS module and retrieve exports
- **WHEN** a caller invokes `run()` with CommonJS code that assigns to `module.exports`
- **THEN** the result's `exports` field MUST contain the value assigned to `module.exports`

#### Scenario: Run ESM module and retrieve namespace exports
- **WHEN** a caller invokes `run()` with ESM code that declares named and/or default exports
- **THEN** the result's `exports` field MUST contain an object with all exported bindings, including `default` when declared

#### Scenario: Dynamic imports in executed code evaluate lazily
- **WHEN** a caller invokes `exec` with code containing `import()` expressions
- **THEN** the execution pipeline MUST defer module evaluation until the `import()` expression is reached during code execution, preserving correct side-effect ordering

### Requirement: Precompilation Without Evaluation
The precompilation phase SHALL resolve and compile dynamic import targets but MUST NOT instantiate or evaluate them before user code reaches the corresponding `import()` expression.

#### Scenario: Precompiled module has no side effects before user code
- **WHEN** a module targeted by a static `import("./target")` specifier logs to console on evaluation
- **THEN** no console output from that module SHALL appear before user code begins executing

#### Scenario: Dynamic import side effects preserve surrounding user-code order
- **WHEN** user code logs `before`, awaits `import("./side-effect")`, and then logs `after`, where `./side-effect` logs during evaluation
- **THEN** stdout MUST contain `before`, module side effects, and `after` in that order
