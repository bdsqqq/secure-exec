import {
  NodeRuntime,
  allowAllNetwork,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const logs: string[] = [];
const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    useDefaultNetwork: true,
    permissions: { ...allowAllNetwork },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

await runtime.exec(`
  (async () => {
    const response = await fetch("https://example.com");
    console.log(response.status);
  })().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
`, {
  onStdio: (event) => logs.push(`[${event.channel}] ${event.message}`),
});

console.log(logs); // ["[stdout] 200"]
