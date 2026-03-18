import type {
	StdioHook,
	ExecOptions,
	ExecResult,
	OSConfig,
	PythonRunOptions,
	PythonRunResult,
	ProcessConfig,
	RunResult,
	TimingMitigation,
} from "./shared/api-types.js";
import type {
	CommandExecutor,
	NetworkAdapter,
	Permissions,
	VirtualFileSystem,
} from "./types.js";

export interface DriverRuntimeConfig {
	process: ProcessConfig;
	os: OSConfig;
}

export interface ResourceBudgets {
	/** Maximum total stdout/stderr bytes before subsequent writes are silently dropped. */
	maxOutputBytes?: number;
	/** Maximum total bridge calls (fs, network, timers, child_process) before errors are returned. */
	maxBridgeCalls?: number;
	/** Maximum concurrent host-side timers (setTimeout/setInterval with delay > 0). */
	maxTimers?: number;
	/** Maximum child_process.spawn() invocations per execution. */
	maxChildProcesses?: number;
	/** Maximum concurrent active handles (child processes, timers, servers) in the bridge handle map. */
	maxHandles?: number;
}

export interface RuntimeDriverOptions {
	system: SystemDriver;
	runtime: DriverRuntimeConfig;
	memoryLimit?: number;
	cpuTimeLimitMs?: number;
	timingMitigation?: TimingMitigation;
	onStdio?: StdioHook;
	payloadLimits?: {
		base64TransferBytes?: number;
		jsonPayloadBytes?: number;
	};
	resourceBudgets?: ResourceBudgets;
}

export interface SharedRuntimeDriver {
	exec(code: string, options?: ExecOptions): Promise<ExecResult>;
	dispose(): void;
	terminate?(): Promise<void>;
}

export interface NodeRuntimeDriver extends SharedRuntimeDriver {
	run<T = unknown>(code: string, filePath?: string): Promise<RunResult<T>>;
	readonly network?: Pick<NetworkAdapter, "fetch" | "dnsLookup" | "httpRequest">;
	unsafeIsolate?: unknown;
	createUnsafeContext?(options?: {
		env?: Record<string, string>;
		cwd?: string;
		filePath?: string;
	}): Promise<unknown>;
}

export interface PythonRuntimeDriver extends SharedRuntimeDriver {
	run<T = unknown>(code: string, options?: PythonRunOptions): Promise<PythonRunResult<T>>;
}

export interface NodeRuntimeDriverFactory {
	createRuntimeDriver(options: RuntimeDriverOptions): NodeRuntimeDriver;
}

export interface PythonRuntimeDriverFactory {
	createRuntimeDriver(options: RuntimeDriverOptions): PythonRuntimeDriver;
}

export interface SystemDriver {
	filesystem?: VirtualFileSystem;
	network?: NetworkAdapter;
	commandExecutor?: CommandExecutor;
	permissions?: Permissions;
	runtime: DriverRuntimeConfig;
}

// Backward-compatible aliases for existing runtime-driver call sites.
export type RuntimeDriver = NodeRuntimeDriver;
export type RuntimeDriverFactory = NodeRuntimeDriverFactory;
