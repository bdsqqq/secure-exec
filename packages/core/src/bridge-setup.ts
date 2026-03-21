import { getIsolateRuntimeSource } from "./generated/isolate-runtime.js";

/**
 * Get the isolate-side script that initializes early mutable runtime globals
 * (`_moduleCache`, `_pendingModules`, `_currentModule`) before module loading
 * and require wiring run.
 */
export function getInitialBridgeGlobalsSetupCode(): string {
	return getIsolateRuntimeSource("bridgeInitialGlobals");
}
