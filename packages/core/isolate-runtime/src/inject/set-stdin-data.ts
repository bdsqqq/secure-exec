if (typeof globalThis._stdinData !== "undefined") {
	globalThis._stdinData = globalThis.__runtimeStdinData;
	globalThis._stdinPosition = 0;
	globalThis._stdinEnded = false;
	globalThis._stdinFlowMode = false;
}
