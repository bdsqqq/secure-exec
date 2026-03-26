# Architecture Overview

## Architectural Model: Inverted VM

Traditional virtual machines (Firecracker, QEMU) place the OS **inside** the VM — a hypervisor
virtualizes hardware, and a guest kernel (Linux) runs on top:

```
Traditional:  VM contains OS

  ┌────────────────────┐
  │  Hypervisor / VM   │  (Firecracker, QEMU, KVM)
  │                    │
  │  ┌──────────────┐  │
  │  │   Guest OS   │  │  (Linux kernel)
  │  │              │  │
  │  │  ┌────────┐  │  │
  │  │  │  Apps  │  │  │  (ELF binaries)
  │  │  └────────┘  │  │
  │  └──────────────┘  │
  └────────────────────┘
```

Secure Exec inverts this: the OS is the **outer** layer, and execution engines (V8, WASM) are
plugged **into** it. The kernel runs in the host process and mediates all I/O. There is no
hypervisor — the isolation boundary is the V8 isolate and WASM sandbox, not hardware virtualization:

```
Secure Exec:  OS contains VMs

  ┌──────────────────────────────────────────────┐
  │  Virtual OS  (packages/core/kernel/)          │
  │  VFS, process table, FD table,                │
  │  sockets, pipes, signals, permissions         │
  │                                               │
  │  ┌─────────────────┐  ┌───────────────────┐   │
  │  │   V8 Isolate    │  │   WASM Runtime    │   │
  │  │   (Node.js)     │  │   (V8 WebAssembly)│   │
  │  │                 │  │                   │   │
  │  │   JS scripts    │  │   POSIX binaries  │   │
  │  └─────────────────┘  └───────────────────┘   │
  └──────────────────────────────────────────────┘
```

### Comparison: Containers vs MicroVMs vs Secure Exec

```
Container (Docker)

  ┌───────────────────────────────────────────┐
  │  Host Linux Kernel (shared)               │
  │                                           │
  │  ┌─────────────────┐  ┌────────────────┐  │
  │  │ Namespace +     │  │ Namespace +    │  │
  │  │ cgroup jail     │  │ cgroup jail    │  │
  │  │                 │  │                │  │
  │  │  ┌───────────┐  │  │  ┌──────────┐  │  │
  │  │  │   App 1   │  │  │  │  App 2   │  │  │
  │  │  │  ELF bins  │  │  │  │ ELF bins │  │  │
  │  │  └───────────┘  │  │  └──────────┘  │  │
  │  └─────────────────┘  └────────────────┘  │
  └───────────────────────────────────────────┘
  Kernel is shared. Kernel vuln = all containers escape.


MicroVM (Firecracker)

  ┌───────────────────────────────────────────┐
  │  Host Linux Kernel                        │
  │                                           │
  │  ┌─────────────────┐  ┌────────────────┐  │
  │  │ KVM / VT-x      │  │ KVM / VT-x     │  │
  │  │ (hypervisor)     │  │ (hypervisor)   │  │
  │  │                  │  │                │  │
  │  │  ┌────────────┐  │  │  ┌──────────┐  │  │
  │  │  │ Guest      │  │  │  │ Guest    │  │  │
  │  │  │ Linux      │  │  │  │ Linux    │  │  │
  │  │  │ Kernel     │  │  │  │ Kernel   │  │  │
  │  │  │            │  │  │  │          │  │  │
  │  │  │  ┌──────┐  │  │  │  │ ┌──────┐ │  │  │
  │  │  │  │ App  │  │  │  │  │ │ App  │ │  │  │
  │  │  │  └──────┘  │  │  │  │ └──────┘ │  │  │
  │  │  └────────────┘  │  │  └──────────┘  │  │
  │  └─────────────────┘  └────────────────┘  │
  └───────────────────────────────────────────┘
  Each VM has its own kernel. Hypervisor vuln = escape.


Secure Exec

  ┌───────────────────────────────────────────┐
  │  Host Process (Node.js / Browser)         │
  │                                           │
  │  ┌─────────────────┐  ┌────────────────┐  │
  │  │ Virtual OS       │  │ Virtual OS     │  │
  │  │ (SEOS kernel)    │  │ (SEOS kernel)  │  │
  │  │                  │  │                │  │
  │  │  ┌────────────┐  │  │  ┌──────────┐  │  │
  │  │  │ V8 / WASM  │  │  │  │ V8 / WASM│  │  │
  │  │  │            │  │  │  │          │  │  │
  │  │  │  JS / WASM │  │  │  │ JS / WASM│  │  │
  │  │  │  programs  │  │  │  │ programs │  │  │
  │  │  └────────────┘  │  │  └──────────┘  │  │
  │  └─────────────────┘  └────────────────┘  │
  └───────────────────────────────────────────┘
  Each instance has its own kernel. V8/WASM vuln = escape.
```

|                    | Container            | MicroVM               | Secure Exec           |
|--------------------|----------------------|-----------------------|-----------------------|
| **Isolation**      | Namespaces + cgroups  | Hardware (VT-x/KVM)   | V8 isolate + WASM     |
| **Kernel**         | Shared host kernel    | Dedicated guest kernel| Virtual POSIX kernel  |
| **Attack surface** | Host kernel syscalls  | Hypervisor interface   | JS/WASM sandbox       |
| **Boot time**      | ~100ms               | ~125ms                | <5ms                  |
| **Overhead**       | Near-native           | ~3-5% CPU/memory      | V8/WASM overhead      |
| **Runs in browser**| No                   | No                    | Yes                   |
| **Guest format**   | ELF binaries          | ELF binaries          | JS scripts + WASM     |
| **Escape risk**    | Kernel vuln = escape  | Hypervisor vuln = escape | V8 vuln = escape   |

Key architectural differences:
- **Containers** share the host kernel — a kernel vulnerability lets every container escape. The kernel is the trust boundary and the attack surface simultaneously.
- **MicroVMs** run a dedicated guest kernel inside hardware virtualization. Stronger isolation (hypervisor boundary), but 100ms+ boot time and no browser support.
- **Secure Exec** provides its own virtual kernel in userspace. No shared kernel attack surface (the virtual kernel is per-instance), no hardware requirements, millisecond boot. The tradeoff is that isolation depends on V8/WASM sandbox correctness rather than hardware enforcement.

The WASI extensions (`native/wasmvm/crates/wasi-ext/`) bridge WASM syscalls into the OS kernel.
The Node.js bridge (`packages/nodejs/src/bridge/`) does the same for V8 isolate code. Both are
thin translation layers — the real implementation lives in the kernel.

## Package Map

```
  Kernel-first API (createKernel + mount + exec)
  packages/core/

  Legacy facade: NodeRuntime (packages/secure-exec/src/runtime.ts)
         │
    ┌────┴─────┬──────────┬──────────┐
    │          │          │          │
  Node      Browser    Python    WasmVM
  packages/ packages/  packages/ packages/
  secure-   secure-    secure-   secure-
  exec-     exec-      exec-     exec-
  nodejs/   browser/   python/   wasmvm/

Package index:

  @secure-exec/core        packages/core/
    Kernel (VFS, FD table, process table, device layer, pipes, PTY,
    command registry, permissions), shared types, utilities,
    isolate-runtime source, in-memory filesystem

  @secure-exec/v8          packages/v8/
    V8 runtime process manager (spawns Rust binary, IPC client,
    session abstraction). MessagePack framing over UDS.

  @secure-exec/nodejs      packages/nodejs/
    Node execution driver, bridge polyfills, bridge-handlers,
    bridge-loader, module-access overlay, ESM compiler,
    module resolver, package bundler, kernel runtime driver
    (createNodeRuntime), createNodeDriver, createNodeRuntimeDriverFactory

  @secure-exec/browser     packages/browser/
    Web Worker execution driver, browser VFS (InMemoryFileSystem),
    browser worker adapter, createBrowserDriver,
    createBrowserRuntimeDriverFactory

  @secure-exec/python      packages/python/
    Pyodide execution driver, kernel runtime driver
    (createPythonRuntime), createPyodideRuntimeDriverFactory

  @secure-exec/wasmvm      packages/wasmvm/
    WasmVM runtime driver (createWasmVmRuntime), WASI polyfill,
    kernel worker management. WASM binaries in native/wasmvm/target/

  @secure-exec/typescript  packages/typescript/
    Optional TypeScript compiler tools (type-checking, compilation)

  secure-exec              packages/secure-exec/
    Barrel re-export layer (re-exports core, nodejs).
    Contains legacy NodeRuntime facade class.
```

## Kernel (createKernel)

`packages/core/src/kernel/kernel.ts`

Primary API. Creates a kernel with shared VFS, FD table, process table, device layer, pipes, PTY, and command registry.

- `kernel.mount(driver)` — register a RuntimeDriver and its commands
- `kernel.exec(command)` — high-level execute-and-collect (spawn via shell, capture stdout/stderr)
- `kernel.spawn(command, args, options)` — low-level process spawn with PID allocation and FD table setup
- `kernel.openShell(options)` — open an interactive PTY shell
- `kernel.dispose()` — terminate all processes and release resources

## NodeRuntime (legacy facade)

`packages/secure-exec/src/runtime.ts`

Legacy facade for direct code execution. Delegates to execution drivers.

- `NodeRuntime.run(code)` — execute JS module, get exports back
- `NodeRuntime.exec(code)` — execute as script, get exit code/error contract
- `dispose()` / `terminate()`
- Requires both:
  - `systemDriver` for runtime capabilities/config
  - runtime-driver factory for execution-driver construction

## SystemDriver

`packages/core/src/types.ts`

Config object that bundles what the isolate can access. Deny-by-default. Used by the legacy NodeRuntime facade.

- `filesystem` — VFS adapter
- `network` — fetch, DNS, HTTP
- `commandExecutor` — child processes
- `permissions` — per-adapter allow/deny checks

## NodeRuntimeDriverFactory / PythonRuntimeDriverFactory

`packages/core/src/runtime-driver.ts`

Factory abstraction for constructing execution drivers from normalized runtime options.

- `createRuntimeDriver(options)` — returns an execution driver

### createNodeDriver()

`packages/nodejs/src/driver.ts`

Factory that builds a `SystemDriver` with Node-native adapters.

- Wraps filesystem in `ModuleAccessFileSystem` (read-only `node_modules` overlay)
- Optionally wires up network and command executor

### createNodeRuntimeDriverFactory()

`packages/nodejs/src/driver.ts`

Factory that builds a Node-backed execution driver factory.

- Constructs `NodeExecutionDriver` instances
- Owns optional Node-specific isolate creation hook
- Standalone `NodeRuntime` executions still provision an internal `SocketTable` + host adapter, so `http.createServer()` and `net.connect()` remain kernel-routed even without `kernel.mount()`

### createNodeRuntime()

`packages/nodejs/src/kernel-runtime.ts`

Factory that creates a kernel-compatible Node RuntimeDriver for use with `kernel.mount()`.

- Returns a `KernelRuntimeDriver` with commands like `node`, `npx`, `npm`
- Manages V8 session lifecycle for kernel-spawned processes
- Bridges kernel VFS/FD table into Node execution context

### createBrowserDriver()

`packages/browser/src/driver.ts`

Factory that builds a browser `SystemDriver` with browser-native adapters.

- Uses OPFS or in-memory filesystem adapters
- Uses fetch-backed network adapter with deterministic `ENOSYS` for unsupported DNS/server paths
- Applies permission wrappers before returning the driver

### createBrowserRuntimeDriverFactory()

`packages/browser/src/runtime-driver.ts`

Factory that builds a browser-backed execution driver factory.

- Validates and rejects Node-only runtime options
- Constructs `BrowserRuntimeDriver` instances
- Owns worker URL/execution-driver creation options

### createPyodideRuntimeDriverFactory()

`packages/python/src/driver.ts`

Factory that builds a Python-backed execution driver factory.

- Constructs `PyodideRuntimeDriver` instances
- Owns Pyodide worker bootstrap and execution-driver creation options

### createPythonRuntime()

`packages/python/src/kernel-runtime.ts`

Factory that creates a kernel-compatible Python RuntimeDriver for use with `kernel.mount()`.

- Returns a `KernelRuntimeDriver` with `python` command
- Manages Pyodide worker lifecycle for kernel-spawned processes

### createWasmVmRuntime()

`packages/wasmvm/src/runtime.ts`

Factory that creates a kernel-compatible WasmVM RuntimeDriver for use with `kernel.mount()`.

- Returns a `KernelRuntimeDriver` with POSIX commands (`sh`, `ls`, `cat`, `grep`, etc.)
- Loads WASM binaries from `native/wasmvm/target/`
- Manages WASI polyfill and kernel worker threads

## @secure-exec/v8 (V8 Runtime)

`packages/v8/`

Manages the Rust V8 child process and provides the session API.

- `createV8Runtime()` spawns the Rust binary, connects over UDS, authenticates
- One Rust process is shared across all drivers (singleton)
- `V8Session.execute()` sends InjectGlobals + Execute, routes BridgeCall/BridgeResponse
- IPC uses length-prefixed MessagePack (64 MB max); binary data uses msgpack `bin` format (no base64)
- Bridge args/results are double-encoded: inner msgpack blobs inside outer msgpack IPC messages

### Rust binary (`native/v8-runtime/`)

The Rust V8 runtime process. One OS thread per session, each owning a `v8::Isolate`.

- `ipc.rs` — message types (`HostMessage`/`RustMessage`), length-prefixed framing
- `isolate.rs` — V8 platform init, isolate create/destroy, heap limits
- `execution.rs` — CJS (`v8::Script`) and ESM (`v8::Module`) compilation/execution, globals injection, context hardening
- `bridge.rs` — `v8::FunctionTemplate` registration, V8↔MessagePack conversion (`v8_to_rmpv`/`rmpv_to_v8` via `rmpv::Value`)
- `host_call.rs` — sync-blocking bridge calls (serialize → write → block on read → deserialize)
- `stream.rs` — StreamEvent dispatch into V8 (child process, HTTP server)
- `timeout.rs` — per-session timer thread, `terminate_execution()` + abort channel
- `session.rs` — session management, event loop, concurrency limiting
- `main.rs` — UDS listener, connection auth, signal handling, FD hygiene

## NodeExecutionDriver

`packages/nodejs/src/execution-driver.ts`

The engine. Obtains a V8 session from the shared `@secure-exec/v8` runtime and bridges host capabilities in.

- Composes bridge code (ivm-compat shim + config + bridge bundle + timing mitigation)
- Builds bridge handlers as plain functions (`bridge-handlers.ts`) passed to `V8Session.execute()`
- Caches bridge code per driver instance
- Enforces payload size limits on bridge transfers

## BrowserRuntimeDriver

`packages/browser/src/runtime-driver.ts`

Browser execution driver that owns worker lifecycle and message marshalling.

- Spawns and manages the browser runtime worker
- Dispatches `run`/`exec` requests and correlates responses by request ID
- Streams optional stdio events to host hooks without runtime-managed output buffering
- Exposes the configured browser network adapter through `NodeRuntime.network`

### Browser Worker Runtime

`packages/browser/src/worker.ts`

Worker-side runtime implementation used by the browser execution driver.

- Initializes browser bridge globals and runtime config from worker init payload
- Executes transformed CJS/ESM user code and returns runtime-contract results
- Uses permission-aware filesystem/network adapters in the worker context
- Preserves deterministic unsupported-operation contracts (for example DNS gaps)

## PyodideRuntimeDriver

`packages/python/src/driver.ts`

Python execution driver that owns a Node worker running Pyodide.

- Loads Pyodide once per runtime instance and keeps interpreter state warm across runs
- Dispatches `run`/`exec` requests and correlates responses by request ID
- Streams stdio events to host hooks without runtime-managed output buffering
- Uses worker-to-host RPC for permission-wrapped filesystem/network access through `SystemDriver`
- Restarts worker state on execution timeout to preserve deterministic recovery behavior

## TypeScript Tools

`packages/typescript/src/index.ts`

Optional companion package for isolated TypeScript compiler work (`@secure-exec/typescript`).

- `createTypeScriptTools(...)` — build project/source compile and typecheck helpers
- Uses a dedicated `NodeRuntime` isolate per request
- Keeps TypeScript compiler execution out of the core runtime path

## ModuleAccessFileSystem

`packages/nodejs/src/module-access.ts`

Filesystem overlay that makes host `node_modules` available read-only at `/root/node_modules`.

- Blocks `.node` native addons
- Prevents symlink escapes (resolves pnpm virtual-store paths)
- Non-module paths fall through to base VFS

## Permissions

`packages/core/src/shared/permissions.ts`

Wraps each adapter with allow/deny checks before calls reach the host.

- `wrapFileSystem()`, `wrapNetworkAdapter()`, `wrapCommandExecutor()`
- Missing adapters get deny-all stubs
