import { filterEnv } from "./shared/permissions.js";
import type {
	ExecOptions,
	ExecResult,
	PythonRunOptions,
	PythonRunResult,
	StdioHook,
} from "./shared/api-types.js";
import type {
	PythonRuntimeDriver,
	PythonRuntimeDriverFactory,
	SystemDriver,
} from "./types.js";

const DEFAULT_SANDBOX_CWD = "/root";
const DEFAULT_SANDBOX_HOME = "/root";
const DEFAULT_SANDBOX_TMPDIR = "/tmp";

export interface PythonRuntimeOptions {
	systemDriver: SystemDriver;
	runtimeDriverFactory: PythonRuntimeDriverFactory;
	cpuTimeLimitMs?: number;
	onStdio?: StdioHook;
}

export class PythonRuntime {
	private readonly runtimeDriver: PythonRuntimeDriver;

	constructor(options: PythonRuntimeOptions) {
		const { systemDriver, runtimeDriverFactory } = options;

		const processConfig = {
			...(systemDriver.runtime.process ?? {}),
		};
		processConfig.cwd ??= DEFAULT_SANDBOX_CWD;
		processConfig.env = filterEnv(processConfig.env, systemDriver.permissions);

		const osConfig = {
			...(systemDriver.runtime.os ?? {}),
		};
		osConfig.homedir ??= DEFAULT_SANDBOX_HOME;
		osConfig.tmpdir ??= DEFAULT_SANDBOX_TMPDIR;

		this.runtimeDriver = runtimeDriverFactory.createRuntimeDriver({
			system: systemDriver,
			runtime: {
				process: processConfig,
				os: osConfig,
			},
			cpuTimeLimitMs: options.cpuTimeLimitMs,
			onStdio: options.onStdio,
		});
	}

	async run<T = unknown>(
		code: string,
		options: PythonRunOptions = {},
	): Promise<PythonRunResult<T>> {
		return this.runtimeDriver.run<T>(code, options);
	}

	async exec(code: string, options?: ExecOptions): Promise<ExecResult> {
		return this.runtimeDriver.exec(code, options);
	}

	dispose(): void {
		this.runtimeDriver.dispose();
	}

	async terminate(): Promise<void> {
		if (this.runtimeDriver.terminate) {
			await this.runtimeDriver.terminate();
			return;
		}
		this.runtimeDriver.dispose();
	}
}
