## ADDED Requirements

### Requirement: Filesystem Metadata and Rename Deviations Must Be Documented
Any intentional deviation from default Node.js behavior for filesystem metadata access patterns or rename atomicity MUST be documented in compatibility/friction artifacts in the same change.

#### Scenario: Driver cannot provide atomic rename semantics
- **WHEN** a runtime/driver path cannot satisfy Node-like atomic rename behavior
- **THEN** `docs-internal/friction/sandboxed-node.md` MUST record the limitation and supported behavior contract in the same change

#### Scenario: Metadata behavior intentionally differs from Node expectations
- **WHEN** filesystem metadata behavior diverges from default Node semantics for performance or platform constraints
- **THEN** compatibility documentation MUST explicitly describe the divergence and mitigation/expected impact

### Requirement: Compatibility Matrix Coverage Is Updated for Filesystem Semantics Changes
Changes to runtime or bridge filesystem metadata/rename behavior SHALL update compatibility project-matrix coverage with black-box fixtures that compare host Node and sandboxed-node normalized outputs.

#### Scenario: Metadata behavior change is implemented
- **WHEN** a change modifies `stat`, `exists`, typed `readdir`, or rename semantics in sandboxed-node
- **THEN** the compatibility project-matrix MUST include fixture coverage that exercises the changed behavior under host Node and sandboxed-node comparison
