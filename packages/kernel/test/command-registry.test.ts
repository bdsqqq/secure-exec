import { describe, it, expect } from "vitest";
import { CommandRegistry } from "../src/command-registry.js";
import type { RuntimeDriver, KernelInterface, ProcessContext, DriverProcess } from "../src/types.js";

function createMockDriver(name: string, commands: string[]): RuntimeDriver {
	return {
		name,
		commands,
		async init(_kernel: KernelInterface) {},
		spawn(_command: string, _args: string[], _ctx: ProcessContext): DriverProcess {
			throw new Error("not implemented");
		},
		async dispose() {},
	};
}

describe("CommandRegistry", () => {
	it("registers and resolves commands", () => {
		const registry = new CommandRegistry();
		const driver = createMockDriver("wasmvm", ["grep", "sed", "cat"]);
		registry.register(driver);

		expect(registry.resolve("grep")).toBe(driver);
		expect(registry.resolve("sed")).toBe(driver);
		expect(registry.resolve("cat")).toBe(driver);
	});

	it("returns null for unknown commands", () => {
		const registry = new CommandRegistry();
		expect(registry.resolve("nonexistent")).toBeNull();
	});

	it("last-mounted driver wins on conflict", () => {
		const registry = new CommandRegistry();
		const driver1 = createMockDriver("wasmvm", ["node"]);
		const driver2 = createMockDriver("node", ["node"]);

		registry.register(driver1);
		registry.register(driver2);

		expect(registry.resolve("node")!.name).toBe("node");
	});

	it("list returns command → driver name mapping", () => {
		const registry = new CommandRegistry();
		registry.register(createMockDriver("wasmvm", ["grep", "cat"]));
		registry.register(createMockDriver("node", ["node", "npm"]));

		const list = registry.list();
		expect(list.get("grep")).toBe("wasmvm");
		expect(list.get("node")).toBe("node");
		expect(list.size).toBe(4);
	});

	it("logs warning when overriding existing command", () => {
		const registry = new CommandRegistry();
		const driver1 = createMockDriver("wasmvm", ["sh", "grep"]);
		const driver2 = createMockDriver("node", ["sh"]);

		registry.register(driver1);
		registry.register(driver2);

		const warnings = registry.getWarnings();
		expect(warnings.length).toBe(1);
		expect(warnings[0]).toContain("sh");
		expect(warnings[0]).toContain("wasmvm");
		expect(warnings[0]).toContain("node");
	});

	it("populateBin creates /bin entries", async () => {
		const { TestFileSystem } = await import("./helpers.js");
		const vfs = new TestFileSystem();
		const registry = new CommandRegistry();
		registry.register(createMockDriver("wasmvm", ["grep", "cat"]));

		await registry.populateBin(vfs);

		expect(await vfs.exists("/bin/grep")).toBe(true);
		expect(await vfs.exists("/bin/cat")).toBe(true);
	});
});
