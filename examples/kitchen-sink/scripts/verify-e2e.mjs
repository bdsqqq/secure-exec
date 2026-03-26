import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.resolve(__dirname, "..");

const exampleChecks = [
  { path: "src/create-runtime.ts", contains: [] },
  { path: "src/run-get-exports.ts", contains: ["hello from secure-exec"] },
  {
    path: "src/execute-capture-output.ts",
    contains: ["hello from secure-exec", "exit code: 0"],
  },
  { path: "src/filesystem.ts", contains: ["hello from the sandbox"] },
  { path: "src/network-access.ts", contains: ["200"] },
  { path: "src/esm-modules.ts", contains: ["42"] },
];

function runExample({ path: relativePath, contains }) {
  return new Promise((resolve, reject) => {
    const child = spawn("pnpm", ["exec", "tsx", relativePath], {
      cwd: examplesRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGKILL");
      reject(new Error(`${relativePath} timed out\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    }, 30_000);

    function hasExpectedOutput() {
      return contains.every((value) => stdout.includes(value));
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();

      if (!settled && hasExpectedOutput()) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        resolve({ stdout, stderr });
      }
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;

      if (code !== 0) {
        reject(
          new Error(
            `${relativePath} exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      if (!hasExpectedOutput()) {
        reject(
          new Error(
            `${relativePath} completed without expected output\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

for (const example of exampleChecks) {
  await runExample(example);
  console.log(`${example.path}: ok`);
}

console.log("Quickstart examples passed end-to-end.");
