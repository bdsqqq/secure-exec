import {
	getGlobalValue,
	hasOwnGlobal,
} from "../common/global-access";
import {
	getRuntimeExposeCustomGlobal,
	getRuntimeExposeMutableGlobal,
} from "../common/global-exposure";

const __runtimeExposeCustomGlobal = getRuntimeExposeCustomGlobal();
const __runtimeExposeMutableGlobal = getRuntimeExposeMutableGlobal();

const __globalPolicy = globalThis.__runtimeCustomGlobalPolicy ?? {};

const __hardenedGlobals = Array.isArray(__globalPolicy.hardenedGlobals)
	? __globalPolicy.hardenedGlobals
	: [];
const __mutableGlobals = Array.isArray(__globalPolicy.mutableGlobals)
	? __globalPolicy.mutableGlobals
	: [];

for (const globalName of __hardenedGlobals) {
	// Lock down even absent globals so sandbox code cannot define them
	const value = hasOwnGlobal(globalName) ? getGlobalValue(globalName) : undefined;
	__runtimeExposeCustomGlobal(globalName, value);
}

for (const globalName of __mutableGlobals) {
	if (hasOwnGlobal(globalName)) {
		__runtimeExposeMutableGlobal(globalName, getGlobalValue(globalName));
	}
}
