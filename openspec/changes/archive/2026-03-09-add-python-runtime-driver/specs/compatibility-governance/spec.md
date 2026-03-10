## ADDED Requirements

### Requirement: Python Runtime Driver Changes MUST Validate Shared Runtime Contracts
Any change that introduces or modifies Python runtime-driver behavior MUST validate shared execution contracts and Python-specific runtime-driver suites.

#### Scenario: Python runtime contract change triggers shared and Python runtime-driver suites
- **WHEN** a change modifies Python runtime contracts or Python runtime-driver behavior under `packages/secure-exec/src/python/**`, `src/runtime.ts`, or shared runtime driver types
- **THEN** the change MUST run `pnpm --filter secure-exec vitest --run tests/test-suite.test.ts tests/test-suite-python.test.ts` and `pnpm --filter secure-exec vitest --run tests/runtime-driver/python.test.ts`

#### Scenario: Python execution behavior change triggers Python exec behavior suites
- **WHEN** a change modifies Python execution behavior or Python execution suites under `packages/secure-exec/tests/test-suite/`
- **THEN** the change MUST run `pnpm --filter secure-exec vitest --run tests/test-suite-python.test.ts`

### Requirement: Cross-Runtime Exec Parity Must Be Regression-Tested
Changes that affect shared execution result semantics SHALL preserve Node/Python `exec()` parity for host-facing result contracts.

#### Scenario: Shared exec result semantics change
- **WHEN** a change modifies shared execution result fields or timeout/error contract behavior
- **THEN** the change MUST include or update tests that verify Node and Python runtimes return the same base `exec()` contract semantics

### Requirement: Python Runtime Changes MUST Include Abuse-Path Coverage
Python runtime changes SHALL include exploit-oriented regression coverage for memory and CPU amplification paths.

#### Scenario: High-volume stdout/stderr path is modified
- **WHEN** Python runtime logging/stdio handling changes
- **THEN** tests MUST verify high-volume output does not create unbounded host-memory accumulation

#### Scenario: Timeout enforcement path is modified
- **WHEN** Python runtime CPU limit enforcement behavior changes
- **THEN** tests MUST verify deterministic timeout contract behavior and runtime recovery expectations
