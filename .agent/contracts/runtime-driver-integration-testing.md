# runtime-driver-integration-testing Specification

## Purpose
Define runtime-driver integration testing contracts, including runtime-target-agnostic suites, kernel-aware test infrastructure, and cross-runtime test orchestration.
## Requirements
### Requirement: Integration Suites SHALL Be Runtime-Target Agnostic
Integration runtime-contract tests SHALL be authored as reusable suites that accept a class-based test context and can execute against different runtime-driver targets.

#### Scenario: Suite exports run function over test context
- **WHEN** a runtime integration suite is added under the integration test directory
- **THEN** it MUST export a `run*` function that accepts a `TestContext` instance and defines its assertions through that context

#### Scenario: Same suite executes for node and browser targets
- **WHEN** integration orchestration runs runtime-contract suites
- **THEN** each shared `run*` suite MUST execute once for `node` and once for `browser` targets

### Requirement: TestContext Class SHALL Encapsulate Target-Specific Runtime Setup
A `TestContext` class SHALL provide target-specific setup/teardown helpers while exposing a common runtime-construction contract to reusable suites.

#### Scenario: Node target context provisions Node drivers
- **WHEN** the integration orchestrator requests a `TestContext` for target `node`
- **THEN** context setup MUST provide Node-target system/runtime drivers compatible with `NodeRuntime`

#### Scenario: Browser target context provisions browser drivers
- **WHEN** the integration orchestrator requests a `TestContext` for target `browser`
- **THEN** context setup MUST provide browser-target system/runtime drivers compatible with `NodeRuntime`

### Requirement: Integration Orchestrator SHALL Enumerate Targets In One Entrypoint
The integration test entrypoint SHALL enumerate supported runtime targets and invoke all shared suites under per-target `describe` grouping.

#### Scenario: Target loop invokes shared suites
- **WHEN** integration tests execute
- **THEN** the orchestrator MUST iterate runtime targets and invoke all registered `run*` suites within each target's test group

### Requirement: Kernel-Aware TestContext SHALL Support Mounted Drivers
Test infrastructure SHALL support a kernel-aware `TestContext` variant that provisions a kernel with mounted RuntimeDrivers, enabling cross-runtime integration tests that exercise kernel-mediated execution.

#### Scenario: Kernel TestContext provisions kernel with mounted drivers
- **WHEN** the integration orchestrator requests a kernel-aware TestContext
- **THEN** the context MUST create a kernel instance, mount the specified RuntimeDrivers (e.g., Node, WasmVM, Python), and expose `kernel.spawn()` and `kernel.exec()` for test assertions

#### Scenario: Kernel TestContext provides shared VFS and process table
- **WHEN** tests execute within a kernel-aware TestContext
- **THEN** all mounted drivers MUST share the same kernel VFS, FD table, process table, and pipe manager, enabling cross-runtime interaction assertions

#### Scenario: Kernel TestContext disposes kernel on teardown
- **WHEN** a kernel-aware test completes
- **THEN** the TestContext MUST call `kernel.dispose()` to release all driver resources and terminate running processes

#### Scenario: MockRuntimeDriver enables isolated kernel unit testing
- **WHEN** kernel unit tests need to validate kernel behavior without real runtime overhead
- **THEN** tests MUST be able to use a MockRuntimeDriver that implements the RuntimeDriver interface with controllable spawn/exit behavior

### Requirement: Cross-Runtime Integration Tests SHALL Live Under Kernel Test Directory
Cross-runtime integration tests that exercise kernel-mediated multi-driver scenarios SHALL live under `packages/secure-exec/tests/kernel/` to distinguish them from single-driver test suites.

#### Scenario: Cross-runtime pipe tests reference kernel test directory
- **WHEN** integration tests validate data flow between processes in different RuntimeDrivers (e.g., WasmVM piped to Node)
- **THEN** those tests MUST reside under `packages/secure-exec/tests/kernel/` and use the kernel-aware TestContext

#### Scenario: Kernel-specific integration tests do not duplicate shared suite tests
- **WHEN** kernel integration tests are added under `packages/secure-exec/tests/kernel/`
- **THEN** they MUST test kernel-mediated multi-driver behavior that cannot be expressed through single-driver shared suites, and MUST NOT duplicate coverage already provided by `packages/secure-exec/tests/test-suite/`

