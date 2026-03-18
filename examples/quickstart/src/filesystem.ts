import {
  NodeRuntime,
  allowAllFs,
  createInMemoryFileSystem,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const filesystem = createInMemoryFileSystem();
const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    filesystem,
    permissions: { ...allowAllFs },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

await runtime.exec(`
  const fs = require("node:fs");
  fs.mkdirSync("/workspace", { recursive: true });
  fs.writeFileSync("/workspace/hello.txt", "hello from the sandbox");
`);

const bytes = await filesystem.readFile("/workspace/hello.txt");
console.log(new TextDecoder().decode(bytes)); // "hello from the sandbox"
