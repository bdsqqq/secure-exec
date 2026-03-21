import { getRuntimeExposeMutableGlobal } from "../common/global-exposure";

const __runtimeExposeMutableGlobal = getRuntimeExposeMutableGlobal();

const __commonJsFileConfig = globalThis.__runtimeCommonJsFileConfig ?? {};

const __filePath =
	typeof __commonJsFileConfig.filePath === "string"
		? __commonJsFileConfig.filePath
		: "/<entry>.js";
const __dirname =
	typeof __commonJsFileConfig.dirname === "string"
		? __commonJsFileConfig.dirname
		: "/";

__runtimeExposeMutableGlobal("__filename", __filePath);
__runtimeExposeMutableGlobal("__dirname", __dirname);

const __currentModule = globalThis._currentModule;
if (__currentModule) {
	__currentModule.dirname = __dirname;
	__currentModule.filename = __filePath;
}
