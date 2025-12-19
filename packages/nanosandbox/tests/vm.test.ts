import { describe, expect, it, beforeAll } from "vitest";
import { Runtime, Process } from "../src/runtime/index.js";

describe("VirtualMachine", () => {
	let runtime: Runtime;

	beforeAll(async () => {
		runtime = await Runtime.load();
	});

	describe("Basic run functionality", () => {
		it("should execute echo command", async () => {
			const vm = await runtime.run("echo", { args: ["hello world"] });
			expect(vm.stdout.trim()).toBe("hello world");
			expect(vm.code).toBe(0);
		});

		it("should execute ls command on root", async () => {
			const vm = await runtime.run("ls", { args: ["/"] });
			expect(vm.code).toBe(0);
			expect(vm.stdout).toContain("bin");
		});

		it("should execute bash with echo builtin", async () => {
			const vm = await runtime.run("bash", {
				args: ["-c", "echo foo; echo bar"],
			});
			expect(vm.stdout).toContain("foo");
			expect(vm.stdout).toContain("bar");
		});

		it("should handle command failure", async () => {
			const vm = await runtime.run("ls", { args: ["/nonexistent"] });
			expect(vm.code).not.toBe(0);
		});
	});

	describe("Filesystem via bash builtins", () => {
		it("should write files via redirection and read via bash", async () => {
			const vm = await runtime.run("bash", {
				args: ["-c", 'echo "hello" > /data/test.txt; read -r line < /data/test.txt; echo "$line"'],
			});
			expect(vm.stdout.trim()).toBe("hello");
		});

		it("should check file existence via bash test", async () => {
			const vm = await runtime.run("bash", {
				args: ["-c", 'echo test > /data/exists.txt; if [ -f /data/exists.txt ]; then echo "exists"; fi'],
			});
			expect(vm.stdout.trim()).toBe("exists");
		});
	});

	describe("Node via IPC", () => {
		it("should execute node -e directly", async () => {
			const vm = await runtime.run("node", {
				args: ["-e", "console.log('hello from node')"],
			});
			expect(vm.stdout).toContain("hello from node");
			expect(vm.code).toBe(0);
		});

		it("should handle node errors properly", async () => {
			const vm = await runtime.run("node", {
				args: ["-e", "throw new Error('oops')"],
			});
			expect(vm.code).not.toBe(0);
		});

		it("should read stdin and output it (node)", async () => {
			const script = `
				let data = '';
				process.stdin.on('data', chunk => data += chunk);
				process.stdin.on('end', () => console.log('got:', data.trim()));
			`;
			const vm = await runtime.run("node", {
				args: ["-e", script],
				stdin: "hello world",
			});
			expect(vm.stdout.trim()).toBe("got: hello world");
		});

		it("should read stdin and output it (bash)", async () => {
			const vm = await runtime.run("bash", {
				args: ["-c", "read line; echo got: $line"],
				stdin: "hello world\n",
			});
			expect(vm.stdout.trim()).toBe("got: hello world");
		});

		// Child process spawning from Node - currently only supports spawning other node processes
		// because hostExecHandler only handles "node" commands. Full WASM command spawning
		// requires additional work in the scheduler to spawn new WASM instances.
		it.skip("should spawn child node process from node", async () => {
			const script = `
				const { spawn } = require('child_process');
				const child = spawn('node', ['-e', 'console.log("child output")']);
				child.stdout.on('data', (d) => console.log('from child:', d.toString().trim()));
				child.on('close', (code) => console.log('child exited:', code));
			`;
			const vm = await runtime.run("node", {
				args: ["-e", script],
			});
			expect(vm.stdout).toContain("from child: child output");
			expect(vm.stdout).toContain("child exited: 0");
		});

		// Streaming stdin tests are skipped due to wasmer-js TTY bug.
		// See: docs/research/wasmer-js-tty-stdin-bug.md
		it.skip("should stream stdin to bash with spawn()", async () => {
			const proc = await runtime.spawn("bash", {
				args: ["-c", "while read line; do echo \"OUT:$line\"; done"],
			});

			await proc.writeStdin("ping1\n");
			await pollForOutput(proc, "ping1\n");

			await proc.writeStdin("ping2\n");
			await pollForOutput(proc, "ping2\n");

			await proc.writeStdin("ping3\n");
			await pollForOutput(proc, "ping3\n");

			await proc.closeStdin();
			await proc.wait();
		}, 30000);

		it.skip("should stream stdin to node with spawn()", async () => {
			const script = `
				let data = '';
				process.stdin.on('data', chunk => data += chunk);
				process.stdin.on('end', () => {
					data.trim().split('\\n').forEach(line => console.log('OUT:' + line));
				});
			`;
			const proc = await runtime.spawn("node", {
				args: ["-e", script],
			});

			await proc.writeStdin("ping1\n");
			await proc.writeStdin("ping2\n");
			await proc.writeStdin("ping3\n");
			await proc.closeStdin();

			const result = await proc.wait();
			expect(result.stdout).toContain("OUT:ping1");
			expect(result.stdout).toContain("OUT:ping2");
			expect(result.stdout).toContain("OUT:ping3");
		}, 30000);
	});

	describe("Isolation", () => {
		it("should have isolated filesystems between runs", async () => {
			await runtime.run("bash", {
				args: ["-c", "echo hello > /data/isolated.txt"],
			});

			const vm = await runtime.run("bash", {
				args: ["-c", 'if [ -f /data/isolated.txt ]; then echo "found"; else echo "not found"; fi'],
			});
			expect(vm.stdout.trim()).toBe("not found");
		});
	});
});

/** Poll stdout until we get the expected exact output */
async function pollForOutput(proc: Process, expected: string, timeoutMs = 5000): Promise<void> {
	const startTime = Date.now();
	while (Date.now() - startTime < timeoutMs) {
		const output = await proc.readStdout();
		if (output === expected) return;
		if (output !== "") throw new Error(`Expected "${expected}", got "${output}"`);
		await new Promise(r => setTimeout(r, 50));
	}
	throw new Error(`Timeout waiting for "${expected}"`);
}
