import { setGlobalValue } from "../common/global-access";

if (typeof globalThis.performance === "undefined" || globalThis.performance === null) {
	setGlobalValue("performance", {
		now: () => Date.now(),
	});
}
