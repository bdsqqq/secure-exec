## ADDED Requirements

### Requirement: Isolate Boundary Payload Limits Are Explicitly Documented
Any change that introduces or modifies isolate-boundary payload size limits MUST document the compatibility and security rationale in canonical project documentation.

#### Scenario: Boundary limit contract changes
- **WHEN** runtime or bridge payload-size limits are introduced or changed for isolate-originated data
- **THEN** `docs-internal/friction/sandboxed-node.md` MUST be updated with the behavior change, rationale, and resolution notes

#### Scenario: Security model reflects boundary guardrails
- **WHEN** isolate-boundary payload limits are introduced or changed
- **THEN** `docs/security-model.mdx` MUST describe the boundary guardrail, deterministic overflow behavior, and compatibility trade-off against unconstrained host Node behavior
