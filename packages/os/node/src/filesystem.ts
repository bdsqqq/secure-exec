/**
 * Node.js filesystem adapter.
 *
 * Implements VirtualFileSystem by delegating to node:fs/promises.
 * When the kernel uses a NodeFileSystem, file operations go to the
 * real host filesystem (sandboxed by permissions).
 */

import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { VirtualFileSystem, VirtualStat, VirtualDirEntry } from "@secure-exec/kernel";

export interface NodeFileSystemOptions {
	/** Root directory on the host — all paths are relative to this. */
	root?: string;
}

export class NodeFileSystem implements VirtualFileSystem {
	private root: string;

	constructor(options?: NodeFileSystemOptions) {
		this.root = options?.root ?? "/";
	}

	private resolve(p: string): string {
		// Map virtual path to host path under root
		const normalized = path.posix.normalize(p);
		return path.join(this.root, normalized);
	}

	async readFile(p: string): Promise<Uint8Array> {
		return new Uint8Array(await fs.readFile(this.resolve(p)));
	}

	async readTextFile(p: string): Promise<string> {
		return fs.readFile(this.resolve(p), "utf-8");
	}

	async readDir(p: string): Promise<string[]> {
		return fs.readdir(this.resolve(p));
	}

	async readDirWithTypes(p: string): Promise<VirtualDirEntry[]> {
		const entries = await fs.readdir(this.resolve(p), {
			withFileTypes: true,
		});
		return entries.map((e) => ({
			name: e.name,
			isDirectory: e.isDirectory(),
			isSymbolicLink: e.isSymbolicLink(),
		}));
	}

	async writeFile(p: string, content: string | Uint8Array): Promise<void> {
		const hostPath = this.resolve(p);
		await fs.mkdir(path.dirname(hostPath), { recursive: true });
		await fs.writeFile(hostPath, content);
	}

	async createDir(p: string): Promise<void> {
		await fs.mkdir(this.resolve(p));
	}

	async mkdir(p: string, options?: { recursive?: boolean }): Promise<void> {
		await fs.mkdir(this.resolve(p), { recursive: options?.recursive ?? true });
	}

	async exists(p: string): Promise<boolean> {
		try {
			await fs.access(this.resolve(p));
			return true;
		} catch {
			return false;
		}
	}

	async stat(p: string): Promise<VirtualStat> {
		const s = await fs.stat(this.resolve(p));
		return toVirtualStat(s);
	}

	async removeFile(p: string): Promise<void> {
		await fs.unlink(this.resolve(p));
	}

	async removeDir(p: string): Promise<void> {
		await fs.rmdir(this.resolve(p));
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		await fs.rename(this.resolve(oldPath), this.resolve(newPath));
	}

	async realpath(p: string): Promise<string> {
		return fs.realpath(this.resolve(p));
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		await fs.symlink(target, this.resolve(linkPath));
	}

	async readlink(p: string): Promise<string> {
		return fs.readlink(this.resolve(p));
	}

	async lstat(p: string): Promise<VirtualStat> {
		const s = await fs.lstat(this.resolve(p));
		return toVirtualStat(s);
	}

	async link(oldPath: string, newPath: string): Promise<void> {
		await fs.link(this.resolve(oldPath), this.resolve(newPath));
	}

	async chmod(p: string, mode: number): Promise<void> {
		await fs.chmod(this.resolve(p), mode);
	}

	async chown(p: string, uid: number, gid: number): Promise<void> {
		await fs.chown(this.resolve(p), uid, gid);
	}

	async utimes(p: string, atime: number, mtime: number): Promise<void> {
		await fs.utimes(this.resolve(p), atime / 1000, mtime / 1000);
	}

	async truncate(p: string, length: number): Promise<void> {
		await fs.truncate(this.resolve(p), length);
	}

	async pread(p: string, offset: number, length: number): Promise<Uint8Array> {
		const handle = await fs.open(this.resolve(p), "r");
		try {
			const buf = new Uint8Array(length);
			const { bytesRead } = await handle.read(buf, 0, length, offset);
			return bytesRead < length ? buf.slice(0, bytesRead) : buf;
		} finally {
			await handle.close();
		}
	}
}

function toVirtualStat(s: import("node:fs").Stats): VirtualStat {
	return {
		mode: s.mode,
		size: s.size,
		isDirectory: s.isDirectory(),
		isSymbolicLink: s.isSymbolicLink(),
		atimeMs: s.atimeMs,
		mtimeMs: s.mtimeMs,
		ctimeMs: s.ctimeMs,
		birthtimeMs: s.birthtimeMs,
		ino: s.ino,
		nlink: s.nlink,
		uid: s.uid,
		gid: s.gid,
	};
}
