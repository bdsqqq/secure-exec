## Why

Sandboxed-node still has known filesystem and runtime TODOs that create avoidable performance cliffs and correctness risks, including O(file size) metadata checks, non-atomic rename behavior, and a growing monolithic runtime entrypoint. Capturing these items in one focused change turns backlog debt into explicit runtime and bridge contracts aligned with Node semantics.

## What Changes

- Extend the `VirtualFileSystem` metadata contract so `stat`, metadata-based `exists`, and typed directory entry lookup do not require reading full file contents.
- Replace helper-layer metadata emulation (`readFile`/`readDir` probing) with driver-backed metadata operations and directory-entry typing to remove O(file size) and N+1 filesystem patterns.
- Define and implement `rename` behavior as atomic when supported by the active driver, and explicitly document deterministic fallback behavior when atomic rename is unavailable.
- Replace hardcoded numeric open-flag literals in the fs bridge with named constants derived from Node `fs.constants` semantics.
- Split `packages/sandboxed-node/src/index.ts` into focused runtime modules (`isolate.ts`, `module-resolver.ts`, `esm-compiler.ts`, `bridge-setup.ts`, `execution.ts`) while preserving external runtime behavior.
- Add targeted parity and regression tests that validate metadata operations, directory typing, and rename semantics in both host Node and sandboxed-node compatibility fixtures.

## Capabilities

### New Capabilities
- None.

### Modified Capabilities
- `node-runtime`: tighten filesystem metadata and execution-assembly contracts to remove performance hazards and keep Node-like behavior.
- `node-bridge`: require named flag constants and deterministic bridge-side filesystem metadata/rename behavior.
- `compatibility-governance`: require compatibility/friction documentation updates when filesystem semantics intentionally diverge from default Node behavior.

## Impact

- Affected code:
  - `packages/sandboxed-node/src/types.ts`
  - `packages/sandboxed-node/src/fs-helpers.ts`
  - `packages/sandboxed-node/src/index.ts` and extracted runtime modules
  - `packages/sandboxed-node/src/bridge/fs.ts`
  - filesystem driver implementations under `packages/sandboxed-node/src/node`, `browser`, and `shared`
- Affected tests:
  - sandboxed-node runtime tests and compatibility project-matrix fixtures under `packages/sandboxed-node/tests/projects/`
- API/contract impact:
  - `VirtualFileSystem` gains explicit metadata operations used by runtime and bridge code paths.
- Documentation impact:
  - updates in compatibility/friction docs for any intentional rename-atomicity or metadata-semantic deviations.
