# node-bridge Specification

## Purpose
Define bridge boundary policy, third-party module boundaries, and capability expansion controls.
## Requirements
### Requirement: Bridge Scope Is Node Built-ins Only
Bridge implementations injected into isolated-vm MUST be limited to Node.js built-in modules and types compatible with `@types/node`.

#### Scenario: Bridge request targets a third-party package
- **WHEN** a proposed bridge module is not a Node.js built-in
- **THEN** the change MUST be rejected from the bridge layer and handled through normal sandboxed package resolution

### Requirement: Third-Party Modules Resolve from Sandboxed Dependencies
Third-party npm packages SHALL execute from sandboxed `node_modules` using normal runtime/module resolution behavior rather than bridge shims.

#### Scenario: Sandboxed app imports third-party server package
- **WHEN** sandboxed code imports a third-party package such as `@hono/node-server`
- **THEN** the package MUST resolve from sandboxed dependencies and MUST NOT rely on a host bridge shim for its primary runtime behavior

### Requirement: Capability Expansion Requires Explicit Approval
No new sandbox capability or host-exposed functionality MAY be added without explicit user approval and an agreed implementation plan, and implementation MUST pause until that approval is recorded.

#### Scenario: Change proposes new host-exposed API
- **WHEN** a proposal introduces a new sandbox capability beyond the current approved surface
- **THEN** implementation MUST pause until explicit approval and plan agreement are recorded

### Requirement: Active-Handle Bridge Globals Are Immutable
Bridge lifecycle globals used for active-handle tracking (`_registerHandle`, `_unregisterHandle`, `_waitForActiveHandles`) MUST be installed on `globalThis` as non-writable and non-configurable properties so sandbox code cannot replace runtime lifecycle hooks.

#### Scenario: Sandbox attempts to overwrite active-handle lifecycle hook
- **WHEN** sandboxed code assigns a new value to one of the active-handle lifecycle globals
- **THEN** the original bridge lifecycle function MUST remain installed and property descriptors MUST report `writable: false` and `configurable: false`

### Requirement: Prefer Standard Polyfills Over Custom Reimplementation
When a Node built-in compatibility layer exists in `node-stdlib-browser`, the project SHALL use that polyfill instead of introducing a custom replacement, unless a documented exception is approved.

#### Scenario: New built-in compatibility need is identified
- **WHEN** a Node built-in module requires browser/runtime compatibility support
- **THEN** maintainers MUST evaluate `node-stdlib-browser` first and only add custom behavior for explicitly documented gaps

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

### Requirement: Cryptographic Randomness Bridge Uses Host CSPRNG
Bridge-provided randomness for global `crypto` APIs MUST delegate to host `node:crypto` primitives and MUST NOT use isolate-local pseudo-random fallbacks such as `Math.random()`.

#### Scenario: getRandomValues uses host entropy
- **WHEN** sandboxed code calls `crypto.getRandomValues(typedArray)`
- **THEN** the bridge MUST fill the provided view using host cryptographic entropy equivalent to `node:crypto.randomFillSync`

#### Scenario: randomUUID uses host UUID generation
- **WHEN** sandboxed code calls `crypto.randomUUID()`
- **THEN** the bridge MUST return a UUID value generated by host `node:crypto` semantics

#### Scenario: Host entropy is unavailable
- **WHEN** host `node:crypto` randomness primitives are unavailable or fail
- **THEN** the bridge MUST throw a deterministic error matching the unsupported API format (`"<module>.<api> is not supported in sandbox"`) for the invoked randomness API and MUST NOT fall back to non-cryptographic randomness

### Requirement: Bridge FS Open Flag Translation Uses Named Constants
The bridge `fs` implementation MUST express string-flag translation using named open-flag constants (for example `O_WRONLY | O_CREAT | O_TRUNC`) aligned with Node `fs.constants` semantics, and MUST NOT rely on undocumented numeric literals.

#### Scenario: Write-truncate flags are composed from constants
- **WHEN** the bridge parses open flag strings such as `"w"` or `"w+"`
- **THEN** resulting numeric modes MUST be produced from named constant composition rather than hardcoded integers

#### Scenario: Append-exclusive flags remain deterministic
- **WHEN** the bridge parses append/exclusive flags such as `"ax"` and `"ax+"`
- **THEN** the bridge MUST return deterministic Node-compatible numeric modes and preserve existing error behavior for unknown flags

### Requirement: Bridge Filesystem Metadata Calls Preserve Metadata-Only Semantics
Bridge-exposed filesystem metadata calls (`exists`, `stat`, and typed directory listing paths) MUST preserve metadata-only semantics and MUST NOT trigger file-content reads solely to determine type or existence.

#### Scenario: Bridge stat does not read file body for metadata
- **WHEN** sandboxed code calls bridge `fs.stat` for a file path
- **THEN** bridge handling MUST obtain metadata without loading the file body into memory

#### Scenario: Bridge typed readdir avoids per-entry directory probing
- **WHEN** sandboxed code calls bridge `readdir` with typed entry expectations
- **THEN** bridge handling MUST return entry type information without a repeated `readDir` probe for each entry

