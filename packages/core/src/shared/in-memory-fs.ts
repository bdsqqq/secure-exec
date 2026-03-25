import { InodeTable, type Inode } from "../kernel/inode-table.js";
import type {
	VirtualDirEntry,
	VirtualFileSystem,
	VirtualStat,
} from "../kernel/vfs.js";
import { KernelError, O_CREAT, O_EXCL, O_TRUNC } from "../kernel/types.js";

const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const S_IFSOCK = 0o140000;

function normalizePath(path: string): string {
	if (!path) return "/";
	let normalized = path.startsWith("/") ? path : `/${path}`;
	normalized = normalized.replace(/\/+/g, "/");
	if (normalized.length > 1 && normalized.endsWith("/")) {
		normalized = normalized.slice(0, -1);
	}
	return normalized;
}

function splitPath(path: string): string[] {
	const normalized = normalizePath(path);
	return normalized === "/" ? [] : normalized.slice(1).split("/");
}

function dirname(path: string): string {
	const parts = splitPath(path);
	if (parts.length <= 1) return "/";
	return `/${parts.slice(0, -1).join("/")}`;
}

/**
 * A fully in-memory VirtualFileSystem backed by inode-aware Maps.
 * Used as the default filesystem for the browser sandbox and for tests.
 * Paths are always POSIX-style (forward slashes, rooted at "/").
 */
export class InMemoryFileSystem implements VirtualFileSystem {
	private inodeTable: InodeTable;
	private files = new Map<string, number>();
	private fileContents = new Map<number, Uint8Array>();
	private dirs = new Map<string, number>();
	private symlinks = new Map<string, string>();

	constructor(inodeTable: InodeTable = new InodeTable()) {
		this.inodeTable = inodeTable;
		this.dirs.set("/", this.allocateDirectoryInode().ino);
	}

	// Rebind the filesystem to the kernel's shared inode table.
	setInodeTable(inodeTable: InodeTable): void {
		if (this.inodeTable === inodeTable) return;
		const oldTable = this.inodeTable;
		this.inodeTable = inodeTable;
		this.reindexInodes(oldTable);
	}

	getInodeForPath(path: string): number | null {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		return this.files.get(resolved) ?? this.dirs.get(resolved) ?? null;
	}

	readFileByInode(ino: number): Uint8Array {
		const data = this.fileContents.get(ino);
		if (!data) {
			throw new Error(`ENOENT: inode ${ino} has no file data`);
		}
		this.requireInode(ino).atime = new Date();
		return data;
	}

	writeFileByInode(ino: number, content: Uint8Array): void {
		this.requireFileInode(ino);
		this.fileContents.set(ino, content);
		this.updateFileMetadata(ino, content.byteLength);
	}

	preadByInode(ino: number, offset: number, length: number): Uint8Array {
		const data = this.readFileByInode(ino);
		return data.slice(offset, offset + length);
	}

	statByInode(ino: number): VirtualStat {
		return this.statForInode(this.requireInode(ino));
	}

	deleteInodeData(ino: number): void {
		this.fileContents.delete(ino);
	}

	private listDirEntries(path: string): VirtualDirEntry[] {
		const normalized = normalizePath(path);
		const dirIno = this.dirs.get(normalized);
		if (dirIno === undefined) {
			throw new Error(
				`ENOENT: no such file or directory, scandir '${normalized}'`,
			);
		}

		const prefix = normalized === "/" ? "/" : `${normalized}/`;
		const entries = new Map<string, VirtualDirEntry>();
		const parentPath = normalized === "/" ? "/" : dirname(normalized);
		const parentIno = this.dirs.get(parentPath) ?? dirIno;

		entries.set(".", {
			name: ".",
			isDirectory: true,
			isSymbolicLink: false,
			ino: dirIno,
		});
		entries.set("..", {
			name: "..",
			isDirectory: true,
			isSymbolicLink: false,
			ino: parentIno,
		});

		for (const [filePath, ino] of this.files.entries()) {
			if (!filePath.startsWith(prefix)) continue;
			const rest = filePath.slice(prefix.length);
			if (rest && !rest.includes("/")) {
				entries.set(rest, {
					name: rest,
					isDirectory: false,
					isSymbolicLink: false,
					ino,
				});
			}
		}

		for (const [dirPath, ino] of this.dirs.entries()) {
			if (!dirPath.startsWith(prefix)) continue;
			const rest = dirPath.slice(prefix.length);
			if (rest && !rest.includes("/")) {
				entries.set(rest, {
					name: rest,
					isDirectory: true,
					isSymbolicLink: false,
					ino,
				});
			}
		}

		for (const linkPath of this.symlinks.keys()) {
			if (!linkPath.startsWith(prefix)) continue;
			const rest = linkPath.slice(prefix.length);
			if (rest && !rest.includes("/")) {
				entries.set(rest, {
					name: rest,
					isDirectory: false,
					isSymbolicLink: true,
					ino: 0,
				});
			}
		}

		return Array.from(entries.values());
	}

	async readFile(path: string): Promise<Uint8Array> {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		const ino = this.files.get(resolved);
		if (ino === undefined) {
			throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
		}
		return this.readFileByInode(ino);
	}

	async readTextFile(path: string): Promise<string> {
		const data = await this.readFile(path);
		return new TextDecoder().decode(data);
	}

	async readDir(path: string): Promise<string[]> {
		return this.listDirEntries(path).map((entry) => entry.name);
	}

	async readDirWithTypes(path: string): Promise<VirtualDirEntry[]> {
		return this.listDirEntries(path);
	}

	async writeFile(path: string, content: string | Uint8Array): Promise<void> {
		const normalized = normalizePath(path);
		await this.mkdir(dirname(normalized));
		const data =
			typeof content === "string" ? new TextEncoder().encode(content) : content;

		const resolved = this.resolveIfSymlink(normalized) ?? normalized;
		const existing = this.files.get(resolved);
		if (existing !== undefined) {
			this.writeFileByInode(existing, data);
			return;
		}

		const inode = this.allocateFileInode();
		this.files.set(resolved, inode.ino);
		this.fileContents.set(inode.ino, data);
		this.updateFileMetadata(inode.ino, data.byteLength);
	}

	prepareOpenSync(path: string, flags: number): boolean {
		const normalized = normalizePath(path);
		const resolved = this.resolveIfSymlink(normalized) ?? normalized;
		const hasCreate = (flags & O_CREAT) !== 0;
		const hasExcl = (flags & O_EXCL) !== 0;
		const hasTrunc = (flags & O_TRUNC) !== 0;
		const fileIno = this.files.get(resolved);
		const exists = fileIno !== undefined || this.dirs.has(resolved) || this.symlinks.has(normalized);

		if (hasCreate && hasExcl && exists) {
			throw new KernelError("EEXIST", `file already exists, open '${normalized}'`);
		}

		let created = false;
		if (fileIno === undefined && hasCreate) {
			const parts = splitPath(dirname(resolved));
			let current = "";
			for (const part of parts) {
				current += `/${part}`;
				if (!this.dirs.has(current)) {
					this.dirs.set(current, this.allocateDirectoryInode().ino);
				}
			}

			const inode = this.allocateFileInode();
			this.files.set(resolved, inode.ino);
			this.fileContents.set(inode.ino, new Uint8Array(0));
			this.updateFileMetadata(inode.ino, 0);
			created = true;
		}

		if (hasTrunc) {
			if (this.dirs.has(resolved)) {
				throw new KernelError("EISDIR", `illegal operation on a directory, open '${normalized}'`);
			}
			const truncateIno = this.files.get(resolved);
			if (truncateIno === undefined) {
				throw new KernelError("ENOENT", `no such file or directory, open '${normalized}'`);
			}
			this.fileContents.set(truncateIno, new Uint8Array(0));
			this.updateFileMetadata(truncateIno, 0);
		}

		return created;
	}

	async createDir(path: string): Promise<void> {
		const normalized = normalizePath(path);
		const parent = dirname(normalized);
		if (!this.dirs.has(parent)) {
			throw new Error(`ENOENT: no such file or directory, mkdir '${normalized}'`);
		}
		if (!this.dirs.has(normalized)) {
			this.dirs.set(normalized, this.allocateDirectoryInode().ino);
		}
	}

	async mkdir(path: string, _options?: { recursive?: boolean }): Promise<void> {
		const parts = splitPath(path);
		let current = "";
		for (const part of parts) {
			current += `/${part}`;
			if (!this.dirs.has(current)) {
				this.dirs.set(current, this.allocateDirectoryInode().ino);
			}
		}
	}

	private resolveIfSymlink(normalized: string): string | null {
		return this.symlinks.has(normalized) ? this.resolveSymlink(normalized) : null;
	}

	private resolveSymlink(normalized: string, maxDepth = 16): string {
		let current = normalized;
		for (let i = 0; i < maxDepth; i++) {
			const target = this.symlinks.get(current);
			if (!target) return current;
			current = target.startsWith("/")
				? normalizePath(target)
				: normalizePath(`${dirname(current)}/${target}`);
		}
		throw new Error(
			`ELOOP: too many levels of symbolic links, stat '${normalized}'`,
		);
	}

	private statForInode(inode: Inode): VirtualStat {
		const isDirectory = (inode.mode & 0o170000) === S_IFDIR;
		return {
			mode: inode.mode,
			size: isDirectory ? 4096 : inode.size,
			isDirectory,
			isSymbolicLink: false,
			atimeMs: inode.atime.getTime(),
			mtimeMs: inode.mtime.getTime(),
			ctimeMs: inode.ctime.getTime(),
			birthtimeMs: inode.birthtime.getTime(),
			ino: inode.ino,
			nlink: inode.nlink,
			uid: inode.uid,
			gid: inode.gid,
		};
	}

	private statEntry(normalized: string): VirtualStat {
		const fileIno = this.files.get(normalized);
		if (fileIno !== undefined) {
			return this.statByInode(fileIno);
		}

		const dirIno = this.dirs.get(normalized);
		if (dirIno !== undefined) {
			return this.statByInode(dirIno);
		}

		throw new Error(`ENOENT: no such file or directory, stat '${normalized}'`);
	}

	async exists(path: string): Promise<boolean> {
		const normalized = normalizePath(path);
		if (this.symlinks.has(normalized)) {
			try {
				const resolved = this.resolveSymlink(normalized);
				return this.files.has(resolved) || this.dirs.has(resolved);
			} catch {
				return false;
			}
		}
		return this.files.has(normalized) || this.dirs.has(normalized);
	}

	async stat(path: string): Promise<VirtualStat> {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		return this.statEntry(resolved);
	}

	async removeFile(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (this.symlinks.delete(normalized)) {
			return;
		}
		const resolved = this.resolveSymlink(normalized);
		const ino = this.files.get(resolved);
		if (ino === undefined) {
			throw new Error(`ENOENT: no such file or directory, unlink '${normalized}'`);
		}

		this.files.delete(resolved);
		this.inodeTable.decrementLinks(ino);
		if (this.inodeTable.shouldDelete(ino)) {
			this.deleteInodeData(ino);
			this.inodeTable.delete(ino);
		}
	}

	async removeDir(path: string): Promise<void> {
		const normalized = normalizePath(path);
		if (normalized === "/") {
			throw new Error("EPERM: operation not permitted, rmdir '/'");
		}
		if (!this.dirs.has(normalized)) {
			throw new Error(`ENOENT: no such file or directory, rmdir '${normalized}'`);
		}
		const prefix = normalized.endsWith("/") ? normalized : `${normalized}/`;
		for (const filePath of this.files.keys()) {
			if (filePath.startsWith(prefix)) {
				throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalized}'`);
			}
		}
		for (const dirPath of this.dirs.keys()) {
			if (dirPath !== normalized && dirPath.startsWith(prefix)) {
				throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalized}'`);
			}
		}
		for (const linkPath of this.symlinks.keys()) {
			if (linkPath.startsWith(prefix)) {
				throw new Error(`ENOTEMPTY: directory not empty, rmdir '${normalized}'`);
			}
		}

		const ino = this.dirs.get(normalized)!;
		this.dirs.delete(normalized);
		this.inodeTable.decrementLinks(ino);
		if (this.inodeTable.shouldDelete(ino)) {
			this.inodeTable.delete(ino);
		}
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		if (oldNormalized === newNormalized) {
			return;
		}

		if (!this.dirs.has(dirname(newNormalized))) {
			throw new Error(
				`ENOENT: no such file or directory, rename '${oldNormalized}' -> '${newNormalized}'`,
			);
		}

		if (this.files.has(oldNormalized)) {
			if (this.dirs.has(newNormalized)) {
				throw new Error(
					`EISDIR: illegal operation on a directory, rename '${oldNormalized}' -> '${newNormalized}'`,
				);
			}
			if (this.files.has(newNormalized) || this.symlinks.has(newNormalized)) {
				throw new Error(
					`EEXIST: file already exists, rename '${oldNormalized}' -> '${newNormalized}'`,
				);
			}
			const ino = this.files.get(oldNormalized)!;
			this.files.delete(oldNormalized);
			this.files.set(newNormalized, ino);
			return;
		}

		if (this.symlinks.has(oldNormalized)) {
			if (
				this.files.has(newNormalized) ||
				this.dirs.has(newNormalized) ||
				this.symlinks.has(newNormalized)
			) {
				throw new Error(
					`EEXIST: file already exists, rename '${oldNormalized}' -> '${newNormalized}'`,
				);
			}
			const target = this.symlinks.get(oldNormalized)!;
			this.symlinks.delete(oldNormalized);
			this.symlinks.set(newNormalized, target);
			return;
		}

		if (!this.dirs.has(oldNormalized)) {
			throw new Error(
				`ENOENT: no such file or directory, rename '${oldNormalized}' -> '${newNormalized}'`,
			);
		}
		if (oldNormalized === "/") {
			throw new Error(
				`EPERM: operation not permitted, rename '${oldNormalized}'`,
			);
		}
		if (newNormalized.startsWith(`${oldNormalized}/`)) {
			throw new Error(
				`EINVAL: invalid argument, rename '${oldNormalized}' -> '${newNormalized}'`,
			);
		}
		if (
			this.dirs.has(newNormalized) ||
			this.files.has(newNormalized) ||
			this.symlinks.has(newNormalized)
		) {
			throw new Error(
				`EEXIST: file already exists, rename '${oldNormalized}' -> '${newNormalized}'`,
			);
		}

		const sourcePrefix = `${oldNormalized}/`;
		const targetPrefix = `${newNormalized}/`;
		const dirEntries = Array.from(this.dirs.entries())
			.filter(([path]) => path === oldNormalized || path.startsWith(sourcePrefix))
			.sort(([a], [b]) => a.length - b.length);
		const fileEntries = Array.from(this.files.entries()).filter(([path]) =>
			path.startsWith(sourcePrefix),
		);
		const symlinkEntries = Array.from(this.symlinks.entries()).filter(([path]) =>
			path.startsWith(sourcePrefix),
		);

		for (const [path] of dirEntries) this.dirs.delete(path);
		for (const [path] of fileEntries) this.files.delete(path);
		for (const [path] of symlinkEntries) this.symlinks.delete(path);

		for (const [path, ino] of dirEntries) {
			const nextPath = path === oldNormalized
				? newNormalized
				: `${targetPrefix}${path.slice(sourcePrefix.length)}`;
			this.dirs.set(nextPath, ino);
		}
		for (const [path, ino] of fileEntries) {
			this.files.set(
				`${targetPrefix}${path.slice(sourcePrefix.length)}`,
				ino,
			);
		}
		for (const [path, target] of symlinkEntries) {
			this.symlinks.set(
				`${targetPrefix}${path.slice(sourcePrefix.length)}`,
				target,
			);
		}
	}

	async symlink(target: string, linkPath: string): Promise<void> {
		const normalized = normalizePath(linkPath);
		if (
			this.files.has(normalized) ||
			this.dirs.has(normalized) ||
			this.symlinks.has(normalized)
		) {
			throw new Error(
				`EEXIST: file already exists, symlink '${target}' -> '${normalized}'`,
			);
		}
		await this.mkdir(dirname(normalized));
		this.symlinks.set(normalized, target);
	}

	async readlink(path: string): Promise<string> {
		const normalized = normalizePath(path);
		const target = this.symlinks.get(normalized);
		if (target === undefined) {
			throw new Error(`EINVAL: invalid argument, readlink '${normalized}'`);
		}
		return target;
	}

	async lstat(path: string): Promise<VirtualStat> {
		const normalized = normalizePath(path);
		const target = this.symlinks.get(normalized);
		if (target !== undefined) {
			const now = Date.now();
			return {
				mode: S_IFLNK | 0o777,
				size: new TextEncoder().encode(target).byteLength,
				isDirectory: false,
				isSymbolicLink: true,
				atimeMs: now,
				mtimeMs: now,
				ctimeMs: now,
				birthtimeMs: now,
				ino: 0,
				nlink: 1,
				uid: 0,
				gid: 0,
			};
		}
		return this.statEntry(normalized);
	}

	async link(oldPath: string, newPath: string): Promise<void> {
		const oldNormalized = normalizePath(oldPath);
		const newNormalized = normalizePath(newPath);
		const resolved = this.resolveSymlink(oldNormalized);
		const ino = this.files.get(resolved);
		if (ino === undefined) {
			throw new Error(
				`ENOENT: no such file or directory, link '${oldNormalized}' -> '${newNormalized}'`,
			);
		}
		if (
			this.files.has(newNormalized) ||
			this.dirs.has(newNormalized) ||
			this.symlinks.has(newNormalized)
		) {
			throw new Error(
				`EEXIST: file already exists, link '${oldNormalized}' -> '${newNormalized}'`,
			);
		}
		await this.mkdir(dirname(newNormalized));
		this.files.set(newNormalized, ino);
		this.inodeTable.incrementLinks(ino);
	}

	async chmod(path: string, mode: number): Promise<void> {
		const inode = this.requirePathInode(path, "chmod");
		const callerTypeBits = mode & 0o170000;
		if (callerTypeBits !== 0) {
			inode.mode = mode;
		} else {
			const existingTypeBits = inode.mode & 0o170000;
			inode.mode = existingTypeBits | (mode & 0o7777);
		}
		inode.ctime = new Date();
	}

	async chown(path: string, uid: number, gid: number): Promise<void> {
		const inode = this.requirePathInode(path, "chown");
		inode.uid = uid;
		inode.gid = gid;
		inode.ctime = new Date();
	}

	async utimes(path: string, atime: number, mtime: number): Promise<void> {
		const inode = this.requirePathInode(path, "utimes");
		inode.atime = new Date(atime * 1000);
		inode.mtime = new Date(mtime * 1000);
		inode.ctime = new Date();
	}

	async realpath(path: string): Promise<string> {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		if (!this.files.has(resolved) && !this.dirs.has(resolved)) {
			throw new Error(`ENOENT: no such file or directory, realpath '${normalized}'`);
		}
		return resolved;
	}

	async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		const ino = this.files.get(resolved);
		if (ino === undefined) {
			throw new Error(`ENOENT: no such file or directory, open '${normalized}'`);
		}
		return this.preadByInode(ino, offset, length);
	}

	async truncate(path: string, length: number): Promise<void> {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		const ino = this.files.get(resolved);
		if (ino === undefined) {
			throw new Error(`ENOENT: no such file or directory, truncate '${normalized}'`);
		}

		const file = this.readFileByInode(ino);
		const next = length >= file.byteLength
			? (() => {
				const padded = new Uint8Array(length);
				padded.set(file);
				return padded;
			})()
			: file.slice(0, length);
		this.fileContents.set(ino, next);
		this.updateFileMetadata(ino, next.byteLength);
	}

	private reindexInodes(oldTable: InodeTable): void {
		const oldContents = new Map(this.fileContents);
		const oldFiles = new Map(this.files);
		const oldDirs = Array.from(this.dirs.entries()).sort(([a], [b]) => a.length - b.length);
		const inoMap = new Map<number, number>();

		this.files = new Map();
		this.fileContents = new Map();
		this.dirs = new Map();

		for (const [dirPath, oldIno] of oldDirs) {
			const ino = this.cloneInode(oldIno, oldTable, S_IFDIR | 0o755).ino;
			this.dirs.set(dirPath, ino);
		}

		if (!this.dirs.has("/")) {
			this.dirs.set("/", this.allocateDirectoryInode().ino);
		}

		for (const [path, oldIno] of oldFiles) {
			const mapped = inoMap.get(oldIno) ?? (() => {
				const inode = this.cloneInode(oldIno, oldTable, S_IFREG | 0o644);
				inoMap.set(oldIno, inode.ino);
				return inode.ino;
			})();
			this.files.set(path, mapped);
			const content = oldContents.get(oldIno);
			if (content) {
				this.fileContents.set(mapped, content);
				this.requireInode(mapped).size = content.byteLength;
			}
		}
	}

	private cloneInode(
		oldIno: number,
		oldTable: InodeTable,
		fallbackMode: number,
	): Inode {
		const source = oldTable.get(oldIno);
		const inode = this.inodeTable.allocate(
			source?.mode ?? fallbackMode,
			source?.uid ?? 0,
			source?.gid ?? 0,
		);
		inode.nlink = source?.nlink ?? 1;
		inode.openRefCount = 0;
		inode.size = source?.size ?? 0;
		inode.atime = source?.atime ? new Date(source.atime) : new Date();
		inode.mtime = source?.mtime ? new Date(source.mtime) : new Date();
		inode.ctime = source?.ctime ? new Date(source.ctime) : new Date();
		inode.birthtime = source?.birthtime ? new Date(source.birthtime) : new Date();
		return inode;
	}

	private allocateFileInode(): Inode {
		return this.inodeTable.allocate(S_IFREG | 0o644, 0, 0);
	}

	private allocateDirectoryInode(): Inode {
		const inode = this.inodeTable.allocate(S_IFDIR | 0o755, 0, 0);
		inode.size = 4096;
		return inode;
	}

	private updateFileMetadata(ino: number, size: number): void {
		const inode = this.requireFileInode(ino);
		const now = new Date();
		inode.size = size;
		inode.atime = now;
		inode.mtime = now;
		inode.ctime = now;
	}

	private requirePathInode(path: string, op: string): Inode {
		const normalized = normalizePath(path);
		const resolved = this.resolveSymlink(normalized);
		const ino = this.files.get(resolved) ?? this.dirs.get(resolved);
		if (ino === undefined) {
			throw new Error(`ENOENT: no such file or directory, ${op} '${normalized}'`);
		}
		return this.requireInode(ino);
	}

	private requireFileInode(ino: number): Inode {
		const inode = this.requireInode(ino);
		if ((inode.mode & 0o170000) !== S_IFREG && (inode.mode & 0o170000) !== S_IFSOCK) {
			throw new Error(`EINVAL: inode ${ino} is not a regular file`);
		}
		return inode;
	}

	private requireInode(ino: number): Inode {
		const inode = this.inodeTable.get(ino);
		if (!inode) {
			throw new Error(`ENOENT: inode ${ino} not found`);
		}
		return inode;
	}
}

export function createInMemoryFileSystem(): InMemoryFileSystem {
	return new InMemoryFileSystem();
}
