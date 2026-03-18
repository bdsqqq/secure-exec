/**
 * Permission enforcement layer.
 *
 * Deny-by-default access control. Wraps VFS and other kernel operations
 * with permission checks that throw on denial.
 */

import type {
	Permissions,
	FsAccessRequest,
	EnvAccessRequest,
	PermissionDecision,
} from "./types.js";
import { KernelError } from "./types.js";
import type { VirtualFileSystem } from "./vfs.js";

function checkPermission<T>(
	check: ((request: T) => PermissionDecision) | undefined,
	request: T,
	errorFactory: (request: T, reason?: string) => Error,
): void {
	if (!check) throw errorFactory(request);
	const decision = check(request);
	if (!decision?.allow) throw errorFactory(request, decision?.reason);
}

function fsError(op: string, path?: string, reason?: string): KernelError {
	const msg = reason
		? `permission denied, ${op} '${path ?? ""}': ${reason}`
		: `permission denied, ${op} '${path ?? ""}'`;
	return new KernelError("EACCES", msg);
}

/**
 * Wrap a VFS with permission checks on every operation.
 */
export function wrapFileSystem(
	fs: VirtualFileSystem,
	permissions?: Permissions,
): VirtualFileSystem {
	const check = (op: FsAccessRequest["op"], path: string) => {
		checkPermission(permissions?.fs, { op, path }, (req, reason) =>
			fsError(op, req.path, reason),
		);
	};

	return {
		readFile: async (path) => { check("read", path); return fs.readFile(path); },
		readTextFile: async (path) => { check("read", path); return fs.readTextFile(path); },
		readDir: async (path) => { check("readdir", path); return fs.readDir(path); },
		readDirWithTypes: async (path) => { check("readdir", path); return fs.readDirWithTypes(path); },
		writeFile: async (path, content) => { check("write", path); return fs.writeFile(path, content); },
		createDir: async (path) => { check("createDir", path); return fs.createDir(path); },
		mkdir: async (path, options?) => { check("mkdir", path); return fs.mkdir(path, options); },
		exists: async (path) => { check("exists", path); return fs.exists(path); },
		stat: async (path) => { check("stat", path); return fs.stat(path); },
		removeFile: async (path) => { check("rm", path); return fs.removeFile(path); },
		removeDir: async (path) => { check("rm", path); return fs.removeDir(path); },
		rename: async (oldPath, newPath) => {
			check("rename", oldPath);
			check("rename", newPath);
			return fs.rename(oldPath, newPath);
		},
		realpath: async (path) => { check("read", path); return fs.realpath(path); },
		symlink: async (target, linkPath) => { check("symlink", linkPath); return fs.symlink(target, linkPath); },
		readlink: async (path) => { check("readlink", path); return fs.readlink(path); },
		lstat: async (path) => { check("stat", path); return fs.lstat(path); },
		link: async (oldPath, newPath) => { check("link", newPath); return fs.link(oldPath, newPath); },
		chmod: async (path, mode) => { check("chmod", path); return fs.chmod(path, mode); },
		chown: async (path, uid, gid) => { check("chown", path); return fs.chown(path, uid, gid); },
		utimes: async (path, atime, mtime) => { check("utimes", path); return fs.utimes(path, atime, mtime); },
		truncate: async (path, length) => { check("truncate", path); return fs.truncate(path, length); },
		pread: async (path, offset, length) => { check("read", path); return fs.pread(path, offset, length); },
	};
}

/**
 * Filter an env record through the env permission check.
 * Returns only allowed key-value pairs.
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

/**
 * Check childProcess permission before spawning.
 * No-op when no permissions or no childProcess check is configured.
 */
export function checkChildProcess(
	permissions: Permissions | undefined,
	command: string,
	args: string[],
	cwd?: string,
): void {
	if (!permissions?.childProcess) return;
	const request = { command, args, cwd };
	const decision = permissions.childProcess(request);
	if (!decision?.allow) {
		const msg = decision?.reason
			? `permission denied, spawn '${command}': ${decision.reason}`
			: `permission denied, spawn '${command}'`;
		throw new KernelError("EACCES", msg);
	}
}

// Permission presets
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
