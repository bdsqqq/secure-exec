import type { StdioEvent } from "../../../src/shared/api-types.js";
import { afterEach, expect, it } from "vitest";
import type { NodeSuiteContext } from "./runtime.js";

export function runNodeCryptoDebugSuite(context: NodeSuiteContext): void {
	afterEach(async () => {
		await context.teardown();
	});

	it("simple debug test", async () => {
		const events: StdioEvent[] = [];
		const runtime = await context.createRuntime({
			onStdio: (event) => events.push(event),
		});
		const result = await runtime.run(`
			console.log('TEST: hello world');
			console.log('TEST: _cryptoSign available:', typeof _cryptoSign !== 'undefined');
			const crypto = require('crypto');
			console.log('TEST: crypto.createSign type:', typeof crypto.createSign);
			console.log('TEST: crypto.Sign type:', typeof crypto.Sign);
			const { privateKey } = crypto.generateKeyPairSync('ec', {
				namedCurve: 'prime256v1',
			});
			const sign = crypto.createSign('SHA256');
			console.log('TEST: sign type:', typeof sign);
			console.log('TEST: sign.update type:', typeof sign.update);
			console.log('TEST: sign.sign type:', typeof sign.sign);
			sign.update('data');
			console.log('TEST: after update, sign._finalized:', sign._finalized);
			const sig = sign.sign(privateKey);
			console.log('TEST: after sign, sign._finalized:', sign._finalized);
			
			let updateError, signError;
			try {
				sign.update('more');
				console.log('TEST: update did not throw!');
			} catch (e) {
				console.log('TEST: update threw:', e.code);
				updateError = { code: e.code, message: e.message };
			}
			try {
				sign.sign(privateKey);
				console.log('TEST: sign did not throw!');
			} catch (e) {
				console.log('TEST: sign threw:', e.code);
				signError = { code: e.code, message: e.message };
			}
			module.exports = { updateError, signError };
		`);
		console.log('RESULT:', JSON.stringify(result, null, 2));
		console.log('STDIO EVENTS:', JSON.stringify(events, null, 2));
		expect(result.code).toBe(0);
	});
}
