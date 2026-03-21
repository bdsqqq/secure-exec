import type { VirtualFileSystem } from "secure-exec";
import {
	S3Client,
	GetObjectCommand,
	PutObjectCommand,
	DeleteObjectCommand,
	HeadObjectCommand,
	ListObjectsV2Command,
	CopyObjectCommand,
} from "@aws-sdk/client-s3";

type VirtualStat = Awaited<ReturnType<VirtualFileSystem["stat"]>>;

export interface S3FileSystemOptions {
	client: S3Client;
	bucket: string;
}

/**
 * A VirtualFileSystem backed by S3 (or any S3-compatible store like MinIO).
 *
 * Files are stored as objects keyed by their path (without leading slash).
 * Directories are inferred from key prefixes; mkdir creates empty marker objects.
 * Symlinks and hard links are not supported (ENOSYS).
 */
export class S3FileSystem implements VirtualFileSystem {
	private client: S3Client;
	private bucket: string;

	constructor(options: S3FileSystemOptions) {
		this.client = options.client;
		this.bucket = options.bucket;
	}

	/** Convert VFS path to S3 key: strip leading slash. */
	private toKey(path: string): string {
		return path.replace(/^\/+/, "").replace(/\/+/g, "/");
	}

	/** Convert VFS path to S3 directory prefix (trailing slash). */
	private dirPrefix(path: string): string {
		const key = this.toKey(path);
		return key === "" ? "" : key.endsWith("/") ? key : key + "/";
	}

	async readFile(path: string): Promise<Uint8Array> {
		try {
			const response = await this.client.send(
				new GetObjectCommand({ Bucket: this.bucket, Key: this.toKey(path) }),
			);
			return await response.Body!.transformToByteArray();
		} catch (err: unknown) {
			if (isNotFound(err)) {
				throw new Error(
					`ENOENT: no such file or directory, open '${path}'`,
				);
			}
			throw err;
		}
	}

	async readTextFile(path: string): Promise<string> {
		const bytes = await this.readFile(path);
		return new TextDecoder().decode(bytes);
	}

	async readDir(path: string): Promise<string[]> {
		const prefix = this.dirPrefix(path);
		const entries: string[] = [];
		let token: string | undefined;

		do {
			const res = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					Delimiter: "/",
					ContinuationToken: token,
				}),
			);

			for (const obj of res.Contents ?? []) {
				const name = obj.Key!.slice(prefix.length);
				if (name && !name.includes("/")) entries.push(name);
			}
			for (const cp of res.CommonPrefixes ?? []) {
				const name = cp.Prefix!.slice(prefix.length).replace(/\/$/, "");
				if (name) entries.push(name);
			}

			token = res.NextContinuationToken;
		} while (token);

		// If empty, verify the directory actually exists
		if (entries.length === 0) {
			const check = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					MaxKeys: 1,
				}),
			);
			if (!check.Contents?.length && !check.CommonPrefixes?.length) {
				throw new Error(
					`ENOENT: no such file or directory, scandir '${path}'`,
				);
			}
		}

		return entries;
	}

	async readDirWithTypes(
		path: string,
	): Promise<Array<{ name: string; isDirectory: boolean }>> {
		const prefix = this.dirPrefix(path);
		const entries: Array<{ name: string; isDirectory: boolean }> = [];
		let token: string | undefined;

		do {
			const res = await this.client.send(
				new ListObjectsV2Command({
					Bucket: this.bucket,
					Prefix: prefix,
					Delimiter: "/",
					ContinuationToken: token,
				}),
			);

			for (const obj of res.Contents ?? []) {
				const name = obj.Key!.slice(prefix.length);
				if (name && !name.includes("/"))
					entries.push({ name, isDirectory: false });
			}
			for (const cp of res.CommonPrefixes ?? []) {
				const name = cp.Prefix!.slice(prefix.length).replace(/\/$/, "");
				if (name) entries.push({ name, isDirectory: true });
			}

			token = res.NextContinuationToken;
		} while (token);

		return entries;
	}

	async writeFile(
		path: string,
		content: string | Uint8Array,
	): Promise<void> {
		const body =
			typeof content === "string"
				? new TextEncoder().encode(content)
				: content;
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: this.toKey(path),
				Body: body,
			}),
		);
	}

	async createDir(path: string): Promise<void> {
		// Verify parent exists
		const parent = path.replace(/\/[^/]+\/?$/, "") || "/";
		if (parent !== "/" && parent !== path) {
			if (!(await this.exists(parent)))
				throw new Error(
					`ENOENT: no such file or directory, mkdir '${path}'`,
				);
		}
		await this.client.send(
			new PutObjectCommand({
				Bucket: this.bucket,
				Key: this.dirPrefix(path),
				Body: new Uint8Array(0),
			}),
		);
	}

	async mkdir(path: string): Promise<void> {
		const parts = this.toKey(path).split("/").filter(Boolean);
		let current = "";
		for (const part of parts) {
			current += part + "/";
			await this.client.send(
				new PutObjectCommand({
					Bucket: this.bucket,
					Key: current,
					Body: new Uint8Array(0),
				}),
			);
		}
	}

	async exists(path: string): Promise<boolean> {
		// Check as file
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: this.toKey(path),
				}),
			);
			return true;
		} catch (err: unknown) {
			if (!isNotFound(err)) throw err;
		}

		// Check as directory (any objects under prefix)
		const res = await this.client.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: this.dirPrefix(path),
				MaxKeys: 1,
			}),
		);
		return (res.Contents?.length ?? 0) > 0;
	}

	async stat(path: string): Promise<VirtualStat> {
		const now = Date.now();

		// Root always exists
		if (path === "/" || path === "") {
			return buildStat(path || "/", {
				mode: 0o040755,
				size: 0,
				isDirectory: true,
				isSymbolicLink: false,
				timestampMs: now,
			});
		}

		// Try as file
		try {
			const res = await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: this.toKey(path),
				}),
			);
			const mtime = res.LastModified?.getTime() ?? now;
			return buildStat(path, {
				mode: 0o100644,
				size: res.ContentLength ?? 0,
				isDirectory: false,
				isSymbolicLink: false,
				timestampMs: mtime,
			});
		} catch (err: unknown) {
			if (!isNotFound(err)) throw err;
		}

		// Try as directory
		const res = await this.client.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: this.dirPrefix(path),
				MaxKeys: 1,
			}),
		);
		if ((res.Contents?.length ?? 0) > 0) {
			return buildStat(path, {
				mode: 0o040755,
				size: 0,
				isDirectory: true,
				isSymbolicLink: false,
				timestampMs: now,
			});
		}

		throw new Error(`ENOENT: no such file or directory, stat '${path}'`);
	}

	async lstat(path: string): Promise<VirtualStat> {
		return this.stat(path);
	}

	async removeFile(path: string): Promise<void> {
		try {
			await this.client.send(
				new HeadObjectCommand({
					Bucket: this.bucket,
					Key: this.toKey(path),
				}),
			);
		} catch {
			throw new Error(
				`ENOENT: no such file or directory, unlink '${path}'`,
			);
		}
		await this.client.send(
			new DeleteObjectCommand({
				Bucket: this.bucket,
				Key: this.toKey(path),
			}),
		);
	}

	async removeDir(path: string): Promise<void> {
		if (path === "/" || path === "")
			throw new Error("EPERM: operation not permitted, rmdir '/'");

		const prefix = this.dirPrefix(path);
		const res = await this.client.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: prefix,
				MaxKeys: 2,
			}),
		);
		const contents = res.Contents ?? [];

		// No objects under prefix = directory doesn't exist
		if (contents.length === 0)
			throw new Error(
				`ENOENT: no such file or directory, rmdir '${path}'`,
			);

		// More than just the marker = not empty
		if (
			contents.length > 1 ||
			(contents.length === 1 && contents[0].Key !== prefix)
		) {
			throw new Error(
				`ENOTEMPTY: directory not empty, rmdir '${path}'`,
			);
		}
		await this.client.send(
			new DeleteObjectCommand({ Bucket: this.bucket, Key: prefix }),
		);
	}

	async rename(oldPath: string, newPath: string): Promise<void> {
		const oldKey = this.toKey(oldPath);
		const newKey = this.toKey(newPath);

		// Check if source is a directory (has children under prefix)
		const oldPrefix = oldKey.endsWith("/") ? oldKey : oldKey + "/";
		const listing = await this.client.send(
			new ListObjectsV2Command({
				Bucket: this.bucket,
				Prefix: oldPrefix,
				MaxKeys: 1,
			}),
		);
		const isDir = (listing.Contents?.length ?? 0) > 0;

		if (isDir) {
			// Move all objects under the old prefix to the new prefix
			const newPrefix = newKey.endsWith("/") ? newKey : newKey + "/";
			let token: string | undefined;
			do {
				const res = await this.client.send(
					new ListObjectsV2Command({
						Bucket: this.bucket,
						Prefix: oldPrefix,
						ContinuationToken: token,
					}),
				);
				for (const obj of res.Contents ?? []) {
					const suffix = obj.Key!.slice(oldPrefix.length);
					await this.client.send(
						new CopyObjectCommand({
							Bucket: this.bucket,
							CopySource: encodeURIComponent(
								`${this.bucket}/${obj.Key!}`,
							),
							Key: newPrefix + suffix,
						}),
					);
					await this.client.send(
						new DeleteObjectCommand({
							Bucket: this.bucket,
							Key: obj.Key!,
						}),
					);
				}
				token = res.NextContinuationToken;
			} while (token);
			// Move the directory marker itself if it exists
			try {
				await this.client.send(
					new HeadObjectCommand({
						Bucket: this.bucket,
						Key: oldPrefix,
					}),
				);
				await this.client.send(
					new CopyObjectCommand({
						Bucket: this.bucket,
						CopySource: encodeURIComponent(
							`${this.bucket}/${oldPrefix}`,
						),
						Key: newPrefix,
					}),
				);
				await this.client.send(
					new DeleteObjectCommand({
						Bucket: this.bucket,
						Key: oldPrefix,
					}),
				);
			} catch {}
		} else {
			// Single file rename
			await this.client.send(
				new CopyObjectCommand({
					Bucket: this.bucket,
					CopySource: encodeURIComponent(
						`${this.bucket}/${oldKey}`,
					),
					Key: newKey,
				}),
			);
			await this.client.send(
				new DeleteObjectCommand({
					Bucket: this.bucket,
					Key: oldKey,
				}),
			);
		}
	}

	// S3 does not support symlinks or hard links
	async symlink(): Promise<void> {
		throw new Error("ENOSYS: symlinks not supported on S3");
	}
	async readlink(): Promise<string> {
		throw new Error("ENOSYS: symlinks not supported on S3");
	}
	async link(): Promise<void> {
		throw new Error("ENOSYS: hard links not supported on S3");
	}

	// Metadata ops are no-ops (S3 doesn't have POSIX permissions)
	async chmod(): Promise<void> {}
	async chown(): Promise<void> {}
	async utimes(): Promise<void> {}

	async truncate(path: string, length: number): Promise<void> {
		const data = await this.readFile(path);
		if (length >= data.byteLength) {
			const padded = new Uint8Array(length);
			padded.set(data);
			await this.writeFile(path, padded);
		} else {
			await this.writeFile(path, data.slice(0, length));
		}
	}

	async realpath(path: string): Promise<string> {
		return normalizePath(path);
	}

	async pread(path: string, offset: number, length: number): Promise<Uint8Array> {
		const data = await this.readFile(path);
		return data.slice(offset, offset + length);
	}
}

function isNotFound(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const e = err as Record<string, unknown>;
	return (
		e.name === "NoSuchKey" ||
		e.name === "NotFound" ||
		(e.$metadata as Record<string, unknown>)?.httpStatusCode === 404
	);
}

function buildStat(
	path: string,
	options: {
		mode: number;
		size: number;
		isDirectory: boolean;
		isSymbolicLink: boolean;
		timestampMs: number;
	},
): VirtualStat {
	return {
		mode: options.mode,
		size: options.size,
		isDirectory: options.isDirectory,
		isSymbolicLink: options.isSymbolicLink,
		atimeMs: options.timestampMs,
		mtimeMs: options.timestampMs,
		ctimeMs: options.timestampMs,
		birthtimeMs: options.timestampMs,
		ino: hashPath(path),
		nlink: 1,
		uid: 0,
		gid: 0,
	};
}

function normalizePath(path: string): string {
	const normalized = path.replace(/\/+/g, "/");
	if (normalized === "") return "/";
	return normalized.startsWith("/") ? normalized : `/${normalized}`;
}

function hashPath(path: string): number {
	let hash = 0;
	for (let i = 0; i < path.length; i++) {
		hash = ((hash << 5) - hash + path.charCodeAt(i)) | 0;
	}
	return Math.abs(hash) || 1;
}
