import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const examplesRoot = path.resolve(__dirname, "..");

const featureFiles = [
  "src/child-processes.ts",
  "src/filesystem.ts",
  "src/module-loading.ts",
  "src/networking.ts",
  "src/output-capture.ts",
  "src/permissions.ts",
  "src/resource-limits.ts",
  "src/typescript.ts",
  "src/virtual-filesystem.ts",
];

function runExample(relativePath) {
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

    function tryGetPayload() {
      const jsonLine = stdout
        .trim()
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1);

      if (!jsonLine) {
        return null;
      }

      try {
        return JSON.parse(jsonLine);
      } catch {
        return null;
      }
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();

      const payload = tryGetPayload();
      if (!settled && payload?.ok) {
        settled = true;
        clearTimeout(timeout);
        child.kill("SIGKILL");
        resolve(payload);
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
      if (settled) {
        return;
      }

      settled = true;
      if (code !== 0) {
        reject(
          new Error(
            `${relativePath} exited with code ${code}\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      const payload = tryGetPayload();
      if (!payload) {
        reject(new Error(`${relativePath} produced no JSON result`));
        return;
      }

      if (!payload?.ok) {
        reject(
          new Error(
            `${relativePath} reported failure\nstdout:\n${stdout}\nstderr:\n${stderr}`,
          ),
        );
        return;
      }

      resolve(payload);
    });
  });
}

for (const featureFile of featureFiles) {
  const result = await runExample(featureFile);
  console.log(`${featureFile}: ${result.summary ?? "ok"}`);
}

console.log("Feature examples passed end-to-end.");
