## Context

The current sandboxed-node runtime still routes key filesystem operations through helper fallbacks that probe by reading file data (`readFile`) or recursively probing directories (`readDir`), which introduces avoidable O(file size) cost and denial-of-service exposure on large files. The bridge `fs` implementation also contains hardcoded open-flag integers, and runtime assembly logic remains concentrated in a single large `index.ts`, increasing change risk for cross-cutting fixes.

This change touches isolate setup, bridge wiring, driver contracts, and compatibility process requirements, so it needs a coordinated design that keeps runtime behavior close to Node.js semantics while removing known correctness and performance hazards.

## Goals / Non-Goals

**Goals:**
- Add explicit metadata operations to the `VirtualFileSystem` contract so `stat` and existence checks are metadata-based rather than content-based.
- Remove N+1 directory type probing in helper/runtime paths via typed directory entry support.
- Ensure `rename` semantics are atomic when the active driver supports atomic rename, and deterministic/documented when it does not.
- Replace magic open-flag integers in bridge `fs` with named constants that encode Node `fs.constants` semantics.
- Split `packages/sandboxed-node/src/index.ts` into focused modules (`isolate.ts`, `module-resolver.ts`, `esm-compiler.ts`, `bridge-setup.ts`, `execution.ts`) without changing external runtime contracts.

**Non-Goals:**
- Expanding the bridge to new third-party modules or new host capabilities.
- Changing sandbox permission policy defaults.
- Reworking unrelated stdlib support tiers beyond fs metadata/rename behavior.
- Running full-suite refactors outside the runtime/bridge/fs helper path needed for this change.

## Decisions

### 1. Standardize metadata operations in the VirtualFileSystem contract

Decision:
- Require `VirtualFileSystem.stat(path)` and keep `exists(path)` as a metadata/access operation.
- Introduce typed directory entry support (`readDirWithTypes`) in the VFS contract so callers can obtain `name` + directory/file type without per-entry secondary probes.
- Update wrappers/stubs/drivers (`node`, `browser`, `in-memory`) to implement the new metadata methods.

Rationale:
- Metadata APIs are the only safe way to keep `stat` and `exists` O(1) with respect to file size.
- Typed directory listings remove repeated I/O from `readDirWithTypes` helper loops and better match Node `readdir(..., { withFileTypes: true })` semantics.

Alternatives considered:
- Keep helper fallback that reads full files: rejected due to performance/DoS risk.
- Add only `stat` and derive types via per-entry `stat` calls: rejected because it still creates avoidable N+1 roundtrips.

### 2. Move rename semantics to driver-native operations

Decision:
- Add/require `VirtualFileSystem.rename(oldPath, newPath)` and route bridge/runtime rename through that operation.
- Remove helper-level copy-write-delete rename emulation from default execution path.
- If a driver cannot provide atomic rename (for example limited browser filesystem APIs), require deterministic documented behavior and corresponding compatibility/friction updates in the same change.

Rationale:
- Native rename is the only path that can preserve atomicity guarantees where the backing filesystem supports them.
- Copy-delete fallback can duplicate or lose data on interruption and should not be treated as equivalent behavior.

Alternatives considered:
- Keep copy-delete fallback silently: rejected because it hides correctness risk.
- Force all drivers to guarantee atomic rename immediately: rejected because browser APIs may lack equivalent primitives.

### 3. Replace fs open-flag magic numbers with named constants

Decision:
- Define named open-flag constants in `packages/sandboxed-node/src/bridge/fs.ts` and build string-flag mappings using constant composition (`O_WRONLY | O_CREAT | O_TRUNC`, etc.).
- Keep behavior aligned with Node-compatible `fs.constants` values used by the bridge.

Rationale:
- Named constants make cross-platform intent explicit and prevent undocumented Linux-specific literal drift.
- Constant composition is easier to audit and validate against Node semantics.

Alternatives considered:
- Keep integer literals with comments: rejected because it preserves fragile implicit coupling.

### 4. Extract runtime assembly from `index.ts` into focused modules

Decision:
- Extract core concerns into dedicated modules:
  - `isolate.ts`: isolate lifecycle and timing/timeout helpers.
  - `module-resolver.ts`: module specifier normalization and resolution coordination.
  - `esm-compiler.ts`: ESM wrapping, compile/evaluate glue, and dynamic-import compile path.
  - `bridge-setup.ts`: bridge references (`_fs`, network, child process) and isolate global wiring.
  - `execution.ts`: `exec`/`run` orchestration, completion waiting, timeout normalization.
- Keep `index.ts` as public API surface and composition root.

Rationale:
- The current monolith increases regression risk and makes targeted fixes harder to review/test.
- Focused modules improve maintainability without changing public API behavior.

Alternatives considered:
- Keep single file and only add comments: rejected as insufficient for ongoing growth.
- Full class hierarchy rewrite: rejected as unnecessary scope expansion.

## Risks / Trade-offs

- [Driver API expansion may break custom drivers at compile time] -> Mitigation: document required methods clearly, update built-in drivers/stubs in the same change, and add migration notes in release/change docs.
- [Browser filesystem may not support fully atomic rename] -> Mitigation: use best available primitive when available; otherwise return deterministic documented limitation and update friction/compatibility docs.
- [Module extraction may introduce regressions] -> Mitigation: preserve behavior-first tests, migrate in small commits, and run targeted `vitest` + `tsc` checks for sandboxed-node during extraction.
- [Metadata semantics may drift from Node] -> Mitigation: add parity scenarios and compatibility matrix fixtures validating `code/stdout/stderr` equivalence for metadata/rename operations.

## Migration Plan

1. Expand `VirtualFileSystem` types and shared wrappers/stubs for `stat`, typed readdir, and `rename`.
2. Update drivers (`NodeFileSystem`, browser OPFS/memory, in-memory shared FS) to provide metadata-native implementations.
3. Refactor `fs-helpers.ts`, `package-bundler.ts`, runtime bridge setup, and browser worker paths to consume metadata APIs and remove content-probing fallbacks.
4. Replace bridge fs open-flag literals with named constants and verify bridge type conformance checks.
5. Extract `index.ts` logic into the planned modules while keeping exports and runtime contracts stable.
6. Add/update targeted tests and compatibility project-matrix fixtures for metadata behavior and rename semantics.
7. Update `docs-internal/friction/sandboxed-node.md` and related compatibility docs for any intentional Node deviation (especially non-atomic rename limitations in unsupported environments).

Rollback:
- Revert extracted-module wiring to previous `index.ts` monolith and revert VFS contract expansion if regressions are found before release.

## Open Questions

- For browser OPFS drivers where atomic rename primitives are unavailable, should unsupported atomic semantics fail with `ENOSYS` or `EXDEV` to best match Node expectations for cross-device/non-atomic constraints?
- Should `readDirWithTypes` be mandatory for all VFS implementations immediately, or introduced as required for built-in drivers with transitional adapter shims for external custom drivers?
