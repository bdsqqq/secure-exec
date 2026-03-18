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
  const { Hono } = require("hono");
  const { createServer } = require("node:http");

  const app = new Hono();
  app.get("/", (c) => c.text("hello from hono"));

  const server = createServer(async (req, res) => {
    const response = await app.fetch(
      new Request("http://127.0.0.1" + req.url, { method: req.method })
    );

    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });

  server.listen(80, async () => {
    const response = await fetch("http://127.0.0.1:80");
    console.log(await response.text());
    server.close();
  });
`, {
  onStdio: (event) => logs.push(`[${event.channel}] ${event.message}`),
});

console.log(logs); // ["[stdout] hello from hono"]
