import { minimatch } from "minimatch";

export type ExpectationEntry = {
	expected: "skip" | "fail" | "pass";
	reason: string;
	category: string;
	glob?: boolean;
	issue?: string;
};

export type ImplementationIntent =
	| "implementable"
	| "will-not-implement"
	| "cannot-implement";

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

function matchesAny(value: string, patterns: RegExp[]): boolean {
	return patterns.some((pattern) => pattern.test(value));
}

const IMPLEMENTABLE_TEST_INFRA_REASON_PATTERNS = [
	/missing from the conformance VFS/i,
	/Cannot find module '\.{1,2}\//,
	/Illegal return statement/i,
];

const CANNOT_IMPLEMENT_UNSUPPORTED_MODULE_KEY_PATTERNS = [
	/^test-child-process-fork/,
	/^test-vm-timeout\.js$/,
];

const CANNOT_IMPLEMENT_UNSUPPORTED_MODULE_REASON_PATTERNS = [
	/\bcluster module\b/i,
	/\bcluster-managed\b/i,
	/\bworker_threads\b/i,
	/\bvm module\b/i,
	/process signals not available/i,
];

const WILL_NOT_IMPLEMENT_UNSUPPORTED_MODULE_KEY_PATTERNS = [
	/^test-quic/,
	/^test-repl/,
];

const WILL_NOT_IMPLEMENT_UNSUPPORTED_MODULE_REASON_PATTERNS = [
	/\bnode:test module\b/i,
	/requires 'test' module/i,
	/Cannot find module 'test'/,
	/\binspector\b/i,
	/\brepl module\b/i,
	/\bdomain module\b/i,
	/\btrace_events\b/i,
	/\bdebugger protocol\b/i,
	/internal\/test\/binding/i,
	/Cannot find module 'internal\//,
	/Cannot find module '_/,
	/internal stream aliases/i,
	/internal Node\.js alias/i,
	/corepack is not bundled/i,
	/npm is not bundled/i,
];

const CANNOT_IMPLEMENT_UNSUPPORTED_API_REASON_PATTERNS = [
	/child_process\.fork/i,
	/no inotify\/kqueue\/FSEvents-style watcher primitive/i,
	/V8 snapshot\/startup features/i,
	/V8 compile cache\/code cache features/i,
	/\bShadowRealm\b/i,
];

const WILL_NOT_IMPLEMENT_UNSUPPORTED_API_REASON_PATTERNS = [
	/tls\.createSecurePair/i,
	/deprecated net\._setSimultaneousAccepts/i,
	/document is not defined/i,
];

export function classifyImplementationIntent(
	key: string,
	expectation: ExpectationEntry | ResolvedExpectation,
): ImplementationIntent | null {
	if (expectation.expected === "pass") {
		return null;
	}

	switch (expectation.category) {
		case "implementation-gap":
			return "implementable";
		case "requires-exec-path":
		case "native-addon":
			return "cannot-implement";
		case "requires-v8-flags":
		case "security-constraint":
			return "will-not-implement";
		case "test-infra":
			return matchesAny(
				expectation.reason,
				IMPLEMENTABLE_TEST_INFRA_REASON_PATTERNS,
			)
				? "implementable"
				: "will-not-implement";
		case "unsupported-module":
			if (
				matchesAny(key, CANNOT_IMPLEMENT_UNSUPPORTED_MODULE_KEY_PATTERNS) ||
				matchesAny(
					expectation.reason,
					CANNOT_IMPLEMENT_UNSUPPORTED_MODULE_REASON_PATTERNS,
				)
			) {
				return "cannot-implement";
			}

			if (
				matchesAny(key, WILL_NOT_IMPLEMENT_UNSUPPORTED_MODULE_KEY_PATTERNS) ||
				matchesAny(
					expectation.reason,
					WILL_NOT_IMPLEMENT_UNSUPPORTED_MODULE_REASON_PATTERNS,
				)
			) {
				return "will-not-implement";
			}

			return "implementable";
		case "unsupported-api":
			if (
				matchesAny(
					expectation.reason,
					CANNOT_IMPLEMENT_UNSUPPORTED_API_REASON_PATTERNS,
				)
			) {
				return "cannot-implement";
			}

			if (
				matchesAny(
					expectation.reason,
					WILL_NOT_IMPLEMENT_UNSUPPORTED_API_REASON_PATTERNS,
				)
			) {
				return "will-not-implement";
			}

			return "implementable";
		default:
			throw new Error(
				`Expectation "${key}" uses category "${expectation.category}" without an implementation-intent classifier.`,
			);
	}
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

	if (expectation.expected !== "pass") {
		classifyImplementationIntent(key, expectation);
	}
}

export function validateExpectations(
	expectations: Record<string, ExpectationEntry>,
): void {
	for (const [key, expectation] of Object.entries(expectations)) {
		validateExpectationEntry(key, expectation);
	}
}
