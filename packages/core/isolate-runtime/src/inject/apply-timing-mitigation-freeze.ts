import { setGlobalValue } from "../common/global-access";

const __timingConfig = globalThis.__runtimeTimingMitigationConfig ?? {};

const __frozenTimeMs =
	typeof __timingConfig.frozenTimeMs === "number" &&
	Number.isFinite(__timingConfig.frozenTimeMs)
		? __timingConfig.frozenTimeMs
		: Date.now();
const __frozenDateNow = () => __frozenTimeMs;

// Freeze Date.now — getter always returns frozen fn, setter silently ignores
try {
	Object.defineProperty(Date, "now", {
		get: () => __frozenDateNow,
		set: () => {},
		configurable: false,
	});
} catch {
	Date.now = __frozenDateNow;
}

// Patch Date constructor so new Date().getTime() returns degraded time
const __OrigDate = Date;
const __FrozenDate = function Date(
	this: InstanceType<DateConstructor>,
	...args: unknown[]
) {
	if (new.target) {
		// Called with new — no-arg returns frozen time, with args passes through
		if (args.length === 0) {
			return new __OrigDate(__frozenTimeMs);
		}
		// @ts-expect-error — spread forwarding to variadic Date constructor
		return new __OrigDate(...args);
	}
	// Called without new — Date() returns string like original
	return __OrigDate();
} as unknown as DateConstructor;
Object.defineProperty(__FrozenDate, "prototype", {
	value: __OrigDate.prototype,
	writable: false,
	configurable: false,
});
__FrozenDate.now = __frozenDateNow;
__FrozenDate.parse = __OrigDate.parse;
__FrozenDate.UTC = __OrigDate.UTC;
// Lock Date.now on the replacement constructor — getter/setter silently ignores writes
Object.defineProperty(__FrozenDate, "now", {
	get: () => __frozenDateNow,
	set: () => {},
	configurable: false,
});
try {
	Object.defineProperty(globalThis, "Date", {
		value: __FrozenDate,
		configurable: false,
		writable: false,
	});
} catch {
	(globalThis as Record<string, unknown>).Date = __FrozenDate;
}

/* Replace globalThis.performance with a frozen proxy — native V8 performance
   may have non-configurable properties that prevent in-place freezing. */
const __frozenPerformanceNow = () => 0;
const __origPerf = globalThis.performance;
const __frozenPerf = Object.create(null) as Record<string, unknown>;
// Copy existing methods/properties, override now()
if (typeof __origPerf !== "undefined" && __origPerf !== null) {
	const src = __origPerf as unknown as Record<string, unknown>;
	for (const key of Object.getOwnPropertyNames(
		Object.getPrototypeOf(__origPerf) ?? __origPerf,
	)) {
		if (key !== "now") {
			try {
				const val = src[key];
				if (typeof val === "function") {
					__frozenPerf[key] = val.bind(__origPerf);
				} else {
					__frozenPerf[key] = val;
				}
			} catch {
				/* skip inaccessible properties */
			}
		}
	}
}
Object.defineProperty(__frozenPerf, "now", {
	value: __frozenPerformanceNow,
	configurable: false,
	writable: false,
});
Object.freeze(__frozenPerf);
try {
	Object.defineProperty(globalThis, "performance", {
		value: __frozenPerf,
		configurable: false,
		writable: false,
	});
} catch {
	(globalThis as Record<string, unknown>).performance = __frozenPerf;
}

/* Harden SharedArrayBuffer removal — neuter prototype so saved refs are useless,
   then lock the global property so sandbox code cannot restore it. */
const __OrigSAB = globalThis.SharedArrayBuffer;
if (typeof __OrigSAB === "function") {
	// Neuter the prototype so any previously-saved reference produces broken instances
	try {
		const proto = __OrigSAB.prototype;
		if (proto) {
			for (const key of [
				"byteLength",
				"slice",
				"grow",
				"maxByteLength",
				"growable",
			]) {
				try {
					Object.defineProperty(proto, key, {
						get() {
							throw new TypeError(
								"SharedArrayBuffer is not available in sandbox",
							);
						},
						configurable: false,
					});
				} catch {
					/* property may not exist or be non-configurable */
				}
			}
		}
	} catch {
		/* best-effort prototype neutering */
	}
}

// Lock the global to undefined — configurable: false prevents re-definition
try {
	Object.defineProperty(globalThis, "SharedArrayBuffer", {
		value: undefined,
		configurable: false,
		writable: false,
		enumerable: false,
	});
} catch {
	// Fallback: delete then set
	Reflect.deleteProperty(globalThis, "SharedArrayBuffer");
	setGlobalValue("SharedArrayBuffer", undefined);
}
