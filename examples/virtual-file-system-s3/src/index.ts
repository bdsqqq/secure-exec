import {
	NodeRuntime,
	allowAllFs,
	createNodeDriver,
	createNodeRuntimeDriverFactory,
} from "secure-exec";
import {
	S3Client,
	CreateBucketCommand,
	DeleteBucketCommand,
	ListObjectsV2Command,
	DeleteObjectCommand,
} from "@aws-sdk/client-s3";
import { S3FileSystem } from "./s3-filesystem.js";

const BUCKET = "secure-exec-vfs-test";

const client = new S3Client({
	endpoint: "http://localhost:9000",
	region: "us-east-1",
	credentials: {
		accessKeyId: "minioadmin",
		secretAccessKey: "minioadmin",
	},
	forcePathStyle: true,
});

try {
	await client.send(new CreateBucketCommand({ Bucket: BUCKET }));
} catch (err: unknown) {
	if (isServiceUnavailable(err)) {
		console.log(
			JSON.stringify({
				ok: true,
				skipped: true,
				reason: "S3 endpoint unavailable at http://localhost:9000",
			}),
		);
		process.exit(0);
	}
	const e = err as { name?: string };
	if (
		e.name !== "BucketAlreadyOwnedByYou" &&
		e.name !== "BucketAlreadyExists"
	) {
		throw err;
	}
}

const filesystem = new S3FileSystem({ client, bucket: BUCKET });

const runtime = new NodeRuntime({
	systemDriver: createNodeDriver({
		filesystem,
		permissions: { ...allowAllFs },
	}),
	runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

const failures: string[] = [];

function assert(condition: boolean, message: string) {
	if (!condition) {
		failures.push(message);
		console.error(`FAIL: ${message}`);
	}
}

async function exec(
	code: string,
): Promise<{ code: number; stdout: string; stderr: string }> {
	let stdout = "";
	let stderr = "";
	const result = await runtime.exec(code, {
		onStdio: (event) => {
			if (event.channel === "stdout") stdout += event.message;
			else stderr += event.message;
		},
	});
	return { code: result.code, stdout, stderr };
}

try {
	// --- writeFile + readFile + readDir ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.mkdirSync("/workspace", { recursive: true });
			fs.writeFileSync("/workspace/hello.txt", "hello from sandbox via S3");
			fs.writeFileSync("/workspace/data.json", JSON.stringify({ count: 42 }));
			const text = fs.readFileSync("/workspace/hello.txt", "utf8");
			const data = JSON.parse(fs.readFileSync("/workspace/data.json", "utf8"));
			const entries = fs.readdirSync("/workspace");
			console.log(JSON.stringify({ text, count: data.count, entries }));
		`);
		assert(r.code === 0, `writeFile+readFile exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(
			parsed.text === "hello from sandbox via S3",
			"readFile content mismatch",
		);
		assert(parsed.count === 42, "readFile JSON data mismatch");
		assert(
			parsed.entries.includes("hello.txt"),
			"readDir missing hello.txt",
		);
		assert(
			parsed.entries.includes("data.json"),
			"readDir missing data.json",
		);
		const hostContent = await filesystem.readTextFile(
			"/workspace/hello.txt",
		);
		assert(
			hostContent === "hello from sandbox via S3",
			"host readTextFile mismatch",
		);
	}

	// --- stat ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			const fileStat = fs.statSync("/workspace/hello.txt");
			const dirStat = fs.statSync("/workspace");
			console.log(JSON.stringify({
				fileIsDir: fileStat.isDirectory(),
				fileSize: fileStat.size,
				dirIsDir: dirStat.isDirectory(),
			}));
		`);
		assert(r.code === 0, `stat exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(!parsed.fileIsDir, "stat: file should not be directory");
		assert(parsed.fileSize > 0, "stat: file size should be > 0");
		assert(parsed.dirIsDir, "stat: dir should be directory");
	}

	// --- exists ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			console.log(JSON.stringify({
				yes: fs.existsSync("/workspace/hello.txt"),
				no: fs.existsSync("/nonexistent-file.xyz"),
			}));
		`);
		assert(r.code === 0, `exists exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(parsed.yes === true, "existsSync true for existing file");
		assert(parsed.no === false, "existsSync false for missing file");
	}

	// --- rename file ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/old.txt", "rename-me");
			fs.renameSync("/workspace/old.txt", "/workspace/new.txt");
			const content = fs.readFileSync("/workspace/new.txt", "utf8");
			const oldExists = fs.existsSync("/workspace/old.txt");
			console.log(JSON.stringify({ content, oldExists }));
		`);
		assert(r.code === 0, `rename exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(parsed.content === "rename-me", "rename: content mismatch");
		assert(!parsed.oldExists, "rename: old path should not exist");
	}

	// --- rename directory with children ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.mkdirSync("/workspace/dirA/sub", { recursive: true });
			fs.writeFileSync("/workspace/dirA/sub/file.txt", "child-content");
			fs.renameSync("/workspace/dirA", "/workspace/dirB");
			const content = fs.readFileSync("/workspace/dirB/sub/file.txt", "utf8");
			const oldExists = fs.existsSync("/workspace/dirA");
			console.log(JSON.stringify({ content, oldExists }));
		`);
		assert(r.code === 0, `rename dir exec failed: ${r.stderr}`);
		const parsed = JSON.parse(r.stdout.trim());
		assert(
			parsed.content === "child-content",
			"rename dir: child content lost",
		);
		assert(!parsed.oldExists, "rename dir: old path should not exist");
	}

	// --- removeFile ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/delete-me.txt", "gone");
			fs.unlinkSync("/workspace/delete-me.txt");
			console.log(JSON.stringify({ exists: fs.existsSync("/workspace/delete-me.txt") }));
		`);
		assert(r.code === 0, `removeFile exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).exists === false,
			"removeFile: file should be gone",
		);
	}

	// --- removeDir ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.mkdirSync("/workspace/empty-dir");
			fs.rmdirSync("/workspace/empty-dir");
			console.log(JSON.stringify({ exists: fs.existsSync("/workspace/empty-dir") }));
		`);
		assert(r.code === 0, `removeDir exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).exists === false,
			"removeDir: dir should be gone",
		);
	}

	// --- truncate ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			fs.writeFileSync("/workspace/trunc.txt", "hello world");
			fs.truncateSync("/workspace/trunc.txt", 5);
			const content = fs.readFileSync("/workspace/trunc.txt", "utf8");
			console.log(JSON.stringify({ content }));
		`);
		assert(r.code === 0, `truncate exec failed: ${r.stderr}`);
		assert(
			JSON.parse(r.stdout.trim()).content === "hello",
			"truncate: should be 'hello'",
		);
	}

	// --- error: symlink (should throw ENOSYS) ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			try { fs.symlinkSync("/workspace/hello.txt", "/workspace/link"); console.log("NO_ERROR"); }
			catch (e) { console.log(e.message.includes("ENOSYS") ? "ENOSYS" : e.message); }
		`);
		assert(r.code === 0, `symlink error exec failed: ${r.stderr}`);
		assert(
			r.stdout.trim() === "ENOSYS",
			"symlink should throw ENOSYS on S3",
		);
	}

	// --- error: read nonexistent ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			try { fs.readFileSync("/nonexistent"); console.log("NO_ERROR"); }
			catch (e) { console.log(e.message.includes("ENOENT") ? "ENOENT" : e.message); }
		`);
		assert(r.code === 0, `error read exec failed: ${r.stderr}`);
		assert(
			r.stdout.trim() === "ENOENT",
			"read missing file should throw ENOENT",
		);
	}

	// --- error: rmdir non-empty ---
	{
		const r = await exec(`
			const fs = require("node:fs");
			try { fs.rmdirSync("/workspace"); console.log("NO_ERROR"); }
			catch (e) { console.log(e.message.includes("ENOTEMPTY") || e.message.includes("not empty") ? "ENOTEMPTY" : e.message); }
		`);
		assert(r.code === 0, `error rmdir exec failed: ${r.stderr}`);
		assert(
			r.stdout.trim() === "ENOTEMPTY",
			"rmdir non-empty should throw ENOTEMPTY",
		);
	}

	// --- result ---
	const ok = failures.length === 0;
	console.log(
		JSON.stringify({
			ok,
			passed: 12 - failures.length,
			total: 12,
			failures,
			summary: ok
				? "S3 VFS: 12/12 tests passed (write, read, stat, exists, rename, rename-dir, remove, rmdir, truncate, err-symlink, err-read, err-rmdir)"
				: `${failures.length} of 12 tests failed`,
		}),
	);

	if (!ok) process.exit(1);
} finally {
	runtime.dispose();

	// Clean up: paginated delete of all objects, then bucket
	let token: string | undefined;
	do {
		const list = await client.send(
			new ListObjectsV2Command({
				Bucket: BUCKET,
				ContinuationToken: token,
			}),
		);
		for (const obj of list.Contents ?? []) {
			await client.send(
				new DeleteObjectCommand({ Bucket: BUCKET, Key: obj.Key! }),
			);
		}
		token = list.NextContinuationToken;
	} while (token);
	await client.send(new DeleteBucketCommand({ Bucket: BUCKET }));
}

function isServiceUnavailable(err: unknown): boolean {
	if (typeof err !== "object" || err === null) return false;
	const record = err as {
		code?: string;
		errors?: Array<{ code?: string }>;
	};
	if (record.code === "ECONNREFUSED") return true;
	return Array.isArray(record.errors)
		&& record.errors.some((entry) => entry.code === "ECONNREFUSED");
}
