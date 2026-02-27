## RENAMED Requirements

### Requirement: Crypto Is Stub Tier with Insecurity Warning
- FROM: `Crypto Is Stub Tier with Insecurity Warning`
- TO: `Crypto Is Stub Tier with Secure Randomness Contract`

## MODIFIED Requirements

### Requirement: Crypto Is Stub Tier with Secure Randomness Contract
The `crypto` module SHALL be classified as Stub (Tier 3). `getRandomValues()` and `randomUUID()` MUST use host `node:crypto` cryptographically secure randomness when available, and MUST throw deterministic unsupported errors if secure host entropy cannot be obtained. `subtle.*` methods MUST throw unsupported errors.

#### Scenario: Documentation of crypto randomness contract
- **WHEN** a user or contributor reads the crypto section of the compatibility matrix
- **THEN** the entry MUST document host-backed secure randomness behavior for `getRandomValues()`/`randomUUID()` and MUST NOT claim `Math.random()`-backed entropy

#### Scenario: Host entropy unavailable for getRandomValues
- **WHEN** sandboxed code calls `crypto.getRandomValues(array)` and host secure entropy is unavailable
- **THEN** the call MUST throw a deterministic error indicating `crypto.getRandomValues` is not supported in sandbox

#### Scenario: Host entropy unavailable for randomUUID
- **WHEN** sandboxed code calls `crypto.randomUUID()` and host secure entropy is unavailable
- **THEN** the call MUST throw a deterministic error indicating `crypto.randomUUID` is not supported in sandbox

#### Scenario: Calling crypto.subtle.digest
- **WHEN** sandboxed code calls `crypto.subtle.digest("SHA-256", data)`
- **THEN** the call MUST throw an error indicating subtle crypto is not supported in sandbox
