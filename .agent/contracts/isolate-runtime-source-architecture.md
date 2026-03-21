# isolate-runtime-source-architecture Specification

## Purpose
TBD - created by archiving change harden-isolate-runtime-typing-and-layout. Update Purpose after archive.
## Requirements
### Requirement: Isolate Runtime Source Layout Separates Inject Entrypoints and Shared Modules
The isolate-runtime source tree SHALL organize host-injected entry scripts under `packages/core/isolate-runtime/src/inject/` and shared reusable modules under `packages/core/isolate-runtime/src/common/`.

#### Scenario: Existing inject sources are migrated to canonical layout
- **WHEN** isolate-runtime injection sources are maintained or refactored
- **THEN** entry scripts evaluated by host runtime MUST live under `packages/core/isolate-runtime/src/inject/` and shared helpers/types MUST live under `packages/core/isolate-runtime/src/common/`

#### Scenario: New isolate injection source is added
- **WHEN** contributors introduce a new host-to-isolate injected script
- **THEN** the source file MUST be added under `packages/core/isolate-runtime/src/inject/` and MUST NOT be placed in legacy flat isolate-runtime paths

### Requirement: Inject Entrypoints SHALL Compile as Standalone Runtime Artifacts
Inject entrypoint files SHALL be compiled into standalone executable source payloads suitable for host runtime injection, including any shared code imported from `src/common`.

#### Scenario: Inject entrypoint imports shared common helper
- **WHEN** an inject file imports code from `isolate-runtime/src/common/`
- **THEN** the build output consumed by runtime injection MUST remain executable without requiring an isolate-side module loader

#### Scenario: Manifest generation enumerates inject entrypoints
- **WHEN** isolate-runtime manifest generation runs
- **THEN** it MUST use `src/inject` as the source-of-truth entrypoint set and emit those compiled sources to runtime-consumable manifest IDs

### Requirement: Isolate Runtime Global Contracts SHALL Be Explicitly Typed
Inject runtime code SHALL consume explicit global contracts for host-injected runtime globals and MUST avoid broad `Record<string, unknown>` global casting patterns except where values are intentionally unconstrained at trust boundaries.

#### Scenario: Runtime global slot access in inject source
- **WHEN** inject source reads or writes a known runtime global slot
- **THEN** it MUST use an explicit typed global contract instead of casting `globalThis` to `Record<string, unknown>`

#### Scenario: Boundary values remain intentionally unconstrained
- **WHEN** inject/runtime code handles intentionally unconstrained values (for example dynamic module exports or generic value serialization)
- **THEN** boundary-safe `unknown` typing MAY remain where narrowing would change behavior assumptions

