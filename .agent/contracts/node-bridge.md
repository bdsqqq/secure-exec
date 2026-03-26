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

### Requirement: Global WebCrypto Surface Matches The `crypto.webcrypto` Bridge
The bridge SHALL expose a single WebCrypto surface so global `crypto` APIs and `require('crypto').webcrypto` share the same object graph and constructor semantics.

#### Scenario: Sandboxed code compares global and module WebCrypto objects
- **WHEN** sandboxed code reads both `globalThis.crypto` and `require('crypto').webcrypto`
- **THEN** those references MUST point at the same WebCrypto object
- **AND** `crypto.subtle` MUST expose the same `SubtleCrypto` instance through both paths

#### Scenario: WebCrypto constructors stay non-user-constructible
- **WHEN** sandboxed code calls `new Crypto()`, `new SubtleCrypto()`, or `new CryptoKey()`
- **THEN** the bridge MUST throw a Node-compatible illegal-constructor `TypeError`
- **AND** prototype method receiver validation MUST reject detached calls with `ERR_INVALID_THIS`

### Requirement: Diffie-Hellman And ECDH Bridge Uses Host Node Crypto Objects
Bridge-provided `crypto` Diffie-Hellman and ECDH APIs SHALL delegate to host `node:crypto` objects so constructor validation, session state, encodings, and shared-secret derivation match Node.js semantics.

#### Scenario: Sandbox creates a Diffie-Hellman session
- **WHEN** sandboxed code calls `crypto.createDiffieHellman(...)`, `crypto.getDiffieHellman(...)`, or `crypto.createECDH(...)`
- **THEN** the bridge MUST construct the corresponding host `node:crypto` object
- **AND** subsequent method calls such as `generateKeys()`, `computeSecret()`, `getPublicKey()`, and `setPrivateKey()` MUST execute against that host object rather than an isolate-local reimplementation

#### Scenario: Sandbox uses stateless crypto.diffieHellman
- **WHEN** sandboxed code calls `crypto.diffieHellman({ privateKey, publicKey })`
- **THEN** the bridge MUST delegate to host `node:crypto.diffieHellman`
- **AND** the returned shared secret and thrown validation errors MUST preserve Node-compatible behavior

### Requirement: Crypto Stream Wrappers Preserve Transform Semantics And Validation Errors
Bridge-backed `crypto` hash and cipher wrappers SHALL remain compatible with Node stream semantics and MUST preserve Node-style validation error codes for callback-driven APIs.

#### Scenario: Sandbox hashes or encrypts data through stream piping
- **WHEN** sandboxed code uses `crypto.Hash`, `crypto.Cipheriv`, or `crypto.Decipheriv` as stream destinations or sources
- **THEN** those objects MUST be `stream.Transform` instances
- **AND** piping data through them MUST emit the same digest or ciphertext/plaintext bytes that the corresponding direct `update()`/`final()` calls would produce

#### Scenario: Sandbox calls pbkdf2 with invalid arguments
- **WHEN** sandboxed code calls `crypto.pbkdf2()` or `crypto.pbkdf2Sync()` with invalid callback, digest, password, salt, iteration, or key length arguments
- **THEN** the bridge MUST throw or surface Node-compatible `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` errors instead of plain untyped exceptions

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

### Requirement: Bridge Boundary Contracts SHALL Be Defined In A Canonical Shared Type Module
Bridge global keys and host/isolate boundary type contracts SHALL be defined in canonical shared type modules — bridge-contract types in `packages/nodejs/src/bridge-contract.ts` and global-exposure helpers in `packages/core/src/shared/global-exposure.ts` — and reused across host runtime setup and bridge modules.

#### Scenario: Host runtime injects bridge globals
- **WHEN** host runtime code wires bridge globals into the isolate
- **THEN** global key names MUST come from the canonical shared bridge contract constants rather than ad-hoc string literals

#### Scenario: Bridge module consumes host bridge globals
- **WHEN** a bridge module declares host-provided bridge globals
- **THEN** declaration shapes MUST reuse canonical shared contract types instead of redefining per-file ad-hoc reference interfaces

### Requirement: Child Process Spawn Routes Through Kernel Command Registry
When a kernel is available, bridge `child_process.spawn` and `child_process.exec` calls from sandboxed code SHALL route through the kernel command registry for command resolution and process lifecycle management.

#### Scenario: Bridge child_process.spawn resolves command through kernel
- **WHEN** sandboxed code calls `child_process.spawn(command, args)` in a kernel-mediated environment
- **THEN** the bridge MUST route the spawn request through `kernel.spawn(command, args, options)`, which resolves the command via the kernel command registry to the appropriate mounted RuntimeDriver

#### Scenario: Bridge child_process.exec routes through kernel shell
- **WHEN** sandboxed code calls `child_process.exec(command)` in a kernel-mediated environment
- **THEN** the bridge MUST route the execution through `kernel.exec(command, options)`, which spawns via the registered shell command (e.g., `sh -c command`)

#### Scenario: Unregistered command fails with command-not-found
- **WHEN** sandboxed code spawns a command that no mounted driver has registered
- **THEN** the bridge MUST propagate the kernel's command-not-found error rather than silently failing or attempting host-side resolution

#### Scenario: Process lifecycle is kernel-managed
- **WHEN** a child process is spawned through the bridge in a kernel-mediated environment
- **THEN** the process MUST be registered in the kernel process table with a PID, and kill/wait operations MUST route through the kernel process table rather than directly to the host OS

### Requirement: Bridge Global Key Registry SHALL Stay Consistent Across Runtime Layers
The bridge global key registry consumed by host runtime setup, bridge modules, and isolate runtime typing declarations SHALL remain consistent and covered by automated verification.

#### Scenario: Bridge key mismatch is introduced
- **WHEN** a change modifies host injection or bridge usage with a mismatched key name
- **THEN** automated verification MUST fail and report the key consistency violation

#### Scenario: New bridge global is introduced
- **WHEN** contributors add a new bridge global used by host/isolate boundary wiring
- **THEN** that global MUST be added to the canonical shared key registry and corresponding shared contract typing in the same change

#### Scenario: Native V8 bridge registries stay aligned with async and sync lifecycle hooks
- **WHEN** bridge modules depend on a host bridge global via async `.apply(..., { result: { promise: true } })` or sync `.applySync(...)` semantics
- **THEN** the native V8 bridge function registries MUST expose a matching callable shape for that global (or an equivalent tested shim), and automated verification MUST cover the registry alignment

### Requirement: Dispatch-Multiplexed Bridge Errors Preserve Structured Metadata
Bridge globals routed through the `_loadPolyfill` dispatch multiplexer SHALL preserve host error metadata needed for Node-compatible assertions.

#### Scenario: Host bridge throws typed crypto validation error
- **WHEN** a dispatch-multiplexed bridge handler throws a host error with `name` and `code` (for example `TypeError` + `ERR_INVALID_ARG_VALUE`)
- **THEN** the sandbox-visible error MUST preserve that `name` and `code`
- **AND** the bridge MUST NOT collapse the error to a plain `Error` with only a message

### Requirement: HTTP Agent Bridge Preserves Node Pooling Semantics
Bridge-provided `http.Agent` behavior SHALL preserve the observable pooling state that Node.js userland and conformance tests inspect.

#### Scenario: Sandboxed code inspects agent bookkeeping
- **WHEN** sandboxed code uses `http.Agent` or `require('_http_agent').Agent`
- **THEN** the bridge MUST expose matching `Agent` constructors through both module paths
- **AND** `getName()`, `requests`, `sockets`, `freeSockets`, and `totalSocketCount` MUST reflect request queueing and socket reuse state with Node-compatible key shapes

#### Scenario: Keepalive sockets are reused or discarded
- **WHEN** sandboxed code enables `keepAlive` and reuses pooled HTTP connections
- **THEN** the bridge MUST mark reused requests via `request.reusedSocket`
- **AND** destroyed or remotely closed sockets MUST be removed from the pool instead of being reassigned to queued requests

#### Scenario: Total socket limits are configured
- **WHEN** sandboxed code constructs an `http.Agent` with `maxSockets`, `maxFreeSockets`, or `maxTotalSockets`
- **THEN** invalid argument types and ranges MUST throw Node-compatible `ERR_INVALID_ARG_TYPE` / `ERR_OUT_OF_RANGE` errors
- **AND** queued requests across origins MUST respect both per-origin and total socket limits
