import {
  NodeRuntime,
  allowAllChildProcess,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    permissions: { ...allowAllChildProcess },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

const result = await runtime.run<{ output: string }>(`
  const { execSync } = require("node:child_process");
  module.exports = {
    output: execSync("node --version", { encoding: "utf8" }).trim(),
  };
`);

console.log(result.exports?.output); // e.g. "v22.x.x"
