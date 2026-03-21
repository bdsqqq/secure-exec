import { getRuntimeExposeMutableGlobal } from "../common/global-exposure";

const __runtimeExposeMutableGlobal = getRuntimeExposeMutableGlobal();

__runtimeExposeMutableGlobal("module", { exports: {} });
__runtimeExposeMutableGlobal("exports", globalThis.module.exports);
