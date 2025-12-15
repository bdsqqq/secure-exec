import { init, Wasmer, Directory } from "@wasmer/sdk/node";
import * as fs from "fs/promises";
import * as path from "path";
import { fileURLToPath } from "url";
import { NodeProcess, RunResult } from "../node-process/index.js";
import { SystemBridge } from "../system-bridge/index.js";

export interface ExecResult {
  stdout: string;
  stderr: string;
  code: number;
}

export interface WasixInstanceOptions {
  directory?: Directory;
  systemBridge?: SystemBridge;
  nodeProcess?: NodeProcess;
}

const POLL_INTERVAL_MS = 20;
const MAX_POLLS = 500; // 10 seconds total

let wasmerInitialized = false;
let nodeShimPkg: Awaited<ReturnType<typeof Wasmer.fromFile>> | null = null;

export class WasixInstance {
  private directory: Directory;
  private systemBridge?: SystemBridge;
  private nodeProcess?: NodeProcess;
  private initialized = false;

  constructor(options: WasixInstanceOptions = {}) {
    this.directory = options.directory ?? new Directory();
    this.systemBridge = options.systemBridge;
    this.nodeProcess = options.nodeProcess;
  }

  /**
   * Initialize the WASIX instance
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    if (!wasmerInitialized) {
      await init();
      wasmerInitialized = true;
    }

    // Load the node-shim package if not already loaded
    if (!nodeShimPkg) {
      const currentDir = path.dirname(fileURLToPath(import.meta.url));
      const webcPath = path.resolve(currentDir, "../../assets/node-shim.webc");
      try {
        const webcBytes = await fs.readFile(webcPath);
        nodeShimPkg = await Wasmer.fromFile(webcBytes);
      } catch (err) {
        // If webc not found, try to get coreutils from registry
        // This fallback doesn't have node shim but provides basic shell
        console.warn(
          "Warning: node-shim.webc not found, falling back to registry coreutils"
        );
        nodeShimPkg = await Wasmer.fromRegistry("sharrattj/coreutils");
      }
    }

    this.initialized = true;
  }

  /**
   * Get the underlying Directory instance
   */
  getDirectory(): Directory {
    return this.directory;
  }

  /**
   * Execute a shell command string
   * @param commandString - Shell command to execute (e.g., "echo hello")
   */
  async exec(commandString: string): Promise<ExecResult> {
    await this.init();

    if (!nodeShimPkg) {
      throw new Error("WASIX not properly initialized");
    }

    // Use bash -c to execute the command string
    const bashCmd = nodeShimPkg.commands["bash"];
    if (!bashCmd) {
      // Fallback to sh if bash isn't available
      const shCmd = nodeShimPkg.commands["sh"];
      if (!shCmd) {
        throw new Error("No shell command (bash or sh) available");
      }
      return this.runCommand(shCmd, ["-c", commandString]);
    }

    return this.runCommand(bashCmd, ["-c", commandString]);
  }

  /**
   * Run a specific command with arguments
   * @param commandName - Name of the command (e.g., "ls", "cat")
   * @param args - Arguments for the command
   */
  async run(commandName: string, args: string[] = []): Promise<ExecResult> {
    await this.init();

    if (!nodeShimPkg) {
      throw new Error("WASIX not properly initialized");
    }

    const cmd = nodeShimPkg.commands[commandName];
    if (!cmd) {
      // Try to run via bash
      const bashCmd = nodeShimPkg.commands["bash"];
      if (bashCmd) {
        const fullCmd = [commandName, ...args].join(" ");
        return this.runCommand(bashCmd, ["-c", fullCmd]);
      }
      throw new Error(`Command not found: ${commandName}`);
    }

    return this.runCommand(cmd, args);
  }

  /**
   * Internal method to run a command
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async runCommand(cmd: any, args: string[]): Promise<ExecResult> {
    try {
      const instance = await cmd.run({
        args,
        mount: { "/": this.directory },
      });

      const result = await Promise.race([
        instance.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Command timeout (10s)")), 10000)
        ),
      ]);

      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        code: result.code ?? 0,
      };
    } catch (err) {
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
      };
    }
  }

  /**
   * Run a command with IPC polling for node shim support
   * This allows bash scripts to call `node` which triggers IPC to NodeProcess
   */
  async runWithIpc(
    commandName: string,
    args: string[] = []
  ): Promise<ExecResult> {
    await this.init();

    if (!nodeShimPkg) {
      throw new Error("WASIX not properly initialized");
    }

    // Create IPC directory
    const ipcDir = new Directory();

    // Get command
    const cmd = nodeShimPkg.commands[commandName];
    if (!cmd) {
      throw new Error(`Command not found: ${commandName}`);
    }

    // Start IPC polling loop
    let pollActive = true;
    let pollCount = 0;

    const poller = (async () => {
      while (pollActive && pollCount < MAX_POLLS) {
        pollCount++;

        try {
          // Check for request file
          const requestContent = await ipcDir.readTextFile("/request.txt");

          // Parse request (all lines are node args)
          const nodeArgs = requestContent.trim().split("\n").filter(Boolean);

          // Execute node via NodeProcess or real node
          let nodeResult: { exitCode: number; stdout: string; stderr: string };

          if (this.nodeProcess) {
            // Use isolated-vm NodeProcess
            const result = await this.executeNodeViaProcess(nodeArgs);
            nodeResult = result;
          } else {
            // Fallback to spawning real node (for testing)
            nodeResult = await this.executeNodeViaSpawn(nodeArgs);
          }

          // Write response
          const responseContent = `${nodeResult.exitCode}\n${nodeResult.stdout}`;
          ipcDir.writeFile("/response.txt", responseContent);

          // Clear request for next iteration
          try {
            await ipcDir.removeFile("/request.txt");
          } catch {
            // Ignore
          }
        } catch {
          // Request not found yet, continue polling
          await sleep(POLL_INTERVAL_MS);
        }
      }
    })();

    try {
      // Run the command with IPC directory mounted
      const instance = await cmd.run({
        args,
        mount: {
          "/": this.directory,
          "/ipc": ipcDir,
        },
      });

      const result = await Promise.race([
        instance.wait(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error("Command timeout (10s)")), 10000)
        ),
      ]);

      pollActive = false;
      await poller;

      return {
        stdout: result.stdout || "",
        stderr: result.stderr || "",
        code: result.code ?? 0,
      };
    } catch (err) {
      pollActive = false;
      return {
        stdout: "",
        stderr: err instanceof Error ? err.message : String(err),
        code: 1,
      };
    }
  }

  /**
   * Execute node code via NodeProcess (isolated-vm)
   */
  private async executeNodeViaProcess(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    if (!this.nodeProcess || !this.systemBridge) {
      throw new Error("NodeProcess or SystemBridge not configured");
    }

    // Parse args to get the code to run
    // Common patterns: node -e "code" or node script.js
    let code = "";

    for (let i = 0; i < args.length; i++) {
      if (args[i] === "-e" || args[i] === "--eval") {
        code = args[i + 1] || "";
        break;
      } else if (!args[i].startsWith("-")) {
        // It's a script file path
        const scriptPath = args[i];
        try {
          code = await this.systemBridge.readFile(scriptPath);
        } catch {
          return {
            exitCode: 1,
            stdout: "",
            stderr: `Cannot find module '${scriptPath}'`,
          };
        }
        break;
      }
    }

    if (!code) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }

    const result = await this.nodeProcess.exec(code);
    return {
      exitCode: result.code,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  }

  /**
   * Execute node by spawning real node process (fallback)
   */
  private async executeNodeViaSpawn(
    args: string[]
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const { spawn } = await import("child_process");

    return new Promise((resolve) => {
      const proc = spawn("node", args, {
        stdio: ["pipe", "pipe", "pipe"],
      });

      let stdout = "";
      let stderr = "";

      proc.stdout.on("data", (data) => {
        stdout += data.toString();
      });

      proc.stderr.on("data", (data) => {
        stderr += data.toString();
      });

      proc.on("close", (code) => {
        resolve({
          exitCode: code ?? 1,
          stdout,
          stderr,
        });
      });

      proc.on("error", (err) => {
        resolve({
          exitCode: 1,
          stdout: "",
          stderr: err.message,
        });
      });
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
