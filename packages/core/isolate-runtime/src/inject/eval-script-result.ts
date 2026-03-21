const __runtimeIndirectEval = globalThis.eval as (source: string) => unknown;
globalThis.__scriptResult__ = __runtimeIndirectEval(
	String(globalThis.__runtimeExecCode),
);
