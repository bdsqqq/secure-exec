## ADDED Requirements

### Requirement: Isolate Boundary Payload Transfers Are Size-Bounded
Bridge handlers that exchange serialized payloads between isolate and host MUST enforce maximum payload sizes before materializing or decoding untrusted data.

#### Scenario: Oversized binary read payload is rejected before host transfer
- **WHEN** `readFileBinaryRef` would return a base64 payload larger than the configured bridge transfer limit
- **THEN** the bridge MUST reject the request with a deterministic overflow error and MUST NOT return the oversized payload to the isolate

#### Scenario: Oversized binary write payload is rejected before decode
- **WHEN** `writeFileBinaryRef` receives a base64 payload larger than the configured bridge transfer limit
- **THEN** the bridge MUST reject the request before base64 decode and MUST NOT allocate a decoded buffer for the oversized payload

#### Scenario: Base64 transfer checks use encoded payload byte length
- **WHEN** the runtime evaluates payload size for `readFileBinaryRef` or `writeFileBinaryRef`
- **THEN** it MUST measure the serialized base64 payload byte length before decode and enforce limits on that encoded payload

#### Scenario: Bridge transfer uses configured payload limit when provided
- **WHEN** a host configures an in-range base64 transfer payload limit for the runtime
- **THEN** bridge-side `readFileBinaryRef` and `writeFileBinaryRef` enforcement MUST use the configured value instead of the default
