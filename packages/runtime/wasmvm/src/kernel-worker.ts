/**
 * Worker entry for WasmVM kernel-integrated execution.
 *
 * Runs a single WASM command inside a worker thread. Communicates
 * with the main thread via SharedArrayBuffer RPC for synchronous
 * kernel calls (file I/O, VFS, process spawn) and postMessage for
 * stdout/stderr streaming.
 *
 * proc_spawn is provided as a host_process import so brush-shell
 * pipeline stages route through KernelInterface.spawn() to the
 * correct runtime driver.
 */

import { workerData, parentPort } from 'node:worker_threads';
import { readFile } from 'node:fs/promises';
import { WasiPolyfill, WasiProcExit } from './wasi-polyfill.ts';
import { UserManager } from './user.ts';
import { FDTable } from '../test/helpers/test-fd-table.ts';
import {
  FILETYPE_CHARACTER_DEVICE,
  FILETYPE_REGULAR_FILE,
  ERRNO_SUCCESS,
  ERRNO_EINVAL,
} from './wasi-constants.ts';
import { VfsError } from './wasi-types.ts';
import type { WasiVFS, WasiInode, VfsStat, VfsSnapshotEntry } from './wasi-types.ts';
import type { WasiFileIO } from './wasi-file-io.ts';
import type { WasiProcessIO } from './wasi-process-io.ts';
import {
  SIG_IDX_STATE,
  SIG_IDX_ERRNO,
  SIG_IDX_INT_RESULT,
  SIG_IDX_DATA_LEN,
  SIG_STATE_IDLE,
  SIG_STATE_READY,
  RPC_WAIT_TIMEOUT_MS,
  type WorkerInitData,
  type SyscallRequest,
} from './syscall-rpc.ts';

const port = parentPort!;
const init = workerData as WorkerInitData;

// -------------------------------------------------------------------------
// RPC client — blocks worker thread until main thread responds
// -------------------------------------------------------------------------

const signalArr = new Int32Array(init.signalBuf);
const dataArr = new Uint8Array(init.dataBuf);

function rpcCall(call: string, args: Record<string, unknown>): {
  errno: number;
  intResult: number;
  data: Uint8Array;
} {
  // Reset signal
  Atomics.store(signalArr, SIG_IDX_STATE, SIG_STATE_IDLE);

  // Post request
  const msg: SyscallRequest = { type: 'syscall', call, args };
  port.postMessage(msg);

  // Block until response
  const result = Atomics.wait(signalArr, SIG_IDX_STATE, SIG_STATE_IDLE, RPC_WAIT_TIMEOUT_MS);
  if (result === 'timed-out') {
    return { errno: 76 /* EIO */, intResult: 0, data: new Uint8Array(0) };
  }

  // Read response
  const errno = Atomics.load(signalArr, SIG_IDX_ERRNO);
  const intResult = Atomics.load(signalArr, SIG_IDX_INT_RESULT);
  const dataLen = Atomics.load(signalArr, SIG_IDX_DATA_LEN);
  const data = dataLen > 0 ? dataArr.slice(0, dataLen) : new Uint8Array(0);

  // Reset for next call
  Atomics.store(signalArr, SIG_IDX_STATE, SIG_STATE_IDLE);

  return { errno, intResult, data };
}

// -------------------------------------------------------------------------
// Local FD table — mirrors kernel state for rights checking / routing
// -------------------------------------------------------------------------

const fdTable = new FDTable();

// -------------------------------------------------------------------------
// Kernel-backed WasiFileIO
// -------------------------------------------------------------------------

function createKernelFileIO(): WasiFileIO {
  return {
    fdRead(fd, maxBytes) {
      const res = rpcCall('fdRead', { fd, length: maxBytes });
      return { errno: res.errno, data: res.data };
    },
    fdWrite(fd, data) {
      const res = rpcCall('fdWrite', { fd, data: Array.from(data) });
      return { errno: res.errno, written: res.intResult };
    },
    fdOpen(path, dirflags, oflags, fdflags, rightsBase, rightsInheriting) {
      // Map WASI oflags to POSIX open flags for kernel
      let flags = 0;
      if (oflags & 0x1) flags |= 0o100;   // O_CREAT
      if (oflags & 0x2) flags |= 0o200;   // O_EXCL
      if (oflags & 0x4) flags |= 0o1000;  // O_TRUNC
      if (fdflags & 0x1) flags |= 0o2000; // O_APPEND
      if (rightsBase & 2n) flags |= 1;     // O_WRONLY

      const res = rpcCall('fdOpen', { path, flags, mode: 0o666 });
      if (res.errno !== 0) return { errno: res.errno, fd: -1, filetype: 0 };

      // Mirror in local FDTable for polyfill rights checking
      const localFd = fdTable.open(
        { type: 'vfsFile', ino: 0, path },
        { filetype: FILETYPE_REGULAR_FILE, rightsBase, rightsInheriting, fdflags, path },
      );
      return { errno: 0, fd: localFd, filetype: FILETYPE_REGULAR_FILE };
    },
    fdSeek(fd, offset, whence) {
      const res = rpcCall('fdSeek', { fd, offset: offset.toString(), whence });
      return { errno: res.errno, newOffset: BigInt(res.intResult) };
    },
    fdClose(fd) {
      fdTable.close(fd);
      const res = rpcCall('fdClose', { fd });
      return res.errno;
    },
    fdPread(fd, maxBytes, _offset) {
      const res = rpcCall('fdRead', { fd, length: maxBytes });
      return { errno: res.errno, data: res.data };
    },
    fdPwrite(fd, data, _offset) {
      const res = rpcCall('fdWrite', { fd, data: Array.from(data) });
      return { errno: res.errno, written: res.intResult };
    },
  };
}

// -------------------------------------------------------------------------
// Kernel-backed WasiProcessIO
// -------------------------------------------------------------------------

function createKernelProcessIO(): WasiProcessIO {
  return {
    getArgs() {
      return [init.command, ...init.args];
    },
    getEnviron() {
      return init.env;
    },
    fdFdstatGet(fd) {
      const entry = fdTable.get(fd);
      if (!entry) {
        return { errno: 8 /* EBADF */, filetype: 0, fdflags: 0, rightsBase: 0n, rightsInheriting: 0n };
      }
      return {
        errno: 0,
        filetype: entry.filetype,
        fdflags: entry.fdflags,
        rightsBase: entry.rightsBase,
        rightsInheriting: entry.rightsInheriting,
      };
    },
    procExit(exitCode) {
      // Exit notification handled by WasiProcExit exception path
    },
  };
}

// -------------------------------------------------------------------------
// Kernel-backed VFS proxy — routes through RPC
// -------------------------------------------------------------------------

function createKernelVfs(): WasiVFS {
  const decoder = new TextDecoder();

  return {
    exists(path: string): boolean {
      const res = rpcCall('vfsExists', { path });
      return res.errno === 0 && res.intResult === 1;
    },
    mkdir(path: string): void {
      const res = rpcCall('vfsMkdir', { path });
      if (res.errno !== 0) throw new VfsError('EACCES', path);
    },
    mkdirp(path: string): void {
      const segments = path.split('/').filter(Boolean);
      let current = '';
      for (const seg of segments) {
        current += '/' + seg;
        const exists = rpcCall('vfsExists', { path: current });
        if (exists.errno === 0 && exists.intResult === 0) {
          rpcCall('vfsMkdir', { path: current });
        }
      }
    },
    writeFile(path: string, data: Uint8Array | string): void {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
      rpcCall('vfsWriteFile', { path, data: Array.from(bytes) });
    },
    readFile(path: string): Uint8Array {
      const res = rpcCall('vfsReadFile', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
      return res.data;
    },
    readdir(path: string): string[] {
      const res = rpcCall('vfsReaddir', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
      return JSON.parse(decoder.decode(res.data));
    },
    stat(path: string): VfsStat {
      const res = rpcCall('vfsStat', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
      return JSON.parse(decoder.decode(res.data));
    },
    lstat(path: string): VfsStat {
      return this.stat(path);
    },
    unlink(path: string): void {
      const res = rpcCall('vfsUnlink', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
    },
    rmdir(path: string): void {
      const res = rpcCall('vfsRmdir', { path });
      if (res.errno !== 0) throw new VfsError('ENOENT', path);
    },
    rename(oldPath: string, newPath: string): void {
      const res = rpcCall('vfsRename', { oldPath, newPath });
      if (res.errno !== 0) throw new VfsError('ENOENT', oldPath);
    },
    symlink(target: string, linkPath: string): void {
      const res = rpcCall('vfsSymlink', { target, linkPath });
      if (res.errno !== 0) throw new VfsError('EEXIST', linkPath);
    },
    readlink(path: string): string {
      const res = rpcCall('vfsReadlink', { path });
      if (res.errno !== 0) throw new VfsError('EINVAL', path);
      return decoder.decode(res.data);
    },
    chmod(_path: string, _mode: number): void {
      // No-op — permissions handled by kernel
    },
    getIno(_path: string): number | null {
      return null;
    },
    getInodeByIno(_ino: number): WasiInode | null {
      return null;
    },
    snapshot(): VfsSnapshotEntry[] {
      return [];
    },
  };
}

// -------------------------------------------------------------------------
// Host process imports — proc_spawn, fd_pipe, proc_kill route through kernel
// -------------------------------------------------------------------------

function createHostProcessImports(getMemory: () => WebAssembly.Memory | null) {
  return {
    /**
     * proc_spawn routes through KernelInterface.spawn() so brush-shell
     * pipeline stages dispatch to the correct runtime driver.
     *
     * Matches Rust FFI: proc_spawn(argv_ptr, argv_len, envp_ptr, envp_len,
     *   stdin_fd, stdout_fd, stderr_fd, cwd_ptr, cwd_len, ret_pid) -> errno
     */
    proc_spawn(
      argv_ptr: number, argv_len: number,
      envp_ptr: number, envp_len: number,
      stdin_fd: number, stdout_fd: number, stderr_fd: number,
      cwd_ptr: number, cwd_len: number,
      ret_pid_ptr: number,
    ): number {
      const mem = getMemory();
      if (!mem) return ERRNO_EINVAL;

      const bytes = new Uint8Array(mem.buffer);
      const decoder = new TextDecoder();

      // Parse null-separated argv buffer — first entry is the command
      const argvRaw = decoder.decode(bytes.slice(argv_ptr, argv_ptr + argv_len));
      const argvParts = argvRaw.split('\0').filter(Boolean);
      const command = argvParts[0] ?? '';
      const args = argvParts.slice(1);

      // Parse null-separated envp buffer (KEY=VALUE\0 pairs)
      const env: Record<string, string> = {};
      if (envp_len > 0) {
        const envpRaw = decoder.decode(bytes.slice(envp_ptr, envp_ptr + envp_len));
        for (const entry of envpRaw.split('\0')) {
          if (!entry) continue;
          const eq = entry.indexOf('=');
          if (eq > 0) env[entry.slice(0, eq)] = entry.slice(eq + 1);
        }
      }

      // Parse cwd
      const cwd = cwd_len > 0
        ? decoder.decode(bytes.slice(cwd_ptr, cwd_ptr + cwd_len))
        : init.cwd;

      // Route through kernel with FD overrides for pipe wiring
      const res = rpcCall('spawn', {
        command,
        spawnArgs: args,
        env,
        cwd,
        stdinFd: stdin_fd,
        stdoutFd: stdout_fd,
        stderrFd: stderr_fd,
      });

      if (res.errno !== 0) return res.errno;
      new DataView(mem.buffer).setUint32(ret_pid_ptr, res.intResult, true);
      return ERRNO_SUCCESS;
    },

    /**
     * proc_waitpid(pid, options, ret_status) -> errno
     * options: 0 = blocking, 1 = WNOHANG
     */
    proc_waitpid(pid: number, _options: number, ret_status_ptr: number): number {
      const mem = getMemory();
      if (!mem) return ERRNO_EINVAL;

      const res = rpcCall('waitpid', { pid });
      if (res.errno !== 0) return res.errno;

      new DataView(mem.buffer).setUint32(ret_status_ptr, res.intResult, true);
      return ERRNO_SUCCESS;
    },

    /** proc_kill(pid, signal) -> errno */
    proc_kill(pid: number, signal: number): number {
      const res = rpcCall('kill', { pid, signal });
      return res.errno;
    },

    /**
     * fd_pipe(ret_read_fd, ret_write_fd) -> errno
     * Creates a kernel pipe and installs both ends in this process's FD table.
     */
    fd_pipe(ret_read_fd_ptr: number, ret_write_fd_ptr: number): number {
      const mem = getMemory();
      if (!mem) return ERRNO_EINVAL;

      const res = rpcCall('pipe', {});
      if (res.errno !== 0) return res.errno;

      const view = new DataView(mem.buffer);
      // Read/write FDs packed in intResult: read in low 16 bits, write in high 16 bits
      const readFd = res.intResult & 0xFFFF;
      const writeFd = (res.intResult >>> 16) & 0xFFFF;
      view.setUint32(ret_read_fd_ptr, readFd, true);
      view.setUint32(ret_write_fd_ptr, writeFd, true);
      return ERRNO_SUCCESS;
    },
  };
}

// -------------------------------------------------------------------------
// Main execution
// -------------------------------------------------------------------------

async function main(): Promise<void> {
  let wasmMemory: WebAssembly.Memory | null = null;
  const getMemory = () => wasmMemory;

  const fileIO = createKernelFileIO();
  const processIO = createKernelProcessIO();
  const vfs = createKernelVfs();

  const polyfill = new WasiPolyfill(fdTable, vfs, {
    fileIO,
    processIO,
    args: [init.command, ...init.args],
    env: init.env,
  });

  // Route stdin through kernel pipe when piped
  if (init.stdinFd !== undefined) {
    polyfill.setStdinReader((buf, offset, length) => {
      const res = rpcCall('fdRead', { fd: 0, length });
      if (res.errno !== 0 || res.data.length === 0) return 0; // EOF or error
      const n = Math.min(res.data.length, length);
      buf.set(res.data.subarray(0, n), offset);
      return n;
    });
  }

  // Stream stdout/stderr — route through kernel pipe when FD is overridden,
  // otherwise stream to main thread via postMessage
  if (init.stdoutFd !== undefined && init.stdoutFd !== 1) {
    // Stdout is piped — route writes through kernel fdWrite on FD 1
    polyfill.setStdoutWriter((buf, offset, length) => {
      const data = buf.slice(offset, offset + length);
      rpcCall('fdWrite', { fd: 1, data: Array.from(data) });
      return length;
    });
  } else {
    polyfill.setStdoutWriter((buf, offset, length) => {
      port.postMessage({ type: 'stdout', data: buf.slice(offset, offset + length) });
      return length;
    });
  }
  if (init.stderrFd !== undefined && init.stderrFd !== 2) {
    // Stderr is piped — route writes through kernel fdWrite on FD 2
    polyfill.setStderrWriter((buf, offset, length) => {
      const data = buf.slice(offset, offset + length);
      rpcCall('fdWrite', { fd: 2, data: Array.from(data) });
      return length;
    });
  } else {
    polyfill.setStderrWriter((buf, offset, length) => {
      port.postMessage({ type: 'stderr', data: buf.slice(offset, offset + length) });
      return length;
    });
  }

  const userManager = new UserManager({
    getMemory,
    fdTable,
    ttyFds: false,
  });

  const hostProcess = createHostProcessImports(getMemory);

  try {
    // Load WASM binary
    const wasmBytes = await readFile(init.wasmBinaryPath);
    const wasmModule = await WebAssembly.compile(wasmBytes);

    const imports: WebAssembly.Imports = {
      wasi_snapshot_preview1: polyfill.getImports() as WebAssembly.ModuleImports,
      host_user: userManager.getImports() as unknown as WebAssembly.ModuleImports,
      host_process: hostProcess as unknown as WebAssembly.ModuleImports,
    };

    const instance = await WebAssembly.instantiate(wasmModule, imports);
    wasmMemory = instance.exports.memory as WebAssembly.Memory;
    polyfill.setMemory(wasmMemory);

    // Run the command
    const start = instance.exports._start as () => void;
    start();

    // Normal exit — flush collected output, close piped FDs for EOF
    flushOutput(polyfill);
    closePipedFds();
    port.postMessage({ type: 'exit', code: 0 });
  } catch (err) {
    if (err instanceof WasiProcExit) {
      flushOutput(polyfill);
      closePipedFds();
      port.postMessage({ type: 'exit', code: err.exitCode });
    } else {
      const errMsg = err instanceof Error ? err.message : String(err);
      port.postMessage({ type: 'stderr', data: new TextEncoder().encode(errMsg + '\n') });
      closePipedFds();
      port.postMessage({ type: 'exit', code: 1 });
    }
  }
}

/** Close piped stdio FDs so readers get EOF. */
function closePipedFds(): void {
  if (init.stdoutFd !== undefined && init.stdoutFd !== 1) {
    rpcCall('fdClose', { fd: 1 });
  }
  if (init.stderrFd !== undefined && init.stderrFd !== 2) {
    rpcCall('fdClose', { fd: 2 });
  }
}

/** Flush any remaining collected output (not caught by streaming writers). */
function flushOutput(polyfill: WasiPolyfill): void {
  const stdout = polyfill.stdout;
  if (stdout.length > 0) port.postMessage({ type: 'stdout', data: stdout });
  const stderr = polyfill.stderr;
  if (stderr.length > 0) port.postMessage({ type: 'stderr', data: stderr });
}

main().catch((err) => {
  const errMsg = err instanceof Error ? err.message : String(err);
  port.postMessage({ type: 'stderr', data: new TextEncoder().encode(errMsg + '\n') });
  port.postMessage({ type: 'exit', code: 1 });
});
