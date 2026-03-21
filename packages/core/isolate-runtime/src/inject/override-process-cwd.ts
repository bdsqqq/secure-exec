const __cwd = globalThis.__runtimeProcessCwdOverride;
if (typeof __cwd === "string") {
	process.cwd = () => __cwd;
}
