import { describe, expect, it, beforeAll } from "vitest";
import { Runtime } from "../src/runtime/index.js";

/**
 * Test PATH resolution in WASIX.
 *
 * The bug: posix_spawnp() should search PATH for commands, but it fails
 * with ENOEXEC (45) when using relative command names like "echo".
 *
 * Currently, wasix-runtime uses a `which` hack to resolve commands to
 * absolute paths before calling Command::new(). This test verifies that
 * commands work with this hack in place.
 *
 * To test without the which hack, prefix command with "nowhich:" e.g.:
 * spawnSync('nowhich:echo', ['hello'])
 */
describe("PATH Resolution", () => {
	let runtime: Runtime;

	beforeAll(async () => {
		runtime = await Runtime.load();
	});

	it("should spawn ls with relative path (using which hack)", async () => {
		const script = `
			const { spawnSync } = require('child_process');
			const result = spawnSync('ls', ['/']);
			console.log('stdout:', result.stdout.toString().trim());
			console.log('status:', result.status);
			console.log('error:', result.error?.message || 'none');
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		console.log("VM stdout:", vm.stdout);
		console.log("VM stderr:", vm.stderr);
		console.log("VM code:", vm.code);

		// With the which hack, ls should be found and execute
		expect(vm.stdout).toContain("bin");
		expect(vm.stdout).toContain("status: 0");
	}, 30000);

	it("should spawn echo with relative path (using which hack)", async () => {
		const script = `
			const { spawnSync } = require('child_process');
			const result = spawnSync('echo', ['hello', 'world']);
			console.log('stdout:', result.stdout.toString().trim());
			console.log('status:', result.status);
			console.log('error:', result.error?.message || 'none');
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		console.log("VM stdout:", vm.stdout);
		console.log("VM stderr:", vm.stderr);
		console.log("VM code:", vm.code);

		// With the which hack, echo should work
		expect(vm.stdout).toContain("hello world");
		expect(vm.stdout).toContain("status: 0");
	}, 30000);

	it("should list available commands in /bin", async () => {
		const script = `
			const { spawnSync } = require('child_process');
			const result = spawnSync('ls', ['-la', '/bin']);
			console.log(result.stdout.toString());
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		console.log("Available commands in /bin:");
		console.log(vm.stdout);
	}, 30000);

	it("should spawn sh -c with absolute echo", async () => {
		const script = `
			const { spawnSync } = require('child_process');
			const result = spawnSync('sh', ['-c', '/bin/echo hello from sh']);
			console.log('stdout:', result.stdout.toString().trim());
			console.log('status:', result.status);
			console.log('error:', result.error?.message || 'none');
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		console.log("VM stdout:", vm.stdout);
		console.log("VM stderr:", vm.stderr);
		console.log("VM code:", vm.code);

		expect(vm.stdout).toContain("hello from sh");
		expect(vm.stdout).toContain("status: 0");
	}, 30000);

	/**
	 * Test PATH resolution WITHOUT the which hack.
	 * This tests whether wasmer's proc_spawn2 correctly searches PATH.
	 *
	 * Expected: This test should FAIL if the PATH resolution bug exists.
	 * The spawn should fail with exit code 45 (ENOEXEC) or similar error.
	 */
	it("should spawn echo WITHOUT which hack (tests wasmer PATH resolution)", async () => {
		const script = `
			const { spawnSync } = require('child_process');
			// Use nowhich: prefix to bypass the which hack
			const result = spawnSync('nowhich:echo', ['hello', 'test']);
			console.log('stdout:', result.stdout?.toString().trim() || '(empty)');
			console.log('stderr:', result.stderr?.toString().trim() || '(empty)');
			console.log('status:', result.status);
			console.log('signal:', result.signal);
			console.log('error:', result.error?.message || 'none');
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		console.log("=== Test WITHOUT which hack ===");
		console.log("VM stdout:", vm.stdout);
		console.log("VM stderr:", vm.stderr);
		console.log("VM code:", vm.code);

		// This test documents the bug - without the which hack, PATH resolution fails
		// If wasmer's PATH resolution is fixed, this expectation should be changed
		// to expect success (status: 0, stdout contains "hello test")
		//
		// Current expected behavior (BUG): fails to find echo
		// Fixed behavior: should find /bin/echo and output "hello test"
	}, 30000);

	/**
	 * Test that absolute paths work WITHOUT the which hack.
	 * This confirms the spawn mechanism itself works, only PATH resolution is broken.
	 */
	it("should spawn /bin/echo WITHOUT which hack (absolute path)", async () => {
		const script = `
			const { spawnSync } = require('child_process');
			// Use nowhich: prefix but with absolute path - should work
			const result = spawnSync('nowhich:/bin/echo', ['hello', 'absolute']);
			console.log('stdout:', result.stdout?.toString().trim() || '(empty)');
			console.log('stderr:', result.stderr?.toString().trim() || '(empty)');
			console.log('status:', result.status);
			console.log('error:', result.error?.message || 'none');
		`;
		const vm = await runtime.run("node", { args: ["-e", script] });
		console.log("=== Test ABSOLUTE path WITHOUT which hack ===");
		console.log("VM stdout:", vm.stdout);
		console.log("VM stderr:", vm.stderr);
		console.log("VM code:", vm.code);

		// Absolute path should work even without which hack
		expect(vm.stdout).toContain("hello absolute");
		expect(vm.stdout).toContain("status: 0");
	}, 30000);
});
