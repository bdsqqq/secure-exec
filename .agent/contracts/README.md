# Contracts

Behavioral contracts for secure-exec. These are the source of truth for runtime, bridge, permissions, stdlib, and governance requirements.

## How contracts work

- Contracts define **what the system must do** using Requirement/Scenario/WHEN/THEN format
- Agents MUST read relevant contracts before implementing changes in contracted areas
- When a change modifies contracted behavior, the relevant contract MUST be updated in the same PR
- Any intentional deviation from Node.js behavior MUST be documented in the relevant contract
- Contracts are reviewed as part of normal PR review — contract changes are code changes

## Contract index

| Contract | Scope |
|----------|-------|
| [node-runtime](node-runtime.md) | Runtime execution, module loading, async completion, dynamic imports, CPU limits, timing mitigation, payload limits, logging, kernel-mediated execution model |
| [node-bridge](node-bridge.md) | Bridge boundary policy, built-in scope, capability expansion, immutable globals, crypto randomness, kernel command registry routing for child_process |
| [node-stdlib](node-stdlib.md) | Module support tiers, builtin resolution, polyfill patches, deterministic errors |
| [node-permissions](node-permissions.md) | Deny-by-default permissions, permission helpers, projected node_modules read-only, kernel-level permission interaction |
| [compatibility-governance](compatibility-governance.md) | Documentation maintenance, compatibility matrix, friction log, test coverage obligations, cross-runtime parity requirements |
| [typescript-tools](typescript-tools.md) | Companion TypeScript tooling package contracts |
| [documentation-site](documentation-site.md) | Docs site page requirements and content contracts |
| [isolate-runtime-source-architecture](isolate-runtime-source-architecture.md) | Isolate runtime source layout and compilation contracts |
| [runtime-driver-integration-testing](runtime-driver-integration-testing.md) | Runtime-agnostic test suites, TestContext, target enumeration, kernel-aware TestContext, cross-runtime test infrastructure |
| [runtime-driver-test-suite-structure](runtime-driver-test-suite-structure.md) | Canonical test layout, shared suite execution, kernel unit test patterns, cross-runtime integration test layout |
| [kernel](kernel.md) | VFS semantics, FD table lifecycle, process table management, device layer intercepts, pipe manager blocking/EOF, command registry resolution, permission deny-by-default wrapping |
| [kernel-runtime-driver](kernel-runtime-driver.md) | RuntimeDriver interface lifecycle, command registration rules, ProcessContext requirements, DriverProcess exit/kill/stdio contract, kernel spawn/exec orchestration |
