const __envPatch = globalThis.__runtimeProcessEnvOverride;
if (__envPatch && typeof __envPatch === "object") {
	Object.assign(process.env, __envPatch as NodeJS.ProcessEnv);
}
