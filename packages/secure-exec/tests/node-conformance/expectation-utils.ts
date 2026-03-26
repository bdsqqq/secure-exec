import { minimatch } from "minimatch";

export type ExpectationEntry = {
	expected: "skip" | "fail" | "pass";
	reason: string;
	category: string;
	glob?: boolean;
	issue?: string;
};

export type ExpectationsFile = {
	nodeVersion: string;
	sourceCommit: string;
	lastUpdated: string;
	expectations: Record<string, ExpectationEntry>;
};

export type ResolvedExpectation = ExpectationEntry & { matchedKey: string };

const VACUOUS_SELF_SKIP_REASON_PATTERNS = [
	/\bvacuous pass\b/i,
	/\bself-skips?\b/i,
	/common\.hasCrypto is false/i,
	/Windows-only test self-skips/i,
	/macOS-only test self-skips/i,
];

export function resolveExpectation(
	filename: string,
	expectations: Record<string, ExpectationEntry>,
): ResolvedExpectation | null {
	if (expectations[filename]) {
		return { ...expectations[filename], matchedKey: filename };
	}

	for (const [key, entry] of Object.entries(expectations)) {
		if (entry.glob && minimatch(filename, key)) {
			return { ...entry, matchedKey: key };
		}
	}

	return null;
}

export function looksLikeVacuousSelfSkipReason(reason: string): boolean {
	return VACUOUS_SELF_SKIP_REASON_PATTERNS.some((pattern) =>
		pattern.test(reason),
	);
}

export function isVacuousPassExpectation(
	expectation: ExpectationEntry | ResolvedExpectation | null | undefined,
): boolean {
	if (expectation?.expected !== "pass") {
		return false;
	}

	return (
		expectation.category === "vacuous-skip" ||
		looksLikeVacuousSelfSkipReason(expectation.reason)
	);
}

export function validateExpectationEntry(
	key: string,
	expectation: ExpectationEntry,
): void {
	if (
		expectation.category === "vacuous-skip" &&
		expectation.expected !== "pass"
	) {
		throw new Error(
			`Expectation "${key}" uses category "vacuous-skip" with expected "${expectation.expected}". Reserve vacuous-skip for expected pass self-skips only.`,
		);
	}
}

export function validateExpectations(
	expectations: Record<string, ExpectationEntry>,
): void {
	for (const [key, expectation] of Object.entries(expectations)) {
		validateExpectationEntry(key, expectation);
	}
}
