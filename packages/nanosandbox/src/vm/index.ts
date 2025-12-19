import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { Directory, Wasmer, createVFS } from "@wasmer/sdk/node";
import type { VFS } from "@wasmer/sdk/node";
import { NodeProcess, createDefaultNetworkAdapter } from "sandboxed-node";
import { createVirtualFileSystem } from "./node-vfs.js";
import { sleep } from "../utils.js";

export interface VirtualMachineOptions {
	args?: string[];
	env?: Record<string, string>;
	cwd?: string;
	memoryLimit?: number;
}

const DATA_MOUNT_PATH = "/data";
const IPC_MOUNT_PATH = "/ipc";
const POLL_INTERVAL_MS = 20;

let runtimePackage: Awaited<ReturnType<typeof Wasmer.fromFile>> | null = null;

async function loadRuntimePackage(): Promise<Awaited<ReturnType<typeof Wasmer.fromFile>>> {
	if (!runtimePackage) {
		const currentDir = path.dirname(fileURLToPath(import.meta.url));
		const webcPath = path.resolve(currentDir, "../../assets/runtime.webc");
		const webcBytes = await fs.readFile(webcPath);
		runtimePackage = await Wasmer.fromFile(webcBytes);
	}
	return runtimePackage;
}

/**
 * VirtualMachine represents the result of running a command.
 */
export class VirtualMachine {
	public stdout = "";
	public stderr = "";
	public code = 0;

	private command: string;
	private options: VirtualMachineOptions;

	constructor(command: string, options: VirtualMachineOptions = {}) {
		this.command = command;
		this.options = options;
	}

	/**
	 * Execute the command. Called by Runtime.run().
	 */
	async setup(): Promise<void> {
		const pkg = await loadRuntimePackage();

		const cmd = pkg.commands[this.command];
		if (!cmd) {
			throw new Error(`Command not found: ${this.command}`);
		}

		const { args = [], env, cwd, memoryLimit } = this.options;

		const directory = new Directory();
		const ipcDir = new Directory();

		const instance = await cmd.run({
			args,
			env,
			cwd,
			mount: {
				[DATA_MOUNT_PATH]: directory,
				[IPC_MOUNT_PATH]: ipcDir,
			},
		});

		const vfs = createVFS(instance);
		const virtualFs = createVirtualFileSystem(vfs);
		const nodeProcess = new NodeProcess({
			memoryLimit,
			filesystem: virtualFs,
			osConfig: { homedir: "/data/root" },
			networkAdapter: createDefaultNetworkAdapter(),
		});

		let pollActive = true;
		const pollPromise = runIpcPoller(ipcDir, vfs, nodeProcess, () => pollActive);

		const result = await instance.wait();

		pollActive = false;
		await pollPromise;
		nodeProcess.dispose();

		this.stdout = result.stdout;
		this.stderr = result.stderr;
		this.code = result.code ?? 0;
	}
}

async function runIpcPoller(
	ipcDir: Directory,
	vfs: VFS,
	nodeProcess: NodeProcess,
	isActive: () => boolean,
): Promise<void> {
	while (isActive()) {
		try {
			const requestContent = await ipcDir.readTextFile("/request.txt");
			let nodeArgs = requestContent.trim().split("\n").filter(Boolean);

			const ipcScriptIdx = nodeArgs.indexOf("--ipc-script");
			if (ipcScriptIdx !== -1) {
				const scriptContent = await ipcDir.readTextFile("/script.js");
				nodeArgs = ["-e", scriptContent];
			}

			const nodeResult = await executeNode(nodeArgs, vfs, nodeProcess);

			await ipcDir.writeFile("/response.txt", `${nodeResult.exitCode}\n${nodeResult.stdout}`);

			try {
				await ipcDir.removeFile("/request.txt");
				await ipcDir.removeFile("/script.js");
			} catch {
				// Ignore
			}
		} catch {
			await sleep(POLL_INTERVAL_MS);
		}
	}
}

async function executeNode(
	args: string[],
	vfs: VFS,
	nodeProcess: NodeProcess,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	let code = "";

	for (let i = 0; i < args.length; i++) {
		if (args[i] === "-e" || args[i] === "--eval") {
			code = args[i + 1] || "";
			break;
		} else if (!args[i].startsWith("-")) {
			try {
				code = await vfs.readTextFile(args[i]);
			} catch {
				return { exitCode: 1, stdout: "", stderr: `Cannot find module '${args[i]}'` };
			}
			break;
		}
	}

	if (!code) {
		return { exitCode: 0, stdout: "", stderr: "" };
	}

	const result = await nodeProcess.exec(code);
	return { exitCode: result.code, stdout: result.stdout, stderr: result.stderr };
}

