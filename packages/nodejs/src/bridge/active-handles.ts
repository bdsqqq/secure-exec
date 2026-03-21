import { exposeCustomGlobal } from "@secure-exec/core/internal/shared/global-exposure";

/**
 * Active Handles: Mechanism to keep the sandbox alive for async operations.
 *
 * The V8 isolate doesn't have an event loop, so async callbacks (like child process
 * events) would never fire because the sandbox exits immediately after synchronous
 * code finishes. This module tracks active handles and provides a promise that
 * resolves when all handles complete.
 *
 * See: docs-internal/node/ACTIVE_HANDLES.md
 */

// _maxHandles is injected by the host when resourceBudgets.maxHandles is set.
declare const _maxHandles: number | undefined;

// Map of active handles: id -> description (for debugging)
const _activeHandles = new Map<string, string>();

// Resolvers waiting for all handles to complete
let _waitResolvers: Array<() => void> = [];

/**
 * Register an active handle that keeps the sandbox alive.
 * Throws if the handle cap (_maxHandles) would be exceeded.
 * @param id Unique identifier for the handle
 * @param description Human-readable description for debugging
 */
export function _registerHandle(id: string, description: string): void {
	// Enforce handle cap (skip check for re-registration of existing handle)
	if (typeof _maxHandles !== "undefined" && !_activeHandles.has(id) && _activeHandles.size >= _maxHandles) {
		throw new Error("ERR_RESOURCE_BUDGET_EXCEEDED: maximum active handles exceeded");
	}
	_activeHandles.set(id, description);
}

/**
 * Unregister a handle. If no handles remain, resolves all waiters.
 * @param id The handle identifier to unregister
 */
export function _unregisterHandle(id: string): void {
	_activeHandles.delete(id);
	if (_activeHandles.size === 0 && _waitResolvers.length > 0) {
		const resolvers = _waitResolvers;
		_waitResolvers = [];
		resolvers.forEach((r) => r());
	}
}

/**
 * Wait for all active handles to complete.
 * Returns immediately if no handles are active.
 */
export function _waitForActiveHandles(): Promise<void> {
	if (_activeHandles.size === 0) {
		return Promise.resolve();
	}
	return new Promise((resolve) => {
		_waitResolvers.push(resolve);
	});
}

/**
 * Get list of currently active handles (for debugging).
 * Returns array of [id, description] tuples.
 */
export function _getActiveHandles(): Array<[string, string]> {
	return Array.from(_activeHandles.entries());
}

// Install on globalThis for use by other bridge modules and exec().
// Lock bridge internals so sandbox code cannot replace lifecycle hooks.
exposeCustomGlobal("_registerHandle", _registerHandle);
exposeCustomGlobal("_unregisterHandle", _unregisterHandle);
exposeCustomGlobal("_waitForActiveHandles", _waitForActiveHandles);
exposeCustomGlobal("_getActiveHandles", _getActiveHandles);
