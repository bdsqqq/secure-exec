## 1. Expand Virtual Filesystem Metadata Contracts

- [x] 1.1 Add `stat`, metadata `exists`, and typed directory entry (`readDirWithTypes`) support to `VirtualFileSystem` in `packages/sandboxed-node/src/types.ts` and update exported types as needed.
- [x] 1.2 Update filesystem wrappers/stubs in `packages/sandboxed-node/src/shared/permissions.ts` to enforce permissions for metadata and rename operations (`exists`, `stat`, `readDirWithTypes`, `rename`).
- [x] 1.3 Implement new metadata/rename methods in built-in drivers (`node/driver.ts`, `browser/driver.ts`, `shared/in-memory-fs.ts`) with Node-compatible behavior contracts.

## 2. Remove O(file size) and N+1 Helper Paths

- [x] 2.1 Refactor `packages/sandboxed-node/src/fs-helpers.ts` so `stat` and `exists` delegate to metadata APIs instead of reading file contents.
- [x] 2.2 Replace `readDirWithTypes` per-entry probing with single-pass typed directory entry retrieval and remove per-entry probe loops.
- [x] 2.3 Replace helper-level copy-write-delete rename with driver-native rename semantics (atomic where supported, explicit documented limitation where not).
- [x] 2.4 Update runtime consumers (`index.ts`, `browser/worker.ts`, `package-bundler.ts`) to use the new metadata APIs.

## 3. Bridge FS Constant and Semantics Cleanup

- [x] 3.1 Replace magic open-flag integers in `packages/sandboxed-node/src/bridge/fs.ts` with named constants and constant composition matching Node `fs.constants` semantics.
- [x] 3.2 Ensure bridge `stat`, `exists`, and typed `readdir` paths preserve metadata-only behavior and do not trigger file-content reads.
- [x] 3.3 Run bridge type conformance checks (`pnpm run check-types:test` in `packages/sandboxed-node`) after bridge updates.

## 4. Split Monolithic Runtime Assembly

- [x] 4.1 Extract isolate lifecycle and timeout/timing helpers into `packages/sandboxed-node/src/isolate.ts`.
- [x] 4.2 Extract module resolution logic into `packages/sandboxed-node/src/module-resolver.ts`.
- [x] 4.3 Extract ESM compilation/wrapping logic into `packages/sandboxed-node/src/esm-compiler.ts`.
- [x] 4.4 Extract bridge reference wiring into `packages/sandboxed-node/src/bridge-setup.ts`.
- [x] 4.5 Extract execution orchestration into `packages/sandboxed-node/src/execution.ts` and reduce `index.ts` to API surface/composition.

## 5. Compatibility, Friction, and Verification

- [x] 5.1 Add or update black-box compatibility project fixtures under `packages/sandboxed-node/tests/projects/` for `stat`, `exists`, typed `readdir`, and rename semantics parity.
- [x] 5.2 Update `docs-internal/friction/sandboxed-node.md` with resolved notes and any intentional Node deviation (for example non-atomic rename limits on specific drivers).
- [x] 5.3 Update compatibility documentation (including matrix references) for metadata/rename behavior changes.
- [x] 5.4 Run targeted verification: `pnpm vitest` for affected sandboxed-node tests, `pnpm tsc --noEmit` (or package typecheck script), and `pnpm turbo build --filter sandboxed-node`.
