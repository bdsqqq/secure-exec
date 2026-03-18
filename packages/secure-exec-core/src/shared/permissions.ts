/**
 * Permission enforcement layer.
 *
 * Wraps filesystem, network, and command-executor adapters with permission
 * checks that throw EACCES on denial. When no permission callback is provided
 * for a category, guarded operations in that category are denied by default.
 */

import { createEaccesError, createEnosysError } from "./errors.js";
import type {
	CommandExecutor,
	EnvAccessRequest,
	FsAccessRequest,
	NetworkAdapter,
	Permissions,
	VirtualFileSystem,
} from "../types.js";

/** Run the permission check; throw the deny error if no checker exists or it denies. */
function checkPermission<T>(
	check: ((request: T) => { allow: boolean; reason?: string }) | undefined,
	request: T,
	onDenied: (request: T) => Error,
): void {
	if (!check) {
		throw onDenied(request);
	}
	const decision = check(request);
	if (!decision?.allow) {
		throw onDenied(request);
	}
}

// Permission callbacks must be self-contained (no closures) because they are
// serialized via `.toString()` for transfer to the browser Web Worker.
export const allowAllFs: Pick<Permissions, "fs"> = {
	fs: () => ({ allow: true }),
};

export const allowAllNetwork: Pick<Permissions, "network"> = {
	network: () => ({ allow: true }),
};

export const allowAllChildProcess: Pick<Permissions, "childProcess"> = {
	childProcess: () => ({ allow: true }),
};

export const allowAllEnv: Pick<Permissions, "env"> = {
	env: () => ({ allow: true }),
};

export const allowAll: Permissions = {
	...allowAllFs,
	...allowAllNetwork,
	...allowAllChildProcess,
	...allowAllEnv,
};

function fsOpToSyscall(op: FsAccessRequest["op"]): string {
	switch (op) {
		case "read":
			return "open";
		case "write":
			return "write";
		case "mkdir":
		case "createDir":
			return "mkdir";
		case "readdir":
			return "scandir";
		case "stat":
			return "stat";
		case "rm":
			return "unlink";
		case "rename":
			return "rename";
		case "exists":
			return "access";
		case "chmod":
			return "chmod";
		case "chown":
			return "chown";
		case "link":
			return "link";
		case "symlink":
			return "symlink";
		case "readlink":
			return "readlink";
		case "truncate":
			return "open";
		case "utimes":
			return "utimes";
		default:
			return "open";
	}
}

/**
 * Wrap a VirtualFileSystem so every operation passes through the fs permission check.
 * Throws EACCES if the permission callback denies or is absent.
 */
export function wrapFileSystem(
	fs: VirtualFileSystem,
	permissions?: Permissions,
): VirtualFileSystem {
	return {
		readFile: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "read", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.readFile(path);
		},
		readTextFile: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "read", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.readTextFile(path);
		},
		readDir: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "readdir", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.readDir(path);
		},
		readDirWithTypes: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "readdir", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.readDirWithTypes(path);
		},
		writeFile: async (path, content) => {
			checkPermission(
				permissions?.fs,
				{ op: "write", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.writeFile(path, content);
		},
		createDir: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "createDir", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.createDir(path);
		},
		mkdir: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "mkdir", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.mkdir(path);
		},
		exists: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "exists", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.exists(path);
		},
		stat: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "stat", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.stat(path);
		},
		removeFile: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "rm", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.removeFile(path);
		},
		removeDir: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "rm", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.removeDir(path);
		},
		rename: async (oldPath, newPath) => {
			checkPermission(
				permissions?.fs,
				{ op: "rename", path: oldPath },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			checkPermission(
				permissions?.fs,
				{ op: "rename", path: newPath },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.rename(oldPath, newPath);
		},
		symlink: async (target, linkPath) => {
			checkPermission(
				permissions?.fs,
				{ op: "symlink", path: linkPath },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.symlink(target, linkPath);
		},
		readlink: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "readlink", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.readlink(path);
		},
		lstat: async (path) => {
			checkPermission(
				permissions?.fs,
				{ op: "stat", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.lstat(path);
		},
		link: async (oldPath, newPath) => {
			checkPermission(
				permissions?.fs,
				{ op: "link", path: newPath },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.link(oldPath, newPath);
		},
		chmod: async (path, mode) => {
			checkPermission(
				permissions?.fs,
				{ op: "chmod", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.chmod(path, mode);
		},
		chown: async (path, uid, gid) => {
			checkPermission(
				permissions?.fs,
				{ op: "chown", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.chown(path, uid, gid);
		},
		utimes: async (path, atime, mtime) => {
			checkPermission(
				permissions?.fs,
				{ op: "utimes", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.utimes(path, atime, mtime);
		},
		truncate: async (path, length) => {
			checkPermission(
				permissions?.fs,
				{ op: "truncate", path },
				(req) => createEaccesError(fsOpToSyscall(req.op), req.path),
			);
			return fs.truncate(path, length);
		},
	};
}

/**
 * Wrap a NetworkAdapter so externally-originating operations (`listen`, `fetch`,
 * `dns`, `http`) pass through the network permission check.
 * `httpServerClose` is forwarded as-is.
 */
export function wrapNetworkAdapter(
	adapter: NetworkAdapter,
	permissions?: Permissions,
): NetworkAdapter {
	return {
		httpServerListen: adapter.httpServerListen
			? async (options) => {
					checkPermission(
						permissions?.network,
						{
							op: "listen",
							hostname: options.hostname,
							url: options.hostname
								? `http://${options.hostname}:${options.port ?? 3000}`
								: `http://0.0.0.0:${options.port ?? 3000}`,
							method: "LISTEN",
						},
						(req) => createEaccesError("listen", req.url),
					);
					return adapter.httpServerListen!(options);
				}
			: undefined,
		httpServerClose: adapter.httpServerClose
			? async (serverId) => {
					return adapter.httpServerClose!(serverId);
				}
			: undefined,
		fetch: async (url, options) => {
			checkPermission(
				permissions?.network,
				{ op: "fetch", url, method: options?.method },
				(req) => createEaccesError("connect", req.url),
			);
			return adapter.fetch(url, options);
		},
		dnsLookup: async (hostname) => {
			checkPermission(
				permissions?.network,
				{ op: "dns", hostname },
				(req) => createEaccesError("connect", req.hostname),
			);
			return adapter.dnsLookup(hostname);
		},
		httpRequest: async (url, options) => {
			checkPermission(
				permissions?.network,
				{ op: "http", url, method: options?.method },
				(req) => createEaccesError("connect", req.url),
			);
			return adapter.httpRequest(url, options);
		},
	};
}

/** Wrap a CommandExecutor so spawn passes through the childProcess permission check. */
export function wrapCommandExecutor(
	executor: CommandExecutor,
	permissions?: Permissions,
): CommandExecutor {
	return {
		spawn: (command, args, options) => {
			checkPermission(
				permissions?.childProcess,
				{ command, args, cwd: options.cwd, env: options.env },
				(req) => createEaccesError("spawn", req.command),
			);
			return executor.spawn(command, args, options);
		},
	};
}

export function envAccessAllowed(
	permissions: Permissions | undefined,
	request: EnvAccessRequest,
): void {
	checkPermission(permissions?.env, request, (req) =>
		createEaccesError("access", req.key),
	);
}

/** Create a stub VFS where every operation throws ENOSYS (no filesystem configured). */
export function createFsStub(): VirtualFileSystem {
	const stub = (op: string, path?: string) => {
		throw createEnosysError(op, path);
	};
	return {
		readFile: async (path) => stub("open", path),
		readTextFile: async (path) => stub("open", path),
		readDir: async (path) => stub("scandir", path),
		readDirWithTypes: async (path) => stub("scandir", path),
		writeFile: async (path) => stub("write", path),
		createDir: async (path) => stub("mkdir", path),
		mkdir: async (path) => stub("mkdir", path),
		exists: async (path) => stub("access", path),
		stat: async (path) => stub("stat", path),
		removeFile: async (path) => stub("unlink", path),
		removeDir: async (path) => stub("rmdir", path),
		rename: async (oldPath, newPath) => stub("rename", `${oldPath}->${newPath}`),
		symlink: async (_target, linkPath) => stub("symlink", linkPath),
		readlink: async (path) => stub("readlink", path),
		lstat: async (path) => stub("stat", path),
		link: async (_oldPath, newPath) => stub("link", newPath),
		chmod: async (path) => stub("chmod", path),
		chown: async (path) => stub("chown", path),
		utimes: async (path) => stub("utimes", path),
		truncate: async (path) => stub("open", path),
	};
}

/** Create a stub network adapter where every operation throws ENOSYS. */
export function createNetworkStub(): NetworkAdapter {
	const stub = (op: string, path?: string) => {
		throw createEnosysError(op, path);
	};
	return {
		httpServerListen: async () => stub("listen"),
		httpServerClose: async () => stub("close"),
		fetch: async (url) => stub("connect", url),
		dnsLookup: async (hostname) => stub("connect", hostname),
		httpRequest: async (url) => stub("connect", url),
	};
}

/** Create a stub executor where spawn throws ENOSYS. */
export function createCommandExecutorStub(): CommandExecutor {
	return {
		spawn: () => {
			throw createEnosysError("spawn");
		},
	};
}

/**
 * Filter an env record through the env permission check, returning only
 * allowed key-value pairs. Returns empty object if no permissions configured.
 */
export function filterEnv(
	env: Record<string, string> | undefined,
	permissions?: Permissions,
): Record<string, string> {
	if (!env) return {};
	if (!permissions?.env) return {};
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(env)) {
		const request: EnvAccessRequest = { op: "read", key, value };
		const decision = permissions.env(request);
		if (decision?.allow) {
			result[key] = value;
		}
	}
	return result;
}
