## ADDED Requirements

### Requirement: Runtime Bootstrap MUST Harden Custom Non-Stdlib Globals
Runtime bootstrap paths that expose custom non-stdlib globals into the isolate MUST install those bindings using hardened descriptors (`writable: false`, `configurable: false`) by default.

#### Scenario: Runtime exposes custom import or bridge coordination binding
- **WHEN** runtime setup publishes a custom non-stdlib global used for module loading or bridge coordination
- **THEN** that global binding MUST be non-writable and non-configurable unless explicitly classified as required mutable runtime state

### Requirement: Runtime MUST Maintain Classified Custom-Global Inventory
Runtime and bridge custom non-stdlib globals exposed into the isolate MUST be tracked in a maintained inventory that classifies each global as hardened or intentionally mutable runtime state.

#### Scenario: New custom global exposure is introduced
- **WHEN** a runtime or bridge change introduces a new custom non-stdlib global on `globalThis`
- **THEN** that global MUST be added to the inventory with a classification and rationale in the same change

### Requirement: Runtime Mutable Global State MUST Be Explicitly Classified
Runtime globals that remain mutable for correct execution behavior MUST be explicitly classified as mutable runtime state and MUST NOT be hardened by default.

#### Scenario: Runtime updates per-execution mutable state
- **WHEN** execution setup updates mutable runtime-state globals (for example per-run module or stdin state)
- **THEN** those updates MUST continue to work and the mutable classification for those globals MUST be intentional and documented
