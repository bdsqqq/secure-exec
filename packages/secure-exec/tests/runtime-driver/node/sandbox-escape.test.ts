import { afterEach, describe, expect, it } from "vitest";
import { createTestNodeRuntime } from "../../test-utils.js";
import type { NodeRuntime } from "../../../src/index.js";

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		events,
		onStdio: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () =>
			events
				.filter((e) => e.channel === "stdout")
				.map((e) => e.message)
				.join("\n"),
	};
}

describe("sandbox escape security", () => {
	let proc: NodeRuntime | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it("process.binding() throws instead of returning stubs", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const results = {};

			// process.binding('fs') should throw
			try {
				process.binding('fs');
				results.fsThrew = false;
			} catch (e) {
				results.fsThrew = true;
				results.fsMsg = e.message;
			}

			// process.binding('buffer') should throw
			try {
				process.binding('buffer');
				results.bufferThrew = false;
			} catch (e) {
				results.bufferThrew = true;
				results.bufferMsg = e.message;
			}

			// process._linkedBinding() should also throw
			try {
				process._linkedBinding('fs');
				results.linkedThrew = false;
			} catch (e) {
				results.linkedThrew = true;
				results.linkedMsg = e.message;
			}

			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.fsThrew).toBe(true);
		expect(results.fsMsg).toContain("not supported in sandbox");
		expect(results.bufferThrew).toBe(true);
		expect(results.bufferMsg).toContain("not supported in sandbox");
		expect(results.linkedThrew).toBe(true);
		expect(results.linkedMsg).toContain("not supported in sandbox");
	});

	it("process.dlopen() is blocked inside sandbox", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			let blocked = false;
			let errorMsg = '';
			try {
				process.dlopen({}, '/tmp/fake.node');
			} catch (e) {
				blocked = true;
				errorMsg = e.message;
			}
			console.log(JSON.stringify({ blocked, errorMsg }));
		`);

		expect(result.code).toBe(0);
		const output = JSON.parse(capture.stdout().trim());
		expect(output.blocked).toBe(true);
		expect(output.errorMsg).toContain("not supported");
	});

	it("constructor.constructor('return this')() does not return host global", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			// Classic sandbox escape: use Function constructor to access the real global
			const escaped = (function() {}).constructor('return this')();

			// The returned global should be the sandbox global, not host
			// Host global would have process.pid matching the real host PID,
			// real require with native bindings, etc.
			const results = {};

			// If escape worked, we'd get the host's real require/process
			// process.binding should throw in the sandbox — if it returns, that's an escape
			try {
				const fsBind = escaped.process?.binding?.('fs');
				results.hasHostBinding = typeof fsBind?.open === 'function';
			} catch {
				results.hasHostBinding = false;
			}
			results.hasDlopen = false;
			try {
				escaped.process?.dlopen?.({}, '/tmp/fake.node');
			} catch (e) {
				// dlopen should still throw "not supported" even via constructor escape
				results.hasDlopen = !e.message.includes('not supported');
			}

			// Verify the escaped global IS the sandbox global (same object)
			results.sameGlobal = escaped === globalThis;

			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.hasHostBinding).toBe(false);
		expect(results.hasDlopen).toBe(false);
		expect(results.sameGlobal).toBe(true);
	});

	it("Object.prototype.__proto__ manipulation does not affect host objects", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		// Execute code that tries proto pollution, then run second execution
		// to verify sandbox isolation
		const result = await proc.exec(`
			const results = {};

			// Attempt prototype pollution
			const payload = { polluted: true };
			try {
				({}).__proto__.sandboxEscape = 'yes';
				results.protoWriteSucceeded = ({}).sandboxEscape === 'yes';
			} catch (e) {
				results.protoWriteSucceeded = false;
			}

			// Try more advanced prototype manipulation
			try {
				Object.prototype.constructor.prototype.hostAccess = true;
				results.constructorProtoWrite = ({}).hostAccess === true;
			} catch (e) {
				results.constructorProtoWrite = false;
			}

			// Attempt to replace Object.prototype entirely
			let protoReplaceBlocked = false;
			try {
				Object.setPrototypeOf(Object.prototype, { escaped: true });
			} catch (e) {
				protoReplaceBlocked = true;
			}
			results.protoReplaceBlocked = protoReplaceBlocked;

			// Verify sandbox process is still the sandbox's process
			results.processIsSandboxed = typeof process.dlopen === 'function';

			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		// Proto writes within the sandbox stay in the sandbox (isolated-vm provides isolation)
		// The critical assertion is that Object.setPrototypeOf(Object.prototype, ...) throws
		expect(results.protoReplaceBlocked).toBe(true);
		// Sandbox process remains sandboxed regardless of proto manipulation
		expect(results.processIsSandboxed).toBe(true);

		// Run a second execution to verify no cross-execution proto leakage
		const capture2 = createConsoleCapture();
		proc.dispose();
		proc = createTestNodeRuntime({ onStdio: capture2.onStdio });

		const result2 = await proc.exec(`
			const clean = {};
			console.log(JSON.stringify({
				noSandboxEscape: clean.sandboxEscape === undefined,
				noHostAccess: clean.hostAccess === undefined,
			}));
		`);

		expect(result2.code).toBe(0);
		const results2 = JSON.parse(capture2.stdout().trim());
		expect(results2.noSandboxEscape).toBe(true);
		expect(results2.noHostAccess).toBe(true);
	});

	it("require('v8').runInDebugContext is blocked or undefined", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const results = {};
			try {
				const v8 = require('v8');
				results.hasRunInDebugContext = typeof v8.runInDebugContext === 'function';
				results.v8Keys = Object.keys(v8);

				// If it somehow exists, verify it throws
				if (typeof v8.runInDebugContext === 'function') {
					try {
						v8.runInDebugContext('Debug');
						results.debugContextEscaped = true;
					} catch {
						results.debugContextEscaped = false;
					}
				} else {
					results.debugContextEscaped = false;
				}

				// Also verify v8 module doesn't expose getHeapStatistics or other native internals
				results.hasGetHeapStatistics = typeof v8.getHeapStatistics === 'function';
				results.hasSerialize = typeof v8.serialize === 'function';
			} catch (e) {
				results.requireFailed = true;
				results.hasRunInDebugContext = false;
				results.debugContextEscaped = false;
			}
			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.hasRunInDebugContext).toBe(false);
		expect(results.debugContextEscaped).toBe(false);
	});

	it("path traversal with ../../../etc/passwd returns EACCES", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const fs = require('fs');
			const results = {};
			try {
				fs.readFileSync('../../../etc/passwd', 'utf8');
				results.succeeded = true;
			} catch (e) {
				results.succeeded = false;
				results.code = e.code;
			}
			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.succeeded).toBe(false);
		expect(results.code).toBe("EACCES");
	});

	it("fs.readFileSync('/proc/self/environ') returns EACCES", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const fs = require('fs');
			const results = {};
			try {
				fs.readFileSync('/proc/self/environ', 'utf8');
				results.succeeded = true;
			} catch (e) {
				results.succeeded = false;
				results.code = e.code;
			}
			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.succeeded).toBe(false);
		expect(results.code).toBe("EACCES");
	});

	it("fs.readFileSync with null bytes in path is rejected", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		const result = await proc.exec(`
			const fs = require('fs');
			const results = {};
			try {
				fs.readFileSync('/app/test\\x00/etc/passwd', 'utf8');
				results.succeeded = true;
			} catch (e) {
				results.succeeded = false;
				results.code = e.code || 'error';
				results.hasMessage = !!e.message;
			}
			console.log(JSON.stringify(results));
		`);

		expect(result.code).toBe(0);
		const results = JSON.parse(capture.stdout().trim());
		expect(results.succeeded).toBe(false);
	});

	it("all sandbox escape techniques fail together", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({ onStdio: capture.onStdio });

		// Combined stress test of multiple escape vectors in a single execution
		const result = await proc.exec(`
			const escapes = [];

			// 1. Function constructor global access
			try {
				const g = Function('return this')();
				if (g !== globalThis) escapes.push('Function-constructor-different-global');
				try {
					const fsBind = g.process?.binding?.('fs');
					if (typeof fsBind?.open === 'function')
						escapes.push('Function-constructor-real-bindings');
				} catch { /* binding throws in sandbox — correct */ }
			} catch { /* blocked is fine */ }

			// 2. eval-based escape
			try {
				const g = eval('this');
				if (g !== globalThis) escapes.push('eval-this-different-global');
			} catch { /* blocked is fine */ }

			// 3. Indirect eval
			try {
				const indirectEval = eval;
				const g = indirectEval('this');
				if (g !== globalThis) escapes.push('indirect-eval-different-global');
			} catch { /* blocked is fine */ }

			// 4. vm.runInThisContext should not grant real host access
			try {
				const vm = require('vm');
				if (typeof vm?.runInThisContext === 'function') {
					const g = vm.runInThisContext('this');
					try {
						const fsBind = g?.process?.binding?.('fs');
						if (typeof fsBind?.open === 'function')
							escapes.push('vm-runInThisContext-real-bindings');
					} catch { /* binding throws in sandbox — correct */ }
				}
			} catch { /* blocked is fine */ }

			// 5. Arguments callee chain
			try {
				(function() {
					const caller = arguments.callee.caller;
					if (caller) escapes.push('arguments-callee-caller-accessible');
				})();
			} catch { /* strict mode or blocked, fine */ }

			console.log(JSON.stringify({ escapes, count: escapes.length }));
		`);

		expect(result.code).toBe(0);
		const output = JSON.parse(capture.stdout().trim());
		expect(output.escapes).toEqual([]);
		expect(output.count).toBe(0);
	});
});
