import {
  NodeRuntime,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver(),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

const result = await runtime.run<{ answer: number }>(
  `export const answer = 42;`,
  "/entry.mjs" // .mjs extension triggers ESM mode
);

console.log(result.exports?.answer); // 42

runtime.dispose();
