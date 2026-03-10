// Re-export core runtime surface.
export { NodeRuntime } from "./runtime.js";
export type { NodeRuntimeOptions } from "./runtime.js";
export { PythonRuntime } from "./python-runtime.js";
export type { PythonRuntimeOptions } from "./python-runtime.js";

// Re-export public types.
export type {
	CommandExecutor,
	NodeRuntimeDriver,
	NodeRuntimeDriverFactory,
	NetworkAdapter,
	Permissions,
	PythonRuntimeDriver,
	PythonRuntimeDriverFactory,
	RuntimeDriver,
	RuntimeDriverFactory,
	SharedRuntimeDriver,
	SystemDriver,
	VirtualFileSystem,
} from "./types.js";
export type { DirEntry, StatInfo } from "./fs-helpers.js";
export type {
	StdioChannel,
	StdioEvent,
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

// Re-export Node driver factories.
export {
	createDefaultNetworkAdapter,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
	NodeExecutionDriver,
	NodeFileSystem,
} from "./node/driver.js";
export type {
	ModuleAccessOptions,
	NodeRuntimeDriverFactoryOptions,
} from "./node/driver.js";

// Re-export Python runtime-driver factories.
export {
	createPyodideRuntimeDriverFactory,
	PyodideRuntimeDriver,
} from "./python/driver.js";

// Re-export browser driver factories.
export {
	createBrowserDriver,
	createBrowserNetworkAdapter,
	createBrowserRuntimeDriverFactory,
	createOpfsFileSystem,
} from "./browser/index.js";
export type {
	BrowserDriverOptions,
	BrowserRuntimeDriverFactoryOptions,
	BrowserRuntimeSystemOptions,
} from "./browser/index.js";

export { createInMemoryFileSystem } from "./shared/in-memory-fs.js";
export {
	allowAll,
	allowAllChildProcess,
	allowAllEnv,
	allowAllFs,
	allowAllNetwork,
} from "./shared/permissions.js";
