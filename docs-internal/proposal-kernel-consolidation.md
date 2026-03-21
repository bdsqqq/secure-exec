# Proposal: Kernel-First Package Consolidation

## Status

**Draft** — 2026-03-20

## Summary

Consolidate the two parallel architectures (published SDK layer and kernel/OS layer) into a single kernel-first architecture. The kernel becomes the default for all usage. The non-kernel `NodeRuntime` / `SystemDriver` API is removed. Runtime packages (`@secure-exec/nodejs`, `@secure-exec/python`, `@secure-exec/wasmvm`) become kernel drivers that users mount. The user experience is progressive: start with sandboxed Node, add WasmVM for shell/POSIX, add Python for Python — all via `kernel.mount()`.

Additionally, restructure the repository layout to cleanly separate TypeScript packages (`packages/`) from native Rust code (`native/`), eliminating the current split where Rust code is scattered across `crates/` and `wasmvm/` at the repo root.

## Motivation

### Two architectures, one product

Today the codebase has two parallel stacks:

1. **Published SDK layer** — `@secure-exec/core`, `@secure-exec/node`, `@secure-exec/browser`, `@secure-exec/python`. User-facing. Published to npm. V8 isolate sandboxing with bridge polyfills. No kernel, no process table, no pipes, no shell.

2. **Kernel/OS layer** — `@secure-exec/kernel`, `os-{node,browser}`, `runtime-{node,python,wasmvm}`. Internal. Source-only (not published). Full OS simulation with VFS, FD table, process table, pipes, PTY, signals.

The kernel path wraps the SDK path — `runtime-node` creates a `SystemDriver` and `NodeExecutionDriver` internally. The two stacks share the same V8 execution engine but expose different APIs and duplicate types.

### Problems with the current split

1. **`child_process` is broken without the kernel.** The non-kernel `CommandExecutor` is a stub. Users hit a wall when sandboxed code tries to spawn a process, and must rewrite to the kernel API.

2. **Duplicate types.** `VirtualFileSystem`, `Permissions`, `PermissionDecision`, `FsAccessRequest`, etc. are defined independently in both `@secure-exec/core` and `@secure-exec/kernel` with near-identical shapes.

3. **Two APIs to learn.** Non-kernel: `new NodeRuntime(driver)` + `runtime.exec()`. Kernel: `createKernel()` + `kernel.mount()` + `kernel.exec()`. Users must choose upfront and migrate later.

4. **`@secure-exec/core` is bloated.** It bundles `esbuild`, `node-stdlib-browser`, `sucrase`, `whatwg-url` as production dependencies. These are build-time deps baked into `dist/bridge.js` that should be `devDependencies`.

5. **The root `secure-exec` package is already Node-only.** It hard-depends on `@secure-exec/node`, re-exports Node driver factories, and has browser/Python subpath exports that are commented out.

6. **Naming confusion.** `@secure-exec/node` (published V8 driver) vs `@secure-exec/runtime-node` (kernel runtime driver) vs `@secure-exec/os-node` (kernel platform adapter) — three packages with "node" in the name at different abstraction levels.

### Scattered native code

Rust code lives in two disconnected locations at the repo root:

- **`crates/v8-runtime/`** — a single Rust crate that compiles to a host binary (x86/arm). It's the V8 runtime process that `@secure-exec/v8` spawns. Sits alone in `crates/` with no siblings.
- **`wasmvm/`** — an entire separate Rust workspace with its own `Cargo.toml`, `Cargo.lock`, `Makefile`, `vendor/`, `scripts/`, `patches/`, and `CLAUDE.md`. Contains ~90 command crates compiled to `wasm32-wasip1`, plus C programs and wasi-libc patches.

These two Rust projects have completely different toolchains and targets (host native vs WASM), so they can't share a Cargo workspace. But having them at different nesting levels (`crates/X` vs `wasmvm/`) with different conventions makes the repo harder to navigate. Meanwhile, `packages/` mixes flat top-level packages (`secure-exec-core`) with nested groups (`runtime/node`, `os/browser`), and after the kernel consolidation those nested groups get merged away.

### Why the kernel is effectively free

The kernel constructor (`kernel.ts:88-121`) is synchronous, in-memory setup:
- Wrap VFS with device layer (thin proxy)
- Wrap VFS with permissions (thin proxy)
- Instantiate `FDTableManager`, `ProcessTable`, `PipeManager`, `PtyManager`, `FileLockManager`, `CommandRegistry`, `UserManager` — all empty data structures, zero I/O

When only Node is mounted and no shell/pipe/PTY features are used, the process table has one entry, the pipe manager is idle, and the PTY manager is idle. The overhead is a few empty `Map`s.

The expensive part — `NodeExecutionDriver` + V8 isolate + bridge — is identical in both paths.

## Target Architecture

### Repository layout

```
/
├── native/                         ← All Rust/C native code
│   ├── v8-runtime/                 ← V8 host binary (x86/arm)
│   │   ├── Cargo.toml
│   │   └── src/
│   └── wasmvm/                     ← WASM command workspace (wasm32-wasip1)
│       ├── Cargo.toml              ← Workspace root (separate from v8-runtime)
│       ├── Cargo.lock
│       ├── Makefile
│       ├── rust-toolchain.toml
│       ├── crates/
│       │   ├── commands/           ← ~90 command crates (sh, ls, grep, etc.)
│       │   ├── libs/               ← Shared Rust libs for commands
│       │   └── wasi-ext/           ← WASI host import declarations
│       ├── c/                      ← C programs compiled to WASM
│       ├── patches/                ← wasi-libc patches
│       ├── vendor/                 ← Vendored Rust deps
│       ├── scripts/
│       └── CLAUDE.md
├── packages/                       ← All TypeScript packages (pnpm workspace)
│   ├── secure-exec/                ← Re-export of @secure-exec/nodejs
│   ├── core/           ← Kernel + types + utilities
│   ├── nodejs/         ← Node.js runtime driver + bridge
│   ├── v8/             ← V8 bindings (TS side)
│   ├── python/         ← Python runtime driver
│   ├── wasmvm/         ← WasmVM runtime driver (TS side)
│   ├── browser/        ← Browser platform adapter (future)
│   ├── typescript/     ← TypeScript helpers
│   ├── playground/                 ← Dev playground (private)
│   └── website/                    ← Docs site (private)
├── docs/                           ← Public documentation (Astro)
├── docs-internal/                  ← Internal specs, proposals, glossary
├── examples/                       ← Example projects
└── scripts/                        ← Repo-level scripts
```

**Key principles:**
- `packages/` = TypeScript. `native/` = Rust/C. No mixing.
- `native/v8-runtime/` and `native/wasmvm/` remain separate Cargo workspaces (different toolchains, different targets). The `native/` grouping is organizational, not a shared workspace.
- `packages/` is flat — no nested `runtime/`, `os/`, or `kernel/` subdirectories after consolidation.
- `wasmvm/` internals (crates, patches, vendor, Makefile) are preserved as-is under `native/wasmvm/`.

### npm package structure

```
secure-exec                    (published — convenience re-export)
@secure-exec/core              (published — kernel + types + utilities)
@secure-exec/nodejs            (published — Node.js runtime driver)
@secure-exec/v8                (published — native V8 bindings, unchanged)
@secure-exec/python            (published — Python runtime driver)
@secure-exec/wasmvm            (published — WasmVM runtime driver)
@secure-exec/browser           (published — browser platform adapter, future)
@secure-exec/typescript        (published — TypeScript helpers, unchanged)
```

### Dependency graph

```
secure-exec
└── @secure-exec/nodejs (re-exports 1:1, no code)

@secure-exec/nodejs
├── @secure-exec/core
└── @secure-exec/v8

@secure-exec/python
└── @secure-exec/core

@secure-exec/wasmvm
└── @secure-exec/core

@secure-exec/core
└── (minimal deps — types, kernel, utilities only)

@secure-exec/v8
└── (platform-specific native bindings only)
```

### What lives where

#### `@secure-exec/core`

Kernel + shared types + lightweight utilities. No heavy build deps.

| What | Source |
|---|---|
| `createKernel()` | From current `@secure-exec/kernel` |
| `Kernel`, `KernelInterface`, `RuntimeDriver`, `DriverProcess`, `ProcessContext` | From current `@secure-exec/kernel/types` |
| `VirtualFileSystem`, `VirtualStat`, `VirtualDirEntry` | From current `@secure-exec/kernel/vfs` (canonical, replaces core's copy) |
| `Permissions`, `PermissionCheck`, `FsAccessRequest`, etc. | From current `@secure-exec/kernel/types` (canonical, replaces core's copy) |
| `createInMemoryFileSystem` | From current `@secure-exec/core/shared/in-memory-fs` |
| `allowAll`, `allowAllFs`, `allowAllChildProcess`, etc. | From current `@secure-exec/core/shared/permissions` |
| Kernel internals: FD table, process table, pipe manager, PTY, device layer, file locks | From current `@secure-exec/kernel/src/*` |
| POSIX constants: `O_RDONLY`, `SIGTERM`, `SEEK_SET`, etc. | From current `@secure-exec/kernel/types` |

**Not in core:**
- Bridge polyfills (moves to `@secure-exec/nodejs`)
- Bridge contract types (moves to `@secure-exec/nodejs`)
- `esbuild`, `sucrase`, `node-stdlib-browser`, `whatwg-url` (build deps, move to `@secure-exec/nodejs` devDeps)
- `NodeRuntime`, `PythonRuntime` facades (deleted)
- `SystemDriver`, `RuntimeDriverFactory`, `SharedRuntimeDriver` types (deleted or made internal)
- `NetworkAdapter` type and implementation (moves to `@secure-exec/nodejs`)

#### `@secure-exec/nodejs`

Everything needed to run Node.js code in a sandbox. Registers `node`, `npm`, `npx` commands with the kernel.

| What | Source |
|---|---|
| `NodeRuntime` class (kernel RuntimeDriver) | From current `@secure-exec/runtime-node` (renamed) |
| Bridge polyfills (`bridge/fs.ts`, `bridge/process.ts`, etc.) | From current `@secure-exec/core/src/bridge/` |
| Bridge contract (`bridge-contract.ts`) | From current `@secure-exec/core/src/shared/bridge-contract.ts` |
| Bridge handlers (`bridge-handlers.ts`) | From current `@secure-exec/node/src/bridge-handlers.ts` |
| Bridge loader + setup | From current `@secure-exec/node/src/bridge-loader.ts`, `bridge-setup.ts` |
| `NodeExecutionDriver` | From current `@secure-exec/node/src/execution-driver.ts` |
| `NodeFileSystem` | From current `@secure-exec/node/src/driver.ts` |
| `createDefaultNetworkAdapter` | From current `@secure-exec/node/src/driver.ts` |
| `NetworkAdapter` type | From current `@secure-exec/core/src/types.ts` |
| `ModuleAccessFileSystem` | From current `@secure-exec/node/src/module-access.ts` |
| ESM compiler, module resolver, package bundler | From current `@secure-exec/core/src/` |
| Polyfill bundler, isolate runtime codegen | From current `@secure-exec/core/scripts/` |
| `KernelCommandExecutor` (internal) | From current `@secure-exec/runtime-node/src/driver.ts` |
| `createKernelVfsAdapter` (internal) | From current `@secure-exec/runtime-node/src/driver.ts` |

Build-time deps (`esbuild`, `node-stdlib-browser`, `sucrase`, `whatwg-url`, `buffer`, `text-encoding-utf-8`) become `devDependencies` here — they're baked into `dist/bridge.js` at build time and not needed at runtime.

#### `@secure-exec/wasmvm`

WasmVM runtime driver. Registers shell commands (`sh`, `ls`, `grep`, `cat`, etc.) with the kernel.

| What | Source |
|---|---|
| `WasmVmRuntime` class (kernel RuntimeDriver) | From current `@secure-exec/runtime-wasmvm` |
| WASM binary loading + worker management | From current `@secure-exec/runtime-wasmvm/src/` |
| WASM binaries (`multicall.opt.wasm`, etc.) | From current `wasmvm/target/` |

#### `@secure-exec/python`

Python runtime driver. Registers `python3` with the kernel.

| What | Source |
|---|---|
| `PythonRuntime` class (kernel RuntimeDriver) | From current `@secure-exec/runtime-python` |
| Pyodide integration | From current `@secure-exec/python` |

#### `secure-exec`

Pure re-export of `@secure-exec/nodejs`. Zero code.

```ts
export * from "@secure-exec/nodejs";
export { createKernel } from "@secure-exec/core";
export type { Kernel, Permissions, VirtualFileSystem /* ... */ } from "@secure-exec/core";
```

### Packages removed

| Package | Disposition |
|---|---|
| `@secure-exec/kernel` | Merged into `@secure-exec/core` |
| `@secure-exec/runtime-node` | Merged into `@secure-exec/nodejs` |
| `@secure-exec/runtime-python` | Merged into `@secure-exec/python` |
| `@secure-exec/runtime-wasmvm` | Merged into `@secure-exec/wasmvm` |
| `@secure-exec/os-node` | Merged into `@secure-exec/nodejs` (platform adapter) |
| `@secure-exec/os-browser` | Merged into `@secure-exec/browser` (future) |
| `@secure-exec/node` (old name) | Renamed to `@secure-exec/nodejs` |

### Types removed / made internal

| Type | Disposition |
|---|---|
| `NodeRuntime` (facade in core) | Deleted — replaced by `kernel.exec()` |
| `PythonRuntime` (facade in core) | Deleted — replaced by `kernel.exec()` |
| `SystemDriver` | Internal to `@secure-exec/nodejs` (bridge still uses it) |
| `RuntimeDriverFactory` / `NodeRuntimeDriverFactory` | Deleted — kernel handles driver lifecycle |
| `SharedRuntimeDriver` | Deleted |
| `CommandExecutor` (core's version) | Deleted — kernel.spawn() replaces it |
| `VirtualFileSystem` (core's version) | Deleted — kernel's version becomes canonical |
| `Permissions` (core's version) | Deleted — kernel's version becomes canonical |

## User-Facing API

### Basic Node.js sandboxing

```ts
import { createKernel, NodeRuntime } from "secure-exec";
// or
import { createKernel } from "@secure-exec/core";
import { NodeRuntime } from "@secure-exec/nodejs";

const kernel = createKernel({
  filesystem: new NodeFileSystem(),
  permissions: allowAll,
});
await kernel.mount(new NodeRuntime());

const result = await kernel.exec("node -e 'console.log(1 + 1)'");
// { exitCode: 0, stdout: "2\n", stderr: "" }

await kernel.dispose();
```

### Adding shell / POSIX commands

```ts
import { WasmVmRuntime } from "@secure-exec/wasmvm";

// Same kernel, just mount another driver
await kernel.mount(new WasmVmRuntime());

// Now child_process.spawn('sh', ...) works inside Node isolates
// Shell commands work directly
await kernel.exec("echo hello | grep hello");
await kernel.exec("ls -la /home/user");
```

### Adding Python

```ts
import { PythonRuntime } from "@secure-exec/python";

await kernel.mount(new PythonRuntime());

await kernel.exec("python3 -c 'print(1 + 1)'");
```

### Interactive shell

```ts
const shell = kernel.openShell({ cols: 80, rows: 24 });
shell.onData = (data) => process.stdout.write(data);
process.stdin.on("data", (data) => shell.write(data));
await shell.wait();
```

### Filesystem operations

```ts
await kernel.writeFile("/home/user/script.js", "console.log('hello')");
await kernel.exec("node /home/user/script.js");
const content = await kernel.readFile("/home/user/output.txt");
```

### Permissions

```ts
import { createKernel } from "@secure-exec/core";

const kernel = createKernel({
  filesystem: new NodeFileSystem(),
  permissions: {
    fs: (req) => {
      if (req.op === "write" && req.path.startsWith("/etc"))
        return { allow: false, reason: "read-only" };
      return { allow: true };
    },
    network: (req) => ({ allow: false, reason: "no network" }),
    childProcess: (req) => ({ allow: true }),
  },
});
```

## Migration Path

### Phase 1: Consolidate types (low risk)

1. Make `@secure-exec/kernel` types the canonical source of truth.
2. Re-export `VirtualFileSystem`, `Permissions`, `PermissionCheck`, etc. from kernel through core.
3. Deprecate core's own type definitions with `@deprecated` JSDoc pointing to kernel types.
4. Update all internal imports to use kernel types.

**Tests:** All existing tests should pass unchanged — types are structurally identical.

### Phase 2: Move bridge to `@secure-exec/nodejs` (medium risk)

1. Move `packages/core/src/bridge/` → `packages/secure-exec-node/src/bridge/`.
2. Move `packages/core/src/shared/bridge-contract.ts` → `packages/secure-exec-node/src/bridge-contract.ts`.
3. Move ESM compiler, module resolver, package bundler from core to nodejs.
4. Move bridge build scripts (`build:bridge`, `build:polyfills`, `build:isolate-runtime`) from core to nodejs.
5. Move `esbuild`, `node-stdlib-browser`, `sucrase`, `whatwg-url`, `buffer`, `text-encoding-utf-8` from core's `dependencies` to nodejs's `devDependencies`.
6. Update turbo.json build dependencies.

**Risk:** Build pipeline changes. The bridge IIFE must still be compiled before `@secure-exec/nodejs` builds. Turbo task dependencies need updating.

**Tests:** Bridge integration tests in `packages/secure-exec/tests/` need import path updates.

### Phase 3: Merge kernel into core (medium risk)

1. Move `packages/kernel/src/*` → `packages/core/src/kernel/`.
2. Export `createKernel`, `Kernel`, `KernelInterface`, and all kernel types from `@secure-exec/core`.
3. Delete duplicate type definitions in core (VirtualFileSystem, Permissions, etc.).
4. Re-export kernel types from core's public API for backward compatibility.
5. Add `build` script to core for kernel code (currently source-only).

**Risk:** Core gains more code, but no new dependencies. The kernel has zero external dependencies.

**Tests:** Kernel tests move with the code. All existing kernel tests should pass.

### Phase 4: Merge runtime drivers into user-facing packages (high risk)

1. Merge `packages/runtime/node/` into `packages/secure-exec-node/`:
   - `NodeRuntimeDriver` (kernel driver) + `NodeExecutionDriver` (V8 engine) live together
   - `KernelCommandExecutor`, `createKernelVfsAdapter`, host VFS fallback become internal
   - `SystemDriver` becomes a private internal type

2. Merge `packages/runtime/wasmvm/` into a new `packages/wasmvm/`:
   - Promote from source-only to publishable package
   - Move WASM binary build artifacts here

3. Merge `packages/runtime/python/` into `packages/python/`:
   - Combine with existing Pyodide driver code

4. Merge `packages/os/node/` into `packages/secure-exec-node/`.
5. Merge `packages/os/browser/` into `packages/browser/`.

**Risk:** Highest risk phase. Many file moves, import rewrites, and test relocations. Should be done as a series of smaller PRs per runtime.

### Phase 5: Replace public API (breaking change)

1. Remove `NodeRuntime` / `PythonRuntime` facades from core.
2. Remove `SystemDriver`, `RuntimeDriverFactory`, `SharedRuntimeDriver` from public exports.
3. Remove `secure-exec/browser` and `secure-exec/python` subpath exports.
4. Make `secure-exec` a pure re-export of `@secure-exec/nodejs` + `createKernel` from core.
5. Rename `@secure-exec/node` → `@secure-exec/nodejs`.
6. Update all docs, examples, and README.

**This is a semver major bump.** Publish as `secure-exec@0.2.0` (or `1.0.0` if ready).

### Phase 6: Repository layout restructure (low risk)

Move native code into `native/` and flatten `packages/`.

1. Move `crates/v8-runtime/` → `native/v8-runtime/`.
2. Move `wasmvm/` → `native/wasmvm/`.
3. Update `@secure-exec/v8` to reference `native/v8-runtime/` for the Rust binary (postinstall script, build paths).
4. Update `@secure-exec/wasmvm` to reference `native/wasmvm/target/` for WASM binaries.
5. Update `turbo.json` `build:wasm` task inputs from `wasmvm/**` to `native/wasmvm/**`.
6. Update CLAUDE.md references to `wasmvm/` and `crates/`.
7. Update `native/wasmvm/CLAUDE.md` if path references change.
8. Delete empty top-level `crates/` and `wasmvm/` directories.

**Risk:** Low — these are pure file moves with no code changes. The two Rust workspaces remain independent. The main risk is stale path references in scripts, CI, and documentation.

**Verification:** `cd native/v8-runtime && cargo build` and `cd native/wasmvm && make wasm` must both work after the move.

### Phase 7: Cleanup

1. Delete empty/merged packages: `@secure-exec/kernel`, `@secure-exec/runtime-node`, `@secure-exec/runtime-python`, `@secure-exec/runtime-wasmvm`, `@secure-exec/os-node`, `@secure-exec/os-browser`.
2. Update `pnpm-workspace.yaml` to remove old paths (`packages/os/*`, `packages/runtime/*`).
3. Update `turbo.json` tasks.
4. Update `docs-internal/arch/overview.md`.
5. Update contracts in `.agent/contracts/`.
6. Update CLAUDE.md.
7. Update CI workflows (`.github/workflows/`) for new paths.

## Open Questions

### 1. NetworkAdapter — kernel-owned or side-channel?

The kernel has no network abstraction today. Network operations (fetch, DNS, HTTP client/server, TCP sockets, TLS) are handled by `NetworkAdapter`, which lives in the bridge handlers.

**Option A: Keep as side-channel.** `NetworkAdapter` stays in `@secure-exec/nodejs` as a bridge concern. The kernel doesn't know about network. Each runtime driver brings its own network adapter. Network permissions are enforced at the bridge level, not the kernel level.

**Option B: Add to kernel.** `KernelInterface` gains `fetch()`, `listen()`, `dnsLookup()`, etc. Network permissions move to kernel-level enforcement. Runtime drivers call `kernel.fetch()` instead of managing their own adapters.

**Recommendation:** Option A for now. Network is a host capability, not an OS kernel concern. POSIX kernels don't implement HTTP. Keep the clean separation. Revisit if cross-runtime network sharing becomes needed.

### 2. Browser support

`@secure-exec/browser` currently provides `createBrowserDriver()` with Web Worker isolation and OPFS filesystem. It doesn't use the kernel. With the consolidation:

- The kernel must work in browser environments (no `node:fs` deps in kernel code).
- `@secure-exec/browser` would provide a browser-compatible VFS (OPFS or in-memory) and a browser runtime driver.
- The bridge would need a browser-compatible execution backend (Web Worker instead of V8 isolate).

**Recommendation:** Defer. Browser support is already broken (exports commented out). The kernel is already platform-agnostic (no Node imports). Browser can be added later as `@secure-exec/browser` providing a `BrowserRuntime` kernel driver + OPFS filesystem, following the same `kernel.mount()` pattern.

### 3. Package naming — `@secure-exec/node` vs `@secure-exec/nodejs`

Current published package is `@secure-exec/node`. Renaming to `@secure-exec/nodejs` aligns with the docs slug (`nodejs-compatibility`) and avoids confusion with `@secure-exec/runtime-node`.

**Trade-off:** Renaming a published package requires either npm deprecation + new package, or a major version bump with clear migration notes.

**Recommendation:** If still pre-1.0 with limited external users, rename now. Otherwise, keep `@secure-exec/node` and rename the merged runtime driver to avoid confusion differently (e.g. the runtime driver class is `NodeRuntime`, the package stays `@secure-exec/node`).

### 4. Where do tests live?

Currently:
- `packages/secure-exec/tests/` — integration tests for all runtimes
- `packages/kernel/test/` — kernel unit tests
- `packages/runtime/node/test/` — runtime-node tests
- `packages/runtime/wasmvm/test/` — WasmVM tests

After consolidation, tests should follow their code:
- `packages/core/test/` — kernel tests
- `packages/secure-exec-node/test/` — Node runtime + bridge tests
- `packages/wasmvm/test/` — WasmVM tests
- `packages/secure-exec/tests/` — lightweight integration/smoke tests only

The shared test suites (`test-suite/node/`, `test-suite/python/`) that test generic `RuntimeDriver` behavior can stay in `packages/secure-exec/tests/` since they exercise the full stack through the kernel.

### 5. `@secure-exec/core` build step

The kernel is currently source-only (`"main": "src/index.ts"`, no `dist/` build). To publish `@secure-exec/core`, it needs a `tsc` build step, `dist/` output, and proper `exports` in `package.json`.

This is straightforward but must be done in Phase 3 when the kernel merges into core.

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Import path breakage across monorepo | High | Medium | Automated codemods, comprehensive grep-and-replace |
| Bridge build pipeline breaks | Medium | High | Phase 2 in isolation, test bridge output byte-for-byte |
| Kernel tests fail after move | Low | Medium | Tests are self-contained, just need path updates |
| Published API break | Certain | High | Semver major bump, migration guide, deprecation warnings |
| turbo.json cache invalidation | Medium | Low | Rebuild cache from scratch after restructure |
| Browser support regression | Low | Low | Already broken, explicitly deferred |
| Stale native path references after layout move | Medium | Medium | Grep all references to `crates/`, `wasmvm/` in CI, scripts, docs, CLAUDE.md; verify `cargo build` and `make wasm` post-move |
| CI workflows break from path changes | Medium | Medium | Update `.github/workflows/` glob patterns and cache keys in same PR as moves |

## Success Criteria

1. `pnpm install && pnpm turbo build && pnpm turbo check-types` passes.
2. All existing tests pass (with import path updates).
3. `secure-exec` re-exports `@secure-exec/nodejs` 1:1 — no code in the package.
4. `@secure-exec/core` has zero heavy dependencies (no esbuild, sucrase, etc.).
5. The user-facing API is `createKernel()` + `kernel.mount()` + `kernel.exec()`.
6. Adding WasmVM/Python is one import + one `mount()` call — no API change.
7. No duplicate type definitions between packages.
8. All docs updated to reflect new API.
9. All Rust/C code lives under `native/`. All TypeScript packages live under `packages/`. No code at the repo root.
10. `cd native/v8-runtime && cargo build` and `cd native/wasmvm && make wasm` both succeed.
11. No remaining references to old paths (`crates/v8-runtime`, top-level `wasmvm/`) in CI, scripts, docs, or CLAUDE.md.
