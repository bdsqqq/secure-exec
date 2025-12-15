import { describe, it, expect, afterEach, beforeAll } from "vitest";
import { init, Directory } from "@wasmer/sdk/node";
import { NodeProcess } from "./index";
import { SystemBridge } from "../system-bridge/index";

describe("NodeProcess", () => {
  let proc: NodeProcess;

  beforeAll(async () => {
    await init();
  });

  afterEach(() => {
    proc?.dispose();
  });

  describe("Step 1: Basic isolate execution", () => {
    it("should run basic code and return module.exports", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`module.exports = 1 + 1`);
      expect(result).toBe(2);
    });

    it("should return complex objects", async () => {
      proc = new NodeProcess();
      const result = await proc.run<{ foo: string; bar: number }>(
        `module.exports = { foo: "hello", bar: 42 }`
      );
      expect(result).toEqual({ foo: "hello", bar: 42 });
    });

    it("should execute code with console output", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`console.log("hello world")`);
      expect(result.stdout).toBe("hello world\n");
      expect(result.stderr).toBe("");
      expect(result.code).toBe(0);
    });

    it("should capture errors to stderr", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`throw new Error("oops")`);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("oops");
    });

    it("should capture console.error to stderr", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`console.error("bad thing")`);
      expect(result.stderr).toBe("bad thing\n");
      expect(result.code).toBe(0);
    });
  });

  describe("Step 2: require() with node stdlib polyfills", () => {
    it("should require path module and use join", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const path = require("path");
        module.exports = path.join("foo", "bar");
      `);
      expect(result).toBe("foo/bar");
    });

    it("should require path module with node: prefix", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const path = require("node:path");
        module.exports = path.dirname("/foo/bar/baz.txt");
      `);
      expect(result).toBe("/foo/bar");
    });

    it("should require events module", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const { EventEmitter } = require("events");
        const emitter = new EventEmitter();
        let called = false;
        emitter.on("test", () => { called = true; });
        emitter.emit("test");
        module.exports = called;
      `);
      expect(result).toBe(true);
    });

    it("should require util module", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const util = require("util");
        module.exports = util.format("hello %s", "world");
      `);
      expect(result).toBe("hello world");
    });

    it("should cache modules", async () => {
      proc = new NodeProcess();
      const result = await proc.run(`
        const path1 = require("path");
        const path2 = require("path");
        module.exports = path1 === path2;
      `);
      expect(result).toBe(true);
    });

    it("should throw for unknown modules", async () => {
      proc = new NodeProcess();
      const result = await proc.exec(`
        const unknown = require("nonexistent-module");
      `);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Cannot find module");
    });
  });

  describe("Step 8: Package imports from node_modules", () => {
    it("should load a simple package from virtual node_modules", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Create a simple mock package
      bridge.mkdir("/node_modules/my-pkg");
      bridge.writeFile(
        "/node_modules/my-pkg/package.json",
        JSON.stringify({ name: "my-pkg", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/my-pkg/index.js",
        `module.exports = { add: (a, b) => a + b };`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const pkg = require('my-pkg');
        module.exports = pkg.add(2, 3);
      `);

      expect(result).toBe(5);
    });

    it("should load package with default index.js", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Package without explicit main
      bridge.mkdir("/node_modules/simple-pkg");
      bridge.writeFile(
        "/node_modules/simple-pkg/package.json",
        JSON.stringify({ name: "simple-pkg" })
      );
      bridge.writeFile(
        "/node_modules/simple-pkg/index.js",
        `module.exports = "hello from simple-pkg";`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const pkg = require('simple-pkg');
        module.exports = pkg;
      `);

      expect(result).toBe("hello from simple-pkg");
    });

    it("should prioritize polyfills over node_modules", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      // Even if path exists in node_modules, polyfill should be used
      bridge.mkdir("/node_modules/path");
      bridge.writeFile(
        "/node_modules/path/package.json",
        JSON.stringify({ name: "path", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/path/index.js",
        `module.exports = { fake: true };`
      );

      proc = new NodeProcess({ systemBridge: bridge });
      const result = await proc.run(`
        const path = require('path');
        // Real path polyfill has join, our fake doesn't
        module.exports = typeof path.join === 'function';
      `);

      expect(result).toBe(true);
    });

    it("should use setSystemBridge to add bridge later", async () => {
      const dir = new Directory();
      const bridge = new SystemBridge(dir);

      bridge.mkdir("/node_modules/late-pkg");
      bridge.writeFile(
        "/node_modules/late-pkg/package.json",
        JSON.stringify({ name: "late-pkg", main: "index.js" })
      );
      bridge.writeFile(
        "/node_modules/late-pkg/index.js",
        `module.exports = 42;`
      );

      proc = new NodeProcess();
      proc.setSystemBridge(bridge);

      const result = await proc.run(`
        const pkg = require('late-pkg');
        module.exports = pkg;
      `);

      expect(result).toBe(42);
    });
  });
});
