import type { DirEntry, StatInfo, VirtualFileSystem } from "secure-exec";
import {
  NodeRuntime,
  allowAllFs,
  createNodeDriver,
  createNodeRuntimeDriverFactory,
} from "secure-exec";

class ReadOnlyMapFS implements VirtualFileSystem {
  private files: Map<string, string>;

  constructor(files: Record<string, string>) {
    this.files = new Map(Object.entries(files));
  }

  async readFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return new TextEncoder().encode(content);
  }

  async readTextFile(path: string) {
    const content = this.files.get(path);
    if (content === undefined) throw new Error(`ENOENT: ${path}`);
    return content;
  }

  async readDir(path: string) {
    const prefix = path === "/" ? "/" : path + "/";
    const entries = new Set<string>();
    for (const key of this.files.keys()) {
      if (!key.startsWith(prefix)) continue;
      const rest = key.slice(prefix.length);
      if (rest.length > 0) {
        entries.add(rest.split("/")[0]);
      }
    }
    if (entries.size === 0) throw new Error(`ENOENT: ${path}`);
    return [...entries];
  }

  async readDirWithTypes(path: string): Promise<DirEntry[]> {
    const names = await this.readDir(path);
    const prefix = path === "/" ? "/" : path + "/";
    return names.map((name) => ({
      name,
      isDirectory: this.#isDir(prefix + name),
      isSymbolicLink: false,
    }));
  }

  async writeFile() { throw new Error("EROFS: read-only filesystem"); }
  async createDir() { throw new Error("EROFS: read-only filesystem"); }
  async mkdir() { throw new Error("EROFS: read-only filesystem"); }

  async exists(path: string) {
    return this.files.has(path) || this.#isDir(path);
  }

  async stat(path: string): Promise<StatInfo> {
    const now = Date.now();
    if (this.files.has(path)) {
      return {
        mode: 0o444,
        size: new TextEncoder().encode(this.files.get(path) ?? "").byteLength,
        isDirectory: false,
        isSymbolicLink: false,
        atimeMs: now,
        mtimeMs: now,
        ctimeMs: now,
        birthtimeMs: now,
        ino: 1,
        nlink: 1,
        uid: 0,
        gid: 0,
      };
    }
    if (this.#isDir(path)) {
      return {
        mode: 0o555,
        size: 0,
        isDirectory: true,
        isSymbolicLink: false,
        atimeMs: now,
        mtimeMs: now,
        ctimeMs: now,
        birthtimeMs: now,
        ino: 1,
        nlink: 1,
        uid: 0,
        gid: 0,
      };
    }
    throw new Error(`ENOENT: ${path}`);
  }

  async removeFile() { throw new Error("EROFS: read-only filesystem"); }
  async removeDir() { throw new Error("EROFS: read-only filesystem"); }
  async rename() { throw new Error("EROFS: read-only filesystem"); }
  async realpath(path: string) { return path; }
  async symlink() { throw new Error("EROFS: read-only filesystem"); }
  async readlink(_path: string): Promise<string> { throw new Error("ENOSYS: no symlinks"); }
  async lstat(path: string) { return this.stat(path); }
  async link() { throw new Error("EROFS: read-only filesystem"); }
  async chmod() { throw new Error("EROFS: read-only filesystem"); }
  async chown() { throw new Error("EROFS: read-only filesystem"); }
  async utimes() { throw new Error("EROFS: read-only filesystem"); }
  async truncate() { throw new Error("EROFS: read-only filesystem"); }
  async pread(path: string, offset: number, length: number) {
    const bytes = await this.readFile(path);
    return bytes.slice(offset, offset + length);
  }

  #isDir(path: string) {
    const prefix = path === "/" ? "/" : path + "/";
    for (const key of this.files.keys()) {
      if (key.startsWith(prefix)) return true;
    }
    return false;
  }
}

const filesystem = new ReadOnlyMapFS({
  "/config.json": JSON.stringify({ greeting: "hello from custom vfs" }),
});
const events: string[] = [];

const runtime = new NodeRuntime({
  systemDriver: createNodeDriver({
    filesystem,
    permissions: { ...allowAllFs },
  }),
  runtimeDriverFactory: createNodeRuntimeDriverFactory(),
});

try {
  const result = await runtime.exec(
    `
      const fs = require("node:fs");
      const config = JSON.parse(fs.readFileSync("/config.json", "utf8"));
      console.log(config.greeting);
    `,
    {
      onStdio: (event) => {
        if (event.channel === "stdout") {
          events.push(event.message);
        }
      },
    },
  );

  const message = events.at(-1);
  if (result.code !== 0 || message !== "hello from custom vfs") {
    throw new Error(`Unexpected runtime result: ${JSON.stringify({ result, events })}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      message,
      summary: "sandbox read config data from a custom read-only virtual filesystem",
    }),
  );
} finally {
  runtime.dispose();
}
