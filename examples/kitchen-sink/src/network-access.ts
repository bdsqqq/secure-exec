import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
  allowAllNetwork,
} from "secure-exec";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    useDefaultNetwork: true,
    permissions: { ...allowAllNetwork },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
  onStdio: (event) => {
    process.stdout.write(event.message);
  },
});

await runtime.exec(`
  const response = await fetch("http://example.com");
  console.log(response.status); // 200
`, {
  filePath: "/entry.mjs", // enables top-level await
});

runtime.dispose();
