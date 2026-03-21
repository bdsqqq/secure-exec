/**
 * Core-only types for secure-exec SDK.
 *
 * VFS and permission types are now defined in src/kernel/ (canonical source).
 */

export interface SpawnedProcess {
	writeStdin(data: Uint8Array | string): void;
	closeStdin(): void;
	kill(signal?: number): void;
	wait(): Promise<number>;
}

export interface CommandExecutor {
	spawn(
		command: string,
		args: string[],
		options: {
			cwd?: string;
			env?: Record<string, string>;
			onStdout?: (data: Uint8Array) => void;
			onStderr?: (data: Uint8Array) => void;
		},
	): SpawnedProcess;
}

export interface NetworkServerAddress {
	address: string;
	family: string;
	port: number;
}

export interface NetworkServerRequest {
	method: string;
	url: string;
	headers: Record<string, string>;
	rawHeaders: string[];
	bodyBase64?: string;
}

export interface NetworkServerResponse {
	status: number;
	headers?: Array<[string, string]>;
	body?: string;
	bodyEncoding?: "utf8" | "base64";
}

export interface NetworkServerListenOptions {
	serverId: number;
	port?: number;
	hostname?: string;
	onRequest(
		request: NetworkServerRequest,
	): Promise<NetworkServerResponse> | NetworkServerResponse;
	/** Called when an HTTP upgrade request arrives (e.g. WebSocket). */
	onUpgrade?(
		request: NetworkServerRequest,
		head: string,
		socketId: number,
	): void;
	/** Called when the real upgrade socket receives data from the remote peer. */
	onUpgradeSocketData?(socketId: number, dataBase64: string): void;
	/** Called when the real upgrade socket closes. */
	onUpgradeSocketEnd?(socketId: number): void;
}

export interface NetworkAdapter {
	httpServerListen?(
		options: NetworkServerListenOptions,
	): Promise<{ address: NetworkServerAddress | null }>;
	httpServerClose?(serverId: number): Promise<void>;
	/** Write data from the sandbox to a real upgrade socket on the host. */
	upgradeSocketWrite?(socketId: number, dataBase64: string): void;
	/** End a real upgrade socket on the host. */
	upgradeSocketEnd?(socketId: number): void;
	/** Destroy a real upgrade socket on the host. */
	upgradeSocketDestroy?(socketId: number): void;
	fetch(
		url: string,
		options: {
			method?: string;
			headers?: Record<string, string>;
			body?: string | null;
		},
	): Promise<{
		ok: boolean;
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
		url: string;
		redirected: boolean;
	}>;
	dnsLookup(hostname: string): Promise<
		| {
				address: string;
				family: number;
		  }
		| { error: string; code: string }
	>;
	httpRequest(
		url: string,
		options: {
			method?: string;
			headers?: Record<string, string>;
			body?: string | null;
			rejectUnauthorized?: boolean;
		},
	): Promise<{
		status: number;
		statusText: string;
		headers: Record<string, string>;
		body: string;
		url: string;
		trailers?: Record<string, string>;
		upgradeSocketId?: number;
	}>;
	/** Register callbacks for client-side upgrade socket data push. */
	setUpgradeSocketCallbacks?(callbacks: {
		onData: (socketId: number, dataBase64: string) => void;
		onEnd: (socketId: number) => void;
	}): void;
	/** Create a TCP socket connection on the host. Returns socketId. */
	netSocketConnect?(
		host: string,
		port: number,
		callbacks: {
			onConnect: () => void;
			onData: (dataBase64: string) => void;
			onEnd: () => void;
			onError: (message: string) => void;
			onClose: () => void;
		},
	): number;
	/** Write data to a net socket. */
	netSocketWrite?(socketId: number, dataBase64: string): void;
	/** Half-close a net socket (send FIN). */
	netSocketEnd?(socketId: number): void;
	/** Forcefully destroy a net socket. */
	netSocketDestroy?(socketId: number): void;
	/** Upgrade a net socket to TLS. Re-wires events for the TLS layer. */
	netSocketUpgradeTls?(
		socketId: number,
		options: { rejectUnauthorized?: boolean; servername?: string },
		callbacks: {
			onSecureConnect: () => void;
			onData: (dataBase64: string) => void;
			onEnd: () => void;
			onError: (message: string) => void;
			onClose: () => void;
		},
	): void;
}

export type {
	DriverRuntimeConfig,
	NodeRuntimeDriver,
	NodeRuntimeDriverFactory,
	PythonRuntimeDriver,
	PythonRuntimeDriverFactory,
	RuntimeDriver,
	RuntimeDriverFactory,
	RuntimeDriverOptions,
	SharedRuntimeDriver,
	SystemDriver,
} from "./runtime-driver.js";
