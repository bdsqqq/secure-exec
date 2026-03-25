import type { LoadPolyfillBridgeRef } from "../bridge-contract.js";

type DispatchBridgeRef = LoadPolyfillBridgeRef & {
	applySyncPromise(ctx: undefined, args: [string]): string | null;
};

declare const _loadPolyfill: DispatchBridgeRef | undefined;

function encodeDispatch(method: string, args: unknown[]): string {
	return `__bd:${method}:${JSON.stringify(args)}`;
}

function parseDispatchResult<T>(resultJson: string | null): T {
	if (resultJson === null) {
		return undefined as T;
	}

	const parsed = JSON.parse(resultJson) as {
		__bd_error?: string;
		__bd_result?: T;
	};
	if (parsed.__bd_error) {
		throw new Error(parsed.__bd_error);
	}
	return parsed.__bd_result as T;
}

function requireDispatchBridge(): DispatchBridgeRef {
	if (!_loadPolyfill) {
		throw new Error("_loadPolyfill is not available in sandbox");
	}
	return _loadPolyfill;
}

export function bridgeDispatchSync<T>(method: string, ...args: unknown[]): T {
	const bridge = requireDispatchBridge();
	return parseDispatchResult<T>(
		bridge.applySyncPromise(undefined, [encodeDispatch(method, args)]),
	);
}

export async function bridgeDispatchAsync<T>(
	method: string,
	...args: unknown[]
): Promise<T> {
	const bridge = requireDispatchBridge();
	return parseDispatchResult<T>(
		await bridge.apply(undefined, [encodeDispatch(method, args)], {
			result: { promise: true },
		}),
	);
}
