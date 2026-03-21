export type RuntimeGlobalExposer = (name: string, value: unknown) => void;

export function defineRuntimeGlobalBinding(
	name: string,
	value: unknown,
	mutable: boolean,
): void {
	Object.defineProperty(globalThis, name, {
		value,
		writable: mutable,
		configurable: mutable,
		enumerable: true,
	});
}

function createRuntimeGlobalExposer(mutable: boolean): RuntimeGlobalExposer {
	return (name, value) => {
		defineRuntimeGlobalBinding(name, value, mutable);
	};
}

export function getRuntimeExposeCustomGlobal(): RuntimeGlobalExposer {
	if (typeof globalThis.__runtimeExposeCustomGlobal === "function") {
		return globalThis.__runtimeExposeCustomGlobal;
	}
	return createRuntimeGlobalExposer(false);
}

export function getRuntimeExposeMutableGlobal(): RuntimeGlobalExposer {
	if (typeof globalThis.__runtimeExposeMutableGlobal === "function") {
		return globalThis.__runtimeExposeMutableGlobal;
	}
	return createRuntimeGlobalExposer(true);
}

export function ensureRuntimeExposureHelpers(): void {
	if (typeof globalThis.__runtimeExposeCustomGlobal !== "function") {
		defineRuntimeGlobalBinding(
			"__runtimeExposeCustomGlobal",
			createRuntimeGlobalExposer(false),
			false,
		);
	}

	if (typeof globalThis.__runtimeExposeMutableGlobal !== "function") {
		defineRuntimeGlobalBinding(
			"__runtimeExposeMutableGlobal",
			createRuntimeGlobalExposer(true),
			false,
		);
	}
}
