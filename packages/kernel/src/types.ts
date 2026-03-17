/**
 * Kernel type definitions.
 *
 * The kernel is the shared OS layer. All runtimes make "syscalls" to the
 * kernel for filesystem, process, pipe, and FD operations.
 */

// Re-export VFS types
export type {
	VirtualFileSystem,
	VirtualDirEntry,
	VirtualStat,
} from "./vfs.js";

// ---------------------------------------------------------------------------
// Kernel
// ---------------------------------------------------------------------------

export interface KernelOptions {
	filesystem: import("./vfs.js").VirtualFileSystem;
	permissions?: Permissions;
	env?: Record<string, string>;
	cwd?: string;
}

export interface Kernel {
	/** Mount a runtime driver. Calls driver.init() and registers its commands. */
	mount(driver: RuntimeDriver): Promise<void>;

	/** Dispose the kernel and all mounted drivers. */
	dispose(): Promise<void>;

	/**
	 * Execute a command string through the shell.
	 * Equivalent to: spawn('sh', ['-c', command])
	 * Throws if no shell is mounted (e.g. no WasmVM runtime).
	 */
	exec(command: string, options?: ExecOptions): Promise<ExecResult>;

	/**
	 * Spawn a process directly (no shell interpretation).
	 * The kernel resolves the command via the command registry and delegates
	 * to the appropriate runtime driver.
	 */
	spawn(command: string, args: string[], options?: SpawnOptions): ManagedProcess;

	// Filesystem convenience wrappers
	readFile(path: string): Promise<Uint8Array>;
	writeFile(path: string, content: string | Uint8Array): Promise<void>;
	mkdir(path: string): Promise<void>;
	readdir(path: string): Promise<string[]>;
	stat(path: string): Promise<import("./vfs.js").VirtualStat>;
	exists(path: string): Promise<boolean>;

	// Introspection
	readonly commands: ReadonlyMap<string, string>;
	readonly processes: ReadonlyMap<number, ProcessInfo>;
}

export interface ExecOptions {
	env?: Record<string, string>;
	cwd?: string;
	stdin?: string | Uint8Array;
	timeout?: number;
	onStdout?: (data: Uint8Array) => void;
	onStderr?: (data: Uint8Array) => void;
}

export interface ExecResult {
	exitCode: number;
	stdout: string;
	stderr: string;
}

export interface SpawnOptions extends ExecOptions {
	stdio?: "pipe" | "inherit";
}

export interface ManagedProcess {
	pid: number;
	writeStdin(data: Uint8Array | string): void;
	closeStdin(): void;
	kill(signal?: number): void;
	wait(): Promise<number>;
	readonly exitCode: number | null;
}

// ---------------------------------------------------------------------------
// Runtime Driver
// ---------------------------------------------------------------------------

export interface RuntimeDriver {
	/** Driver name (e.g. 'wasmvm', 'node', 'python') */
	name: string;

	/** Commands this driver handles */
	commands: string[];

	/**
	 * Called when the driver is mounted to the kernel.
	 * Use this to initialize resources (compile WASM, load Pyodide, etc.)
	 */
	init(kernel: KernelInterface): Promise<void>;

	/**
	 * Spawn a process for the given command.
	 * The kernel has already resolved the command to this driver.
	 */
	spawn(command: string, args: string[], ctx: ProcessContext): DriverProcess;

	/** Cleanup resources */
	dispose(): Promise<void>;
}

export interface ProcessContext {
	pid: number;
	ppid: number;
	env: Record<string, string>;
	cwd: string;
	fds: { stdin: number; stdout: number; stderr: number };
	/** Kernel-provided callback for stdout data emitted during spawn. */
	onStdout?: (data: Uint8Array) => void;
	/** Kernel-provided callback for stderr data emitted during spawn. */
	onStderr?: (data: Uint8Array) => void;
}

export interface DriverProcess {
	/** Called by kernel when data is written to this process's stdin FD */
	writeStdin(data: Uint8Array): void;
	closeStdin(): void;

	/** Called by kernel to terminate the process */
	kill(signal: number): void;

	/** Resolves with exit code when process completes */
	wait(): Promise<number>;

	/** Callbacks for the driver to push data to the kernel */
	onStdout: ((data: Uint8Array) => void) | null;
	onStderr: ((data: Uint8Array) => void) | null;
	onExit: ((code: number) => void) | null;
}

// ---------------------------------------------------------------------------
// Kernel Interface (exposed TO drivers)
// ---------------------------------------------------------------------------

/**
 * Interface the kernel exposes TO drivers.
 * Drivers call these methods for kernel services.
 */
export interface KernelInterface {
	// VFS operations
	vfs: import("./vfs.js").VirtualFileSystem;

	// FD operations (per-PID)
	fdOpen(pid: number, path: string, flags: number, mode?: number): number;
	fdRead(pid: number, fd: number, length: number): Promise<Uint8Array>;
	fdWrite(pid: number, fd: number, data: Uint8Array): number;
	fdClose(pid: number, fd: number): void;
	fdSeek(
		pid: number,
		fd: number,
		offset: bigint,
		whence: number,
	): bigint;
	fdDup(pid: number, fd: number): number;
	fdDup2(pid: number, oldFd: number, newFd: number): void;
	fdStat(pid: number, fd: number): FDStat;

	// Process operations
	spawn(
		command: string,
		args: string[],
		ctx: Partial<ProcessContext>,
	): ManagedProcess;
	waitpid(
		pid: number,
		options?: number,
	): Promise<{ pid: number; status: number }>;
	kill(pid: number, signal: number): void;
	getpid(pid: number): number;
	getppid(pid: number): number;

	// Pipe operations
	pipe(): { readFd: number; writeFd: number };

	// Environment
	getenv(pid: number): Record<string, string>;
	getcwd(pid: number): string;
}

// ---------------------------------------------------------------------------
// FD Table types
// ---------------------------------------------------------------------------

export interface FDStat {
	filetype: number;
	flags: number;
	rights: bigint;
}

export interface FileDescription {
	id: number;
	path: string;
	cursor: bigint;
	flags: number;
	refCount: number;
}

export interface FDEntry {
	fd: number;
	description: FileDescription;
	rights: bigint;
	filetype: number;
}

// FD open flags
export const O_RDONLY = 0;
export const O_WRONLY = 1;
export const O_RDWR = 2;
export const O_CREAT = 0o100;
export const O_EXCL = 0o200;
export const O_TRUNC = 0o1000;
export const O_APPEND = 0o2000;

// Seek whence
export const SEEK_SET = 0;
export const SEEK_CUR = 1;
export const SEEK_END = 2;

// File types
export const FILETYPE_UNKNOWN = 0;
export const FILETYPE_CHARACTER_DEVICE = 2;
export const FILETYPE_DIRECTORY = 3;
export const FILETYPE_REGULAR_FILE = 4;
export const FILETYPE_SYMBOLIC_LINK = 7;
export const FILETYPE_PIPE = 6;

// ---------------------------------------------------------------------------
// Process Table types
// ---------------------------------------------------------------------------

export interface ProcessEntry {
	pid: number;
	ppid: number;
	driver: string;
	command: string;
	args: string[];
	status: "running" | "stopped" | "exited";
	exitCode: number | null;
	exitTime: number | null;
	env: Record<string, string>;
	cwd: string;
	driverProcess: DriverProcess;
}

export interface ProcessInfo {
	pid: number;
	ppid: number;
	driver: string;
	command: string;
	status: "running" | "stopped" | "exited";
	exitCode: number | null;
}

// Signals
export const SIGTERM = 15;
export const SIGKILL = 9;
export const SIGINT = 2;

// ---------------------------------------------------------------------------
// Pipe types
// ---------------------------------------------------------------------------

export interface Pipe {
	id: number;
	readFd: number;
	writeFd: number;
	readerPid: number;
	writerPid: number;
	buffer: Uint8Array[];
	closed: { read: boolean; write: boolean };
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermissionDecision {
	allow: boolean;
	reason?: string;
}

export type PermissionCheck<T> = (request: T) => PermissionDecision;

export interface FsAccessRequest {
	op:
		| "read"
		| "write"
		| "mkdir"
		| "createDir"
		| "readdir"
		| "stat"
		| "rm"
		| "rename"
		| "exists"
		| "symlink"
		| "readlink"
		| "link"
		| "chmod"
		| "chown"
		| "utimes"
		| "truncate";
	path: string;
}

export interface NetworkAccessRequest {
	op: "fetch" | "http" | "dns" | "listen";
	url?: string;
	method?: string;
	hostname?: string;
}

export interface ChildProcessAccessRequest {
	command: string;
	args: string[];
	cwd?: string;
	env?: Record<string, string>;
}

export interface EnvAccessRequest {
	op: "read" | "write";
	key: string;
	value?: string;
}

export interface Permissions {
	fs?: PermissionCheck<FsAccessRequest>;
	network?: PermissionCheck<NetworkAccessRequest>;
	childProcess?: PermissionCheck<ChildProcessAccessRequest>;
	env?: PermissionCheck<EnvAccessRequest>;
}
