import {
  NodeRuntime,
  allowAllChildProcess,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "../../../packages/secure-exec/src/index.ts";
import type { CommandExecutor } from "../../../packages/secure-exec/src/types.ts";
import { spawn } from "node:child_process";

const commandExecutor: CommandExecutor = {
  spawn(command, args, options) {
    const resolvedCommand = command === "node" ? process.execPath : command;
    const resolvedCwd = options.cwd === "/root" ? process.cwd() : options.cwd;
    const child = spawn(resolvedCommand, args, {
      cwd: resolvedCwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    child.stdout.on("data", (chunk) => {
      options.onStdout?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    child.stderr.on("data", (chunk) => {
      options.onStderr?.(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });

    return {
      writeStdin(data) {
        child.stdin.write(data);
      },
      closeStdin() {
        child.stdin.end();
      },
      kill(signal) {
        child.kill(signal);
      },
      wait() {
        return new Promise<number>((resolve) => {
          child.once("close", (code) => resolve(code ?? 1));
        });
      },
    };
  },
};

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    commandExecutor,
    permissions: { ...allowAllChildProcess },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
  const result = await runtime.exec(`
    const { spawnSync } = require("node:child_process");

    const child = spawnSync("node", ["--version"], {
      encoding: "utf8",
    });
    const output =
      typeof child.stdout === "string"
        ? child.stdout
        : Buffer.from(child.stdout || []).toString("utf8");

    if (child.status !== 0 || !output.startsWith("v")) {
      throw new Error("Unexpected child process exit code: " + child.status);
    }
  `);

  if (result.code !== 0) {
    throw new Error(`Unexpected execution result: ${JSON.stringify(result)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      summary: "sandbox spawned node --version successfully",
    }),
  );
} finally {
  runtime.dispose();
}
