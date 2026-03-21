/**
 * Test helpers for WasmVM unit tests.
 *
 * Provides concrete implementations of the WASI interfaces
 * (VFS, FDTable, bridges) for testing. These are the standalone
 * implementations that were previously in src/ — now they live
 * in test infrastructure since production code delegates to the kernel.
 */

export { VFS, VfsError } from './test-vfs.ts';
export type { VfsErrorCode } from './test-vfs.ts';
export { FDTable } from './test-fd-table.ts';
export { createStandaloneFileIO, createStandaloneProcessIO } from './test-bridges.ts';

// Re-export all WASI constants and types for convenience
export * from '../../src/wasi-constants.ts';
export * from '../../src/wasi-types.ts';
