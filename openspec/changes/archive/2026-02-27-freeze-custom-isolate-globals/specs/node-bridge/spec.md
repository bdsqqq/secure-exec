## ADDED Requirements

### Requirement: Bridge Custom Globals MUST Be Immutable By Default
Bridge-defined custom globals that expose runtime control-plane behavior (for example dispatch hooks, bridge module handles, and lifecycle helpers) MUST be installed on `globalThis` with `writable: false` and `configurable: false` unless explicitly classified as required mutable runtime state.

#### Scenario: Bridge installs custom dispatch global
- **WHEN** the bridge exposes a non-stdlib dispatch/global hook used by runtime-host coordination
- **THEN** the property descriptor for that global MUST report `writable: false` and `configurable: false`

#### Scenario: Sandbox attempts to replace hardened bridge global
- **WHEN** sandboxed code assigns a new value to a hardened custom bridge global
- **THEN** the original bridge binding MUST remain installed

#### Scenario: Hardened bridge globals are fully enumerated
- **WHEN** bridge code exposes hardened custom globals
- **THEN** every hardened bridge global MUST be represented in the maintained custom-global inventory used for exhaustive descriptor regression tests

### Requirement: Node Stdlib Global Exposure MUST Preserve Compatibility Semantics
This hardening policy MUST NOT force Node stdlib globals to non-writable/non-configurable descriptors solely because they are globally exposed.

#### Scenario: Bridge exposes stdlib-compatible global
- **WHEN** bridge setup exposes a Node stdlib global surface (for example `process`, timers, `Buffer`, `URL`, `fetch`, or `console`)
- **THEN** the bridge MUST preserve Node-compatible behavior and MUST NOT require non-writable/non-configurable descriptors for that stdlib global due to this policy alone
