## ADDED Requirements

### Requirement: Global Exposure Hardening Policy MUST Be Documented With Exceptions
Changes that harden isolate global exposure MUST document the policy split between hardened custom globals and compatibility-preserved Node stdlib globals in compatibility/friction artifacts in the same change.

#### Scenario: Custom globals are hardened
- **WHEN** runtime or bridge code applies descriptor hardening to custom globals
- **THEN** documentation MUST identify the hardened global categories and the rationale

#### Scenario: Stdlib globals are intentionally not force-frozen
- **WHEN** stdlib globals remain mutable/configurable for Node compatibility
- **THEN** documentation MUST explicitly record that this is an intentional compatibility decision, not an implementation gap

### Requirement: Descriptor Policy Changes MUST Include Exhaustive Custom-Global Regression Coverage
Any change to global exposure descriptor policy SHALL include exhaustive tests that verify every hardened custom global in the maintained inventory resists overwrite/redefine attempts, while stdlib compatibility behavior remains intact.

#### Scenario: Exhaustive hardened coverage and compatibility paths are tested
- **WHEN** a change updates global descriptor policy
- **THEN** tests MUST cover all hardened custom globals in the inventory and at least one stdlib global compatibility case

#### Scenario: Inventory and test coverage stay in sync
- **WHEN** a new hardened custom global is added to the inventory
- **THEN** the same change MUST add or update tests that assert overwrite/redefine resistance for that global
