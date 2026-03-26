import { createServer } from "node:net";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import {
  NodeRuntime,
  allowAllFs,
  allowAllNetwork,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const host = "127.0.0.1";
const port = await findOpenPort();
const logs: string[] = [];
const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const honoEntry = toSandboxModulePath(require.resolve("hono"));
const honoNodeServerEntry = toSandboxModulePath(require.resolve("@hono/node-server"));

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    moduleAccess: { cwd: repoRoot },
    useDefaultNetwork: true,
    permissions: { ...allowAllFs, ...allowAllNetwork },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  memoryLimit: 128,
  cpuTimeLimitMs: 60_000,
});

const execPromise = runtime.exec(`
  globalThis.global = globalThis;
  const { Hono } = require("${honoEntry}");
  const { serve } = require("${honoNodeServerEntry}");

  const app = new Hono();
  app.get("/", (c) => c.text("hello from sandboxed hono"));
  app.get("/health", (c) => c.json({ ok: true }));

  serve({
    fetch: app.fetch,
    port: ${port},
    hostname: "${host}",
  });

  console.log("server:listening:${port}");
  setInterval(() => {}, 1 << 30);
`, {
  onStdio: (event) => logs.push(`[${event.channel}] ${event.message}`),
});

try {
  await waitForServer(runtime, `http://${host}:${port}/health`);

  const response = await runtime.network.fetch(`http://${host}:${port}/`, {
    method: "GET",
  });

  console.log(response.status); // 200
  console.log(response.body); // "hello from sandboxed hono"
} finally {
  await runtime.terminate();
  await execPromise.catch(() => undefined);
}

function toSandboxModulePath(hostPath: string): string {
  const hostNodeModulesRoot = path.join(repoRoot, "node_modules");
  const relativePath = path.relative(hostNodeModulesRoot, hostPath);
  if (relativePath.startsWith("..")) {
    throw new Error(`Expected module inside ${hostNodeModulesRoot}: ${hostPath}`);
  }
  return path.posix.join("/root/node_modules", relativePath.split(path.sep).join("/"));
}

async function findOpenPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      if (!address || typeof address !== "object") {
        reject(new Error("Failed to allocate a port"));
        server.close();
        return;
      }

      const allocatedPort = address.port;
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(allocatedPort);
      });
    });
  });
}

async function waitForServer(runtime: NodeRuntime, url: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      const response = await runtime.network.fetch(url, { method: "GET" });
      if (response.status === 200) {
        return;
      }
    } catch {
      // Retry until the server is ready.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Timed out waiting for ${url}`);
}
