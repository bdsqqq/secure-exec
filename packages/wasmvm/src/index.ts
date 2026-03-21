/**
 * wasmVM WasmCore host runtime.
 *
 * Exports the WASI polyfill and supporting types. The polyfill delegates
 * all OS-layer state (VFS, FD table, process table) to the kernel.
 *
 * @module @wasmvm/host
 */

export { WasiPolyfill, WasiProcExit } from './wasi-polyfill.js';
export type { WasiOptions, WasiImports } from './wasi-polyfill.js';
export type { WasiFileIO } from './wasi-file-io.js';
export type { WasiProcessIO } from './wasi-process-io.js';
export { UserManager } from './user.js';
export type { UserManagerOptions, HostUserImports } from './user.js';
export { createWasmVmRuntime, WASMVM_COMMANDS, DEFAULT_FIRST_PARTY_TIERS } from './driver.js';
export type { WasmVmRuntimeOptions } from './driver.js';
export type { PermissionTier } from './syscall-rpc.js';
export { isSpawnBlocked, resolvePermissionTier } from './permission-check.js';
export { ModuleCache } from './module-cache.js';
export { isWasmBinary, isWasmBinarySync } from './wasm-magic.js';
export {
  createBrowserWasmVmRuntime,
  CacheApiBinaryStorage,
  IndexedDbBinaryStorage,
  sha256Hex,
} from './browser-driver.js';
export type {
  BrowserWasmVmRuntimeOptions,
  CommandManifest,
  CommandManifestEntry,
  BinaryStorage,
} from './browser-driver.js';

// Re-export WASI constants and types for downstream consumers
export * from './wasi-constants.js';
export {
  VfsError,
  FDEntry,
  FileDescription,
} from './wasi-types.js';
export type {
  WasiFiletype,
  VfsErrorCode,
  WasiVFS,
  WasiFDTable,
  WasiInode,
  VfsStat,
  VfsSnapshotEntry,
  FDResource,
  StdioResource,
  VfsFileResource,
  PreopenResource,
  PipeBuffer,
  PipeResource,
  FDOpenOptions,
} from './wasi-types.js';
