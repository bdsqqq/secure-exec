/**
 * File I/O bridge interface for WASI polyfill kernel delegation.
 *
 * Abstracts file data access so the polyfill does not directly touch
 * VFS inodes. When mounted in the kernel, implementations wrap
 * KernelInterface with a bound pid. For testing, a standalone
 * implementation wraps an in-memory VFS + FDTable.
 */

/**
 * Synchronous file I/O interface for the WASI polyfill.
 *
 * Method signatures are designed to map cleanly to KernelInterface
 * fdRead/fdWrite/fdOpen/fdSeek/fdClose when the kernel is connected.
 */
export interface WasiFileIO {
  /** Read up to maxBytes from fd at current cursor. Advances cursor. */
  fdRead(fd: number, maxBytes: number): { errno: number; data: Uint8Array };

  /** Write data to fd at current cursor (or end if append). Advances cursor. */
  fdWrite(fd: number, data: Uint8Array): { errno: number; written: number };

  /** Open file at resolved path. Handles CREAT/EXCL/TRUNC/DIRECTORY. */
  fdOpen(
    path: string, dirflags: number, oflags: number, fdflags: number,
    rightsBase: bigint, rightsInheriting: bigint,
  ): { errno: number; fd: number; filetype: number };

  /** Seek within fd. Returns new cursor position. */
  fdSeek(fd: number, offset: bigint, whence: number): { errno: number; newOffset: bigint };

  /** Close fd. */
  fdClose(fd: number): number;

  /** Positional read (no cursor change). */
  fdPread(fd: number, maxBytes: number, offset: bigint): { errno: number; data: Uint8Array };

  /** Positional write (no cursor change). */
  fdPwrite(fd: number, data: Uint8Array, offset: bigint): { errno: number; written: number };
}
