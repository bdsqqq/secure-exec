export function hasOwnGlobal(name: string): boolean {
	return Object.prototype.hasOwnProperty.call(globalThis, name);
}

export function getGlobalValue(name: string): unknown {
	return Reflect.get(globalThis, name);
}

export function setGlobalValue(name: string, value: unknown): void {
	Reflect.set(globalThis, name, value);
}

export function isObjectLike(value: unknown): value is Record<string, unknown> {
	return value !== null && (typeof value === "object" || typeof value === "function");
}
