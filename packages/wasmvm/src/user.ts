/**
 * JS host_user syscall implementations.
 *
 * Provides configurable user/group identity and terminal detection
 * for the WASM module via the host_user import functions:
 * getuid, getgid, geteuid, getegid, isatty, getpwuid.
 */

import { FILETYPE_CHARACTER_DEVICE } from './wasi-constants.js';
import type { WasiFDTable } from './wasi-types.js';

const ERRNO_SUCCESS = 0;
const ERRNO_EBADF = 8;
const ERRNO_ENOSYS = 52;

export interface UserManagerOptions {
  getMemory: () => WebAssembly.Memory | null;
  fdTable?: WasiFDTable;
  uid?: number;
  gid?: number;
  euid?: number;
  egid?: number;
  username?: string;
  homedir?: string;
  shell?: string;
  gecos?: string;
  ttyFds?: Set<number> | boolean;
}

export interface HostUserImports {
  getuid: (ret_uid: number) => number;
  getgid: (ret_gid: number) => number;
  geteuid: (ret_uid: number) => number;
  getegid: (ret_gid: number) => number;
  isatty: (fd: number, ret_bool: number) => number;
  getpwuid: (uid: number, buf_ptr: number, buf_len: number, ret_len: number) => number;
}

/**
 * Manages user/group identity and terminal detection for WASM processes.
 */
export class UserManager {
  private _getMemory: () => WebAssembly.Memory | null;
  private _fdTable: WasiFDTable | null;
  private _uid: number;
  private _gid: number;
  private _euid: number;
  private _egid: number;
  private _username: string;
  private _homedir: string;
  private _shell: string;
  private _gecos: string;
  private _ttyFds: Set<number>;

  constructor(options: UserManagerOptions) {
    this._getMemory = options.getMemory;
    this._fdTable = options.fdTable || null;
    this._uid = options.uid ?? 1000;
    this._gid = options.gid ?? 1000;
    this._euid = options.euid ?? this._uid;
    this._egid = options.egid ?? this._gid;
    this._username = options.username ?? 'user';
    this._homedir = options.homedir ?? '/home/user';
    this._shell = options.shell ?? '/bin/sh';
    this._gecos = options.gecos ?? '';

    // Configure which fds are TTYs
    if (options.ttyFds === true) {
      this._ttyFds = new Set([0, 1, 2]);
    } else if (options.ttyFds instanceof Set) {
      this._ttyFds = options.ttyFds;
    } else {
      this._ttyFds = new Set(); // default: nothing is a TTY
    }
  }

  /**
   * Get the WASI import object for host_user functions.
   * All functions follow the wasi-ext signatures (return errno, out-params via pointers).
   */
  getImports(): HostUserImports {
    return {
      getuid: (ret_uid: number) => this._getuid(ret_uid),
      getgid: (ret_gid: number) => this._getgid(ret_gid),
      geteuid: (ret_uid: number) => this._geteuid(ret_uid),
      getegid: (ret_gid: number) => this._getegid(ret_gid),
      isatty: (fd: number, ret_bool: number) => this._isatty(fd, ret_bool),
      getpwuid: (uid: number, buf_ptr: number, buf_len: number, ret_len: number) =>
        this._getpwuid(uid, buf_ptr, buf_len, ret_len),
    };
  }

  private _getuid(ret_uid: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;
    new DataView(mem.buffer).setUint32(ret_uid, this._uid, true);
    return ERRNO_SUCCESS;
  }

  private _getgid(ret_gid: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;
    new DataView(mem.buffer).setUint32(ret_gid, this._gid, true);
    return ERRNO_SUCCESS;
  }

  private _geteuid(ret_uid: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;
    new DataView(mem.buffer).setUint32(ret_uid, this._euid, true);
    return ERRNO_SUCCESS;
  }

  private _getegid(ret_gid: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;
    new DataView(mem.buffer).setUint32(ret_gid, this._egid, true);
    return ERRNO_SUCCESS;
  }

  private _isatty(fd: number, ret_bool: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;

    let isTty = 0;

    if (this._fdTable) {
      const entry = this._fdTable.get(fd);
      if (!entry) {
        new DataView(mem.buffer).setUint32(ret_bool, 0, true);
        return ERRNO_EBADF;
      }
      // Only character devices can be TTYs
      if (entry.filetype === FILETYPE_CHARACTER_DEVICE && this._ttyFds.has(fd)) {
        isTty = 1;
      }
    } else {
      // No fdTable — just check ttyFds set
      isTty = this._ttyFds.has(fd) ? 1 : 0;
    }

    new DataView(mem.buffer).setUint32(ret_bool, isTty, true);
    return ERRNO_SUCCESS;
  }

  private _getpwuid(uid: number, buf_ptr: number, buf_len: number, ret_len: number): number {
    const mem = this._getMemory();
    if (!mem) return ERRNO_ENOSYS;

    // Build passwd string for the requested uid
    let username: string, homedir: string, gecos: string, shell: string, gid: number;
    if (uid === this._uid) {
      username = this._username;
      homedir = this._homedir;
      gecos = this._gecos;
      shell = this._shell;
      gid = this._gid;
    } else {
      // Generic entry for unknown uids
      username = `user${uid}`;
      homedir = `/home/${username}`;
      gecos = '';
      shell = '/bin/sh';
      gid = uid; // assume gid == uid for unknown users
    }

    const passwd = `${username}:x:${uid}:${gid}:${gecos}:${homedir}:${shell}`;
    const bytes = new TextEncoder().encode(passwd);
    const len = Math.min(bytes.length, buf_len);

    new Uint8Array(mem.buffer).set(bytes.subarray(0, len), buf_ptr);
    new DataView(mem.buffer).setUint32(ret_len, len, true);

    return ERRNO_SUCCESS;
  }
}
