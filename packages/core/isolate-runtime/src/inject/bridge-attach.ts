import { getRuntimeExposeCustomGlobal } from "../common/global-exposure";

const __runtimeExposeCustomGlobal = getRuntimeExposeCustomGlobal();

if (typeof globalThis.bridge !== "undefined") {
	__runtimeExposeCustomGlobal("bridge", globalThis.bridge);
}
