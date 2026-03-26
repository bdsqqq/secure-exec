const SHARED_KEY = "__secureExecInternalTestBinding";

function getBindingState() {
	if (globalThis[SHARED_KEY]) {
		return globalThis[SHARED_KEY];
	}

	const runtimeRequire = typeof globalThis.require === "function" ? globalThis.require : null;
	const EventEmitter = runtimeRequire?.("events")?.EventEmitter;

	class JSStream extends (EventEmitter || class {}) {
		constructor() {
			super();
			this.onread = null;
			this.onwrite = null;
			this.onshutdown = null;
			this._secureExecOnEnd = null;
		}

		readBuffer(buffer) {
			if (typeof this.onread === "function") {
				this.onread(buffer);
			}
		}

		emitEOF() {
			this._secureExecOnEnd?.();
		}
	}

	const state = {
		internalBinding(name) {
			if (name === "js_stream") {
				return { JSStream };
			}
			throw new Error(`Unsupported internal test binding: ${name}`);
		},
	};

	globalThis[SHARED_KEY] = state;
	return state;
}

export const internalBinding = getBindingState().internalBinding;
