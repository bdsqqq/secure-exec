import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
	classifyImplementationIntent,
	type ExpectationEntry,
	isVacuousPassExpectation,
	resolveExpectation,
	validateExpectationEntry,
} from "./expectation-utils.ts";

describe("node conformance expectation utils", () => {
	it("treats explicit vacuous-skip pass entries as vacuous passes", () => {
		const expectation: ExpectationEntry = {
			expected: "pass",
			category: "vacuous-skip",
			reason: "vacuous pass — Windows-only test self-skips on Linux sandbox",
		};

		expect(isVacuousPassExpectation(expectation)).toBe(true);
	});

	it("defensively treats self-skip pass reasons as vacuous even if the category is stale", () => {
		const expectation: ExpectationEntry = {
			expected: "pass",
			category: "implementation-gap",
			reason:
				"vacuous pass — test self-skips via common.skip() because common.hasCrypto is false",
		};

		expect(isVacuousPassExpectation(expectation)).toBe(true);
	});

	it("rejects vacuous-skip on non-pass expectations", () => {
		expect(() =>
			validateExpectationEntry("test-self-skip.js", {
				expected: "skip",
				category: "vacuous-skip",
				reason: "test self-skips before exercising functionality",
			}),
		).toThrow(/Reserve vacuous-skip for expected pass self-skips only/);
	});

	it("prefers direct expectation matches over glob overrides", () => {
		const expectation = resolveExpectation("test-http-example.js", {
			"test-http-*.js": {
				expected: "fail",
				category: "implementation-gap",
				reason: "broad module expectation",
				glob: true,
			},
			"test-http-example.js": {
				expected: "pass",
				category: "implementation-gap",
				reason: "genuinely passes — overrides glob pattern",
			},
		});

		expect(expectation).toMatchObject({
			matchedKey: "test-http-example.js",
			expected: "pass",
		});
	});

	it("classifies deferred runtime gaps as implementable", () => {
		expect(
			classifyImplementationIntent("test-http-server.js", {
				expected: "fail",
				category: "unsupported-module",
				reason: "requires net module which is Tier 4 (Deferred)",
			}),
		).toBe("implementable");
	});

	it("classifies policy-rejected test surfaces as will-not-implement", () => {
		expect(
			classifyImplementationIntent("test-abortcontroller.js", {
				expected: "fail",
				category: "requires-v8-flags",
				reason: "requires --expose-gc — GC control not available in sandbox",
			}),
		).toBe("will-not-implement");
		expect(
			classifyImplementationIntent("test-repl.js", {
				expected: "fail",
				category: "unsupported-module",
				reason: "requires net module which is Tier 4 (Deferred)",
			}),
		).toBe("will-not-implement");
	});

	it("classifies architectural blockers as cannot-implement", () => {
		expect(
			classifyImplementationIntent("test-assert-builtins.js", {
				expected: "fail",
				category: "requires-exec-path",
				reason:
					"spawns child Node.js process via process.execPath — sandbox does not provide a real node binary",
			}),
		).toBe("cannot-implement");
		expect(
			classifyImplementationIntent("test-child-process-fork-net.js", {
				expected: "fail",
				category: "unsupported-module",
				reason: "requires net module which is Tier 4 (Deferred)",
			}),
		).toBe("cannot-implement");
	});

	it("classifies every non-pass expectation in expectations.json", () => {
		const data = JSON.parse(
			readFileSync(
				new URL("./expectations.json", import.meta.url),
				"utf-8",
			),
		) as {
			expectations: Record<string, ExpectationEntry>;
		};

		for (const [key, expectation] of Object.entries(data.expectations)) {
			if (expectation.expected === "pass") {
				continue;
			}

			expect(
				classifyImplementationIntent(key, expectation),
				`missing implementation intent for ${key}`,
			).toMatch(/implement|cannot/);
		}
	});
});
