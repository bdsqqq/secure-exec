/**
 * Inode table with refcounting and deferred unlink.
 *
 * Provides a POSIX-style inode layer: hard link counts (nlink),
 * open FD reference counting (openRefCount), and deferred deletion
 * when nlink reaches 0 but FDs are still open.
 */

import { KernelError } from "./types.js";

export interface Inode {
	readonly ino: number;
	nlink: number;
	openRefCount: number;
	mode: number;
	uid: number;
	gid: number;
	size: number;
	atime: Date;
	mtime: Date;
	ctime: Date;
	birthtime: Date;
}

export class InodeTable {
	private inodes: Map<number, Inode> = new Map();
	private nextIno = 1;

	/** Allocate a new inode with the given mode, uid, gid. Returns the inode. */
	allocate(mode: number, uid: number, gid: number): Inode {
		const now = new Date();
		const inode: Inode = {
			ino: this.nextIno++,
			nlink: 1,
			openRefCount: 0,
			mode,
			uid,
			gid,
			size: 0,
			atime: now,
			mtime: now,
			ctime: now,
			birthtime: now,
		};
		this.inodes.set(inode.ino, inode);
		return inode;
	}

	/** Look up an inode by number. */
	get(ino: number): Inode | null {
		return this.inodes.get(ino) ?? null;
	}

	/** Increment hard link count (new directory entry pointing to this inode). */
	incrementLinks(ino: number): void {
		const inode = this.requireInode(ino);
		inode.nlink++;
		inode.ctime = new Date();
	}

	/** Decrement hard link count (directory entry removed). */
	decrementLinks(ino: number): void {
		const inode = this.requireInode(ino);
		if (inode.nlink <= 0) {
			throw new KernelError("EINVAL", `inode ${ino} nlink already 0`);
		}
		inode.nlink--;
		inode.ctime = new Date();
	}

	/** Increment open FD reference count. */
	incrementOpenRefs(ino: number): void {
		const inode = this.requireInode(ino);
		inode.openRefCount++;
	}

	/** Decrement open FD reference count. */
	decrementOpenRefs(ino: number): void {
		const inode = this.requireInode(ino);
		if (inode.openRefCount <= 0) {
			throw new KernelError("EINVAL", `inode ${ino} openRefCount already 0`);
		}
		inode.openRefCount--;
	}

	/** True when nlink=0 AND openRefCount=0 — inode data can be freed. */
	shouldDelete(ino: number): boolean {
		const inode = this.inodes.get(ino);
		if (!inode) return false;
		return inode.nlink === 0 && inode.openRefCount === 0;
	}

	/** Remove the inode from the table. Called after shouldDelete returns true. */
	delete(ino: number): void {
		this.inodes.delete(ino);
	}

	/** Number of inodes in the table. */
	get size(): number {
		return this.inodes.size;
	}

	private requireInode(ino: number): Inode {
		const inode = this.inodes.get(ino);
		if (!inode) {
			throw new KernelError("ENOENT", `inode ${ino} not found`);
		}
		return inode;
	}
}
