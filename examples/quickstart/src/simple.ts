import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver(),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

const result = await runtime.run<{ message: string }>(
  "module.exports = { message: 'hello from secure-exec' };"
);

const message = result.exports?.message;
// "hello from secure-exec"
