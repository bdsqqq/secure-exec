/**
 * Validate permission callback source strings before revival via new Function().
 *
 * Permission callbacks are serialized with fn.toString() on the host and revived
 * in the Web Worker. Because revival uses new Function(), the source must be
 * validated to prevent code injection.
 */

/**
 * Dangerous patterns that should never appear in a permission callback.
 * These could be used to escape the sandbox or access host resources.
 */
const BLOCKED_PATTERNS: RegExp[] = [
	// Code execution / eval
	/\beval\s*\(/,
	/\bFunction\s*\(/,
	/\bnew\s+Function\b/,

	// Module loading
	/\bimport\s*\(/,
	/\bimportScripts\s*\(/,
	/\brequire\s*\(/,

	// Global object access
	/\bglobalThis\b/,
	/\bself\b/,
	/\bwindow\b/,

	// Process/system access
	/\bprocess\s*\.\s*(?:exit|kill|binding|_linkedBinding|env)\b/,

	// Network / IO escape
	/\bXMLHttpRequest\b/,
	/\bWebSocket\b/,
	/\bfetch\s*\(/,

	// Prototype pollution / constructor abuse
	/\bconstructor\s*\[/,
	/\b__proto__\b/,
	/Object\s*\.\s*(?:defineProperty|setPrototypeOf|assign)\b/,

	// Dynamic property access on dangerous objects
	/\bpostMessage\b/,
];

/**
 * Validate that a permission callback source string is safe to revive.
 *
 * Returns true if the source appears to be a safe function expression.
 * Returns false if the source contains blocked patterns that could indicate
 * code injection.
 */
export function validatePermissionSource(source: string): boolean {
	if (!source || typeof source !== "string") return false;

	const trimmed = source.trim();

	// Must look like a function expression (arrow function or function keyword)
	const startsLikeFunction =
		trimmed.startsWith("function") ||
		trimmed.startsWith("(") ||
		// Single-param arrow functions: x => ...
		/^[a-zA-Z_$][a-zA-Z0-9_$]*\s*=>/.test(trimmed);

	if (!startsLikeFunction) return false;

	// Check for blocked patterns
	for (const pattern of BLOCKED_PATTERNS) {
		if (pattern.test(source)) return false;
	}

	return true;
}
