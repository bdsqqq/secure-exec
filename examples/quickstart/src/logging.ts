import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const logs: string[] = [];
const runtime = new NodeRuntime({
  systemDriver: createNodeDriver(),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

await runtime.exec("console.log('hello from secure-exec')", {
  onStdio: (event) => logs.push(`[${event.channel}] ${event.message}`),
});

console.log(logs); // ["[stdout] hello from secure-exec"]
