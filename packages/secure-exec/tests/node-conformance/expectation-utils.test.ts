import { describe, expect, it } from "vitest";
import {
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
});
