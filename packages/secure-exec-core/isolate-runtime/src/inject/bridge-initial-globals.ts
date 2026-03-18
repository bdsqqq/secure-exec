import { getRuntimeExposeMutableGlobal } from "../common/global-exposure";

const __runtimeExposeMutableGlobal = getRuntimeExposeMutableGlobal();

const __bridgeSetupConfig = globalThis.__runtimeBridgeSetupConfig ?? {};

const __initialCwd =
	typeof __bridgeSetupConfig.initialCwd === "string"
		? __bridgeSetupConfig.initialCwd
		: "/";
const __jsonPayloadLimitBytes =
	typeof __bridgeSetupConfig.jsonPayloadLimitBytes === "number" &&
	Number.isFinite(__bridgeSetupConfig.jsonPayloadLimitBytes)
		? Math.max(0, Math.floor(__bridgeSetupConfig.jsonPayloadLimitBytes))
		: 4 * 1024 * 1024;
const __payloadLimitErrorCode =
	typeof __bridgeSetupConfig.payloadLimitErrorCode === "string" &&
	__bridgeSetupConfig.payloadLimitErrorCode.length > 0
		? __bridgeSetupConfig.payloadLimitErrorCode
		: "ERR_SANDBOX_PAYLOAD_TOO_LARGE";

// Structured clone encode: converts any value to a JSON-safe tagged representation.
// All non-primitive values are tagged with { t: "type", ... } to avoid ambiguity.
// Circular references tracked via `seen` map → emitted as { t: "ref", i: N }.
function __scEncode(
	value: unknown,
	seen: Map<object, number>,
): unknown {
	if (value === null) return null;
	if (value === undefined) return { t: "undef" };
	if (typeof value === "boolean") return value;
	if (typeof value === "string") return value;
	if (typeof value === "bigint") return { t: "bigint", v: String(value) };
	if (typeof value === "number") {
		if (Object.is(value, -0)) return { t: "-0" };
		if (Number.isNaN(value)) return { t: "nan" };
		if (value === Infinity) return { t: "inf" };
		if (value === -Infinity) return { t: "-inf" };
		return value;
	}

	const obj = value as object;
	if (seen.has(obj)) return { t: "ref", i: seen.get(obj) };
	const idx = seen.size;
	seen.set(obj, idx);

	if (value instanceof Date)
		return { t: "date", v: value.getTime() };
	if (value instanceof RegExp)
		return { t: "regexp", p: value.source, f: value.flags };
	if (value instanceof Map) {
		const entries: unknown[][] = [];
		value.forEach((v, k) => {
			entries.push([__scEncode(k, seen), __scEncode(v, seen)]);
		});
		return { t: "map", v: entries };
	}
	if (value instanceof Set) {
		const elems: unknown[] = [];
		value.forEach((v) => {
			elems.push(__scEncode(v, seen));
		});
		return { t: "set", v: elems };
	}
	if (value instanceof ArrayBuffer) {
		return { t: "ab", v: Array.from(new Uint8Array(value)) };
	}
	if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
		return {
			t: "ta",
			k: value.constructor.name,
			v: Array.from(
				new Uint8Array(value.buffer, value.byteOffset, value.byteLength),
			),
		};
	}
	if (Array.isArray(value)) {
		return {
			t: "arr",
			v: value.map((v) => __scEncode(v, seen)),
		};
	}

	// Plain object
	const result: Record<string, unknown> = {};
	for (const key of Object.keys(value as Record<string, unknown>)) {
		result[key] = __scEncode(
			(value as Record<string, unknown>)[key],
			seen,
		);
	}
	return { t: "obj", v: result };
}

// Structured clone decode: reconstructs values from tagged representation.
// Container objects are pushed to `refs` before recursing so circular refs resolve.
function __scDecode(tagged: unknown, refs: unknown[]): unknown {
	if (tagged === null) return null;
	if (
		typeof tagged === "boolean" ||
		typeof tagged === "string" ||
		typeof tagged === "number"
	)
		return tagged;

	const tag = (tagged as { t?: string }).t;
	if (tag === undefined) return tagged;

	switch (tag) {
		case "undef":
			return undefined;
		case "nan":
			return NaN;
		case "inf":
			return Infinity;
		case "-inf":
			return -Infinity;
		case "-0":
			return -0;
		case "bigint":
			return BigInt((tagged as { v: string }).v);
		case "ref":
			return refs[(tagged as { i: number }).i];
		case "date": {
			const d = new Date((tagged as { v: number }).v);
			refs.push(d);
			return d;
		}
		case "regexp": {
			const r = new RegExp(
				(tagged as { p: string }).p,
				(tagged as { f: string }).f,
			);
			refs.push(r);
			return r;
		}
		case "map": {
			const m = new Map();
			refs.push(m);
			for (const [k, v] of (tagged as { v: unknown[][] }).v) {
				m.set(__scDecode(k, refs), __scDecode(v, refs));
			}
			return m;
		}
		case "set": {
			const s = new Set();
			refs.push(s);
			for (const v of (tagged as { v: unknown[] }).v) {
				s.add(__scDecode(v, refs));
			}
			return s;
		}
		case "ab": {
			const bytes = (tagged as { v: number[] }).v;
			const ab = new ArrayBuffer(bytes.length);
			const u8 = new Uint8Array(ab);
			for (let i = 0; i < bytes.length; i++) u8[i] = bytes[i]!;
			refs.push(ab);
			return ab;
		}
		case "ta": {
			const { k, v: bytes } = tagged as { k: string; v: number[] };
			const ctors: Record<string, new (buf: ArrayBuffer) => ArrayBufferView> =
				{
					Int8Array: Int8Array,
					Uint8Array: Uint8Array,
					Uint8ClampedArray: Uint8ClampedArray,
					Int16Array: Int16Array,
					Uint16Array: Uint16Array,
					Int32Array: Int32Array,
					Uint32Array: Uint32Array,
					Float32Array: Float32Array,
					Float64Array: Float64Array,
				};
			const Ctor = ctors[k] ?? Uint8Array;
			const ab = new ArrayBuffer(bytes.length);
			const u8 = new Uint8Array(ab);
			for (let i = 0; i < bytes.length; i++) u8[i] = bytes[i]!;
			const ta = new Ctor(ab);
			refs.push(ta);
			return ta;
		}
		case "arr": {
			const arr: unknown[] = [];
			refs.push(arr);
			for (const v of (tagged as { v: unknown[] }).v) {
				arr.push(__scDecode(v, refs));
			}
			return arr;
		}
		case "obj": {
			const obj: Record<string, unknown> = {};
			refs.push(obj);
			const entries = (tagged as { v: Record<string, unknown> }).v;
			for (const key of Object.keys(entries)) {
				obj[key] = __scDecode(entries[key], refs);
			}
			return obj;
		}
		default:
			return tagged;
	}
}

__runtimeExposeMutableGlobal("_moduleCache", {});
globalThis._moduleCache = globalThis._moduleCache ?? {};

const __moduleCache = globalThis._moduleCache;
if (__moduleCache) {
	__moduleCache["v8"] = {
		getHeapStatistics: function () {
			return {
				total_heap_size: 67108864,
				total_heap_size_executable: 1048576,
				total_physical_size: 67108864,
				total_available_size: 67108864,
				used_heap_size: 52428800,
				heap_size_limit: 134217728,
				malloced_memory: 8192,
				peak_malloced_memory: 16384,
				does_zap_garbage: 0,
				number_of_native_contexts: 1,
				number_of_detached_contexts: 0,
				external_memory: 0,
			};
		},
		getHeapSpaceStatistics: function () {
			return [];
		},
		getHeapCodeStatistics: function () {
			return {};
		},
		setFlagsFromString: function () {},
		serialize: function (value: unknown) {
			return Buffer.from(
				JSON.stringify({ $v8sc: 1, d: __scEncode(value, new Map()) }),
			);
		},
		deserialize: function (buffer: Buffer) {
			// Check raw buffer size BEFORE allocating the decoded string
			if (buffer.length > __jsonPayloadLimitBytes) {
				throw new Error(
					__payloadLimitErrorCode +
						": v8.deserialize exceeds " +
						String(__jsonPayloadLimitBytes) +
						" bytes",
				);
			}
			const text = buffer.toString();
			const envelope = JSON.parse(text) as {
				$v8sc?: number;
				d?: unknown;
			};
			if (
				envelope !== null &&
				typeof envelope === "object" &&
				envelope.$v8sc === 1
			) {
				return __scDecode(envelope.d, []);
			}
			// Legacy JSON format fallback
			return envelope;
		},
		cachedDataVersionTag: function () {
			return 0;
		},
	};
}

__runtimeExposeMutableGlobal("_pendingModules", {});
__runtimeExposeMutableGlobal("_currentModule", { dirname: __initialCwd });
