## ADDED Requirements

### Requirement: Host-Side Parse Boundaries Protect Runtime Stability
The Node runtime MUST validate isolate-originated serialized payload size before every host-side `JSON.parse` call that consumes isolate-originated data, and MUST fail requests that exceed the configured limit.

#### Scenario: Oversized serialized payload is rejected before parsing
- **WHEN** an isolate-originated payload exceeds the runtime JSON parse size limit
- **THEN** the runtime MUST fail the operation with a deterministic overflow error and MUST NOT call `JSON.parse` on that payload

#### Scenario: All isolate-originated parse entry points are guarded
- **WHEN** host runtime code in `packages/sandboxed-node/src/index.ts` parses isolate-originated JSON payloads for bridged operations
- **THEN** each parse entry point MUST apply the same pre-parse size validation before invoking `JSON.parse`

#### Scenario: In-limit serialized payload preserves existing behavior
- **WHEN** an isolate-originated payload is within the runtime JSON parse size limit and JSON-valid
- **THEN** the runtime MUST parse and process the request using existing bridge/runtime behavior

### Requirement: Boundary Overflow Errors Are Deterministic and Non-Fatal to Host
When boundary payload validation fails for isolate-originated data, runtime behavior MUST produce a deterministic failure contract without crashing the host process.

#### Scenario: Boundary overflow returns stable failure contract
- **WHEN** a base64 transfer or isolate-originated JSON payload exceeds configured runtime limits
- **THEN** execution MUST return a stable error contract for the operation and MUST NOT terminate the host process

### Requirement: Runtime Parse Limits Use UTF-8 Serialized Byte Length
The Node runtime MUST measure isolate-originated JSON payload size using UTF-8 byte length of the serialized JSON text before host-side parsing.

#### Scenario: JSON parse size guard uses UTF-8 byte length
- **WHEN** the runtime evaluates whether isolate-originated JSON input exceeds the parse limit
- **THEN** it MUST compute size from the UTF-8 byte length of the serialized payload string before calling `JSON.parse`

### Requirement: Payload Limits Are Host-Configurable Within Safety Bounds
The Node runtime MUST allow host configuration of isolate-boundary payload limits while enforcing bounded minimum/maximum safety constraints.

#### Scenario: Host configures in-range payload limits
- **WHEN** a host creates `NodeProcess` with payload-limit overrides within runtime safety bounds
- **THEN** the runtime MUST apply those configured limits for base64 transfer and isolate-originated JSON parse checks

#### Scenario: Host configures out-of-range payload limits
- **WHEN** a host provides payload-limit overrides outside runtime safety bounds
- **THEN** `NodeProcess` construction MUST fail with a deterministic validation error and MUST NOT disable payload-size enforcement
