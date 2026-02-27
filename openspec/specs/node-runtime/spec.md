# node-runtime Specification

## Purpose
Define runtime execution contracts, module loading behavior, async completion semantics, and dynamic import behavior.
## Requirements
### Requirement: Unified Sandbox Execution Interface
The project SHALL provide a stable sandbox execution interface for both Node and browser runtimes, with each runtime exposing an `exec` path for running untrusted code and returning structured execution results. The Node runtime SHALL also expose a `run` path that returns module export results (`module.exports` for CommonJS and namespace exports for ESM). Dynamic `import()` expressions within executed code SHALL evaluate lazily at call time rather than eagerly during setup.

#### Scenario: Execute code in Node runtime
- **WHEN** a caller creates `NodeProcess` with a valid driver and invokes `exec`
- **THEN** the sandbox MUST run the provided code in an isolated execution context and return structured output for the caller

#### Scenario: Execute code in browser runtime
- **WHEN** a caller creates `BrowserSandbox` and invokes `exec`
- **THEN** the sandbox MUST execute code in a Worker-backed isolated context and return structured output for the caller

#### Scenario: Run CommonJS module and retrieve exports
- **WHEN** a caller invokes `run()` with CommonJS code that assigns to `module.exports`
- **THEN** the result's `exports` field MUST contain the value assigned to `module.exports`

#### Scenario: Run ESM module and retrieve namespace exports
- **WHEN** a caller invokes `run()` with ESM code that declares named and/or default exports
- **THEN** the result's `exports` field MUST contain an object with all exported bindings, including `default` when declared

#### Scenario: Dynamic imports in executed code evaluate lazily
- **WHEN** a caller invokes `exec` with code containing `import()` expressions
- **THEN** the execution pipeline MUST defer module evaluation until the `import()` expression is reached during code execution, preserving correct side-effect ordering

### Requirement: Driver-Based Capability Composition
Runtime capabilities SHALL be composed through host-provided drivers so filesystem, network, and child-process behavior are controlled by configured adapters rather than hardcoded runtime behavior.

#### Scenario: Node process uses configured adapters
- **WHEN** `NodeProcess` is created with a driver that defines filesystem, network, and command-execution adapters
- **THEN** sandboxed operations MUST route through those adapters for capability access

#### Scenario: Omitted capability remains unavailable
- **WHEN** a capability adapter is omitted from runtime configuration
- **THEN** corresponding sandbox operations MUST be unavailable or denied by the runtime contract

### Requirement: Active Handle Completion for Async Operations
The Node runtime SHALL wait for tracked active handles before finalizing execution results so callback-driven asynchronous work can complete.

#### Scenario: Child process output completes before exec resolves
- **WHEN** sandboxed code starts a child process and registers active-handle lifecycle events
- **THEN** `exec` MUST wait for handle completion before returning final output

### Requirement: Circular-Safe Console Output Capture
The sandbox console capture SHALL handle circular object references without throwing, replacing circular references with a `[Circular]` marker in the serialized output.

#### Scenario: Log object with circular reference
- **WHEN** sandboxed code calls `console.log` with an object that contains a circular reference
- **THEN** the captured stdout MUST contain the serialized object with `[Circular]` substituted for the circular reference, and execution MUST NOT throw

#### Scenario: Log deeply nested circular reference
- **WHEN** sandboxed code calls `console.log` with an object where a circular reference occurs at depth > 1
- **THEN** the captured stdout MUST contain the partially serialized object with `[Circular]` at the circular node

#### Scenario: Log null and undefined values
- **WHEN** sandboxed code calls `console.log` with `null` or `undefined` arguments
- **THEN** the captured stdout MUST contain `"null"` or `"undefined"` respectively, without throwing

#### Scenario: Console error and warn handle circular objects
- **WHEN** sandboxed code calls `console.error` or `console.warn` with a circular object
- **THEN** the captured stderr MUST contain the serialized object with `[Circular]` markers, and execution MUST NOT throw

### Requirement: Bounded Console Serialization Work
Console argument serialization SHALL enforce bounded work for very large or deeply nested payloads by applying depth, key-count, array-length, and output-length limits with deterministic truncation markers.

#### Scenario: Deep object logging is bounded
- **WHEN** sandboxed code logs an object that exceeds the configured depth budget
- **THEN** serialization MUST stop descending past the budget and emit a deterministic depth marker instead of unbounded traversal

#### Scenario: Large object or array logging is bounded
- **WHEN** sandboxed code logs an object/array that exceeds key-count or element-count budgets
- **THEN** serialization MUST truncate beyond the configured limits and emit a deterministic truncation marker

#### Scenario: Oversized output is bounded
- **WHEN** serialized console output exceeds the maximum output-length budget
- **THEN** the captured output MUST be truncated to the configured size with a deterministic suffix marker

### Requirement: Host-to-Sandbox HTTP Verification Path
The Node runtime SHALL expose a host-side request path for sandboxed HTTP servers so loader/host code can verify server behavior externally.

#### Scenario: Host fetches sandbox server endpoint
- **WHEN** sandboxed code starts an HTTP server through the bridged server APIs
- **THEN** host code MUST be able to issue requests through the runtime network facade and receive the sandbox server response

### Requirement: Lazy Evaluation of Dynamic Imports
Dynamically imported modules (`import()`) SHALL be evaluated only when the import expression is reached during user code execution, not during the precompilation phase.

#### Scenario: Side effects execute at import call time
- **WHEN** user code contains `console.log("before"); const m = await import("./side-effect"); console.log("after")` where `./side-effect` logs "side-effect" on evaluation
- **THEN** stdout MUST contain "before", "side-effect", "after" in that order

#### Scenario: Conditional dynamic import skips unused branch
- **WHEN** user code contains `if (false) { await import("./unused"); }` where `./unused` logs "loaded" on evaluation
- **THEN** stdout MUST NOT contain "loaded"

#### Scenario: Repeated dynamic import returns same module without re-evaluation
- **WHEN** user code calls `await import("./mod")` twice, where `./mod` increments a global counter on evaluation
- **THEN** the counter MUST equal 1 after both imports, and both calls MUST return the same module namespace

### Requirement: Precompilation Without Evaluation
The precompilation phase SHALL resolve and compile dynamic import targets but MUST NOT instantiate or evaluate them before user code reaches the corresponding `import()` expression.

#### Scenario: Precompiled module has no side effects before user code
- **WHEN** a module targeted by a static `import("./target")` specifier logs to console on evaluation
- **THEN** no console output from that module SHALL appear before user code begins executing

#### Scenario: Dynamic import side effects preserve surrounding user-code order
- **WHEN** user code logs `before`, awaits `import("./side-effect")`, and then logs `after`, where `./side-effect` logs during evaluation
- **THEN** stdout MUST contain `before`, module side effects, and `after` in that order

### Requirement: Async Dynamic Import Resolution
The `__dynamicImport` bridge function SHALL return a Promise that resolves to the module namespace, performing instantiation and evaluation on demand.

#### Scenario: Dynamic import resolves to module namespace
- **WHEN** user code calls `const m = await import("./mod")` where `./mod` exports `{ value: 42 }` as default
- **THEN** `m.default` MUST equal `{ value: 42 }`

#### Scenario: Dynamic import of non-existent module rejects
- **WHEN** user code calls `await import("./nonexistent")`
- **THEN** the returned Promise MUST reject with an error indicating the module cannot be resolved

### Requirement: Configurable CPU Time Limit for Node Runtime Execution
The Node runtime MUST support an optional `cpuTimeLimitMs` execution budget for sandboxed code and MUST enforce it as a shared per-execution deadline across runtime calls that execute user-controlled code.

#### Scenario: Infinite loop is interrupted by configured CPU limit
- **WHEN** a caller configures `cpuTimeLimitMs` and executes code that does not terminate (for example `while(true){}`)
- **THEN** the runtime MUST interrupt execution once the configured budget is exhausted and return a timeout failure contract

#### Scenario: Shared deadline is enforced across multiple execution phases
- **WHEN** a caller configures `cpuTimeLimitMs` and execution spends time across multiple user-code phases (for example module evaluation plus later active-handle waiting)
- **THEN** the runtime MUST apply one shared budget across phases rather than resetting timeout per phase

#### Scenario: Timeout contract is deterministic
- **WHEN** execution exceeds a configured `cpuTimeLimitMs`
- **THEN** the runtime MUST return `code` `124` and include `CPU time limit exceeded` in stderr

#### Scenario: Unset CPU limit preserves existing runtime behavior
- **WHEN** a caller does not configure `cpuTimeLimitMs`
- **THEN** the runtime MUST preserve existing no-timeout behavior for execution duration control

### Requirement: Isolate Recovery After Timeout
When execution exceeds a configured CPU budget, the runtime MUST recycle isolate state before serving subsequent executions.

#### Scenario: Timeout execution does not leak state into next run
- **WHEN** an execution times out due to `cpuTimeLimitMs`
- **THEN** the next execution on the same `NodeProcess` instance MUST start from a fresh isolate state

### Requirement: Optional Timing Side-Channel Mitigation Profile
The Node runtime MUST provide timing mitigation controls that reduce high-resolution timing signals exposed to sandboxed code, with security-first default behavior.

#### Scenario: Default timing mode freezes execution clocks
- **WHEN** a caller executes code with `timingMitigation` unset
- **THEN** repeated reads of `Date.now()`, `performance.now()`, and `process.hrtime()` within the same execution MUST return deterministic frozen-time values

#### Scenario: Compatibility mode restores Node-like clocks
- **WHEN** a caller executes code with `timingMitigation` set to `"off"`
- **THEN** `Date.now()` and `performance.now()` MUST advance with real execution time semantics

#### Scenario: Default timing mode removes shared-memory timing primitive
- **WHEN** a caller executes code with `timingMitigation` unset
- **THEN** `SharedArrayBuffer` MUST NOT be available on `globalThis`

### Requirement: Package Metadata-Aware Module Classification
The runtime MUST classify JavaScript modules using Node-compatible metadata rules (extension plus nearest `package.json` module type), not source-token heuristics alone.

#### Scenario: .js under type module is treated as ESM
- **WHEN** a package has `package.json` with `"type": "module"` and sandboxed code loads `./index.js`
- **THEN** the runtime MUST evaluate the file as ESM semantics (including `import.meta` availability and ESM export behavior)

#### Scenario: .js under type commonjs is treated as CJS
- **WHEN** a package has `package.json` with `"type": "commonjs"` (or no ESM override) and sandboxed code loads `./index.js` via `require`
- **THEN** the runtime MUST evaluate the file as CommonJS and return `module.exports`

### Requirement: Dynamic Import Error Fidelity
Dynamic `import()` handling MUST preserve Node-like failure behavior by surfacing ESM compile/instantiate/evaluate errors directly and avoiding unintended fallback masking.

#### Scenario: ESM syntax failure rejects without require fallback masking
- **WHEN** user code executes `await import("./broken.mjs")` and `./broken.mjs` contains invalid ESM syntax
- **THEN** the Promise MUST reject with an ESM compile/evaluation error for that module rather than a fallback `require()`-style resolution error

#### Scenario: ESM runtime failure rejects with module error
- **WHEN** user code executes `await import("./throws.mjs")` and the imported module throws during evaluation
- **THEN** the Promise MUST reject with that evaluation failure and MUST NOT re-route to CommonJS fallback

### Requirement: CJS Namespace Shape for Dynamic Import
When dynamic `import()` resolves a CommonJS module, the returned namespace object MUST preserve Node-compatible default semantics for `module.exports` values across object, function, primitive, and null exports.

#### Scenario: Primitive CommonJS export is accessible as default
- **WHEN** sandboxed code executes `await import("./primitive.cjs")` and `primitive.cjs` sets `module.exports = 7`
- **THEN** the namespace result MUST expose `default === 7` without throwing during namespace construction

#### Scenario: Null CommonJS export is accessible as default
- **WHEN** sandboxed code executes `await import("./nullish.cjs")` and `nullish.cjs` sets `module.exports = null`
- **THEN** the namespace result MUST expose `default === null` without throwing during namespace construction

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

### Requirement: Runtime Filesystem Metadata Access Is Driver-Native
Sandbox runtime filesystem metadata operations MUST use driver metadata APIs and MUST NOT derive metadata by reading full file contents.

#### Scenario: Stat call on large file does not require content read
- **WHEN** sandboxed code performs `stat` on a large file path
- **THEN** the runtime MUST resolve metadata via driver `stat` behavior and MUST NOT read the file body to compute size/type

#### Scenario: Exists check uses metadata/access path
- **WHEN** sandboxed code performs an existence check on a file or directory path
- **THEN** the runtime MUST use metadata/access operations and MUST NOT probe existence by loading entire file contents

### Requirement: Runtime Directory Type Enumeration Avoids Per-Entry Re-Probing
When sandboxed code requests directory entries with type information, the runtime MUST return type metadata from one directory traversal and MUST NOT perform an additional directory probe per entry.

#### Scenario: Mixed directory listing returns types without N+1 probes
- **WHEN** a directory contains both files and subdirectories and sandboxed code requests typed entries
- **THEN** the runtime MUST return each entry with correct `isDirectory` information without issuing per-entry `readDir` probes

### Requirement: Runtime Rename Delegates to Driver Rename Semantics
Runtime rename behavior MUST delegate to the active driver `rename` operation and MUST NOT emulate rename with copy-write-delete in the default runtime path.

#### Scenario: Atomic rename path is preserved when supported
- **WHEN** the active driver supports atomic rename semantics
- **THEN** sandboxed `rename` MUST complete through that atomic driver operation

#### Scenario: Unsupported atomic rename is explicit and deterministic
- **WHEN** the active driver cannot provide atomic rename semantics
- **THEN** the runtime MUST expose deterministic documented behavior for that driver and MUST NOT silently perform copy-write-delete emulation as if it were atomic

