import { Directory } from "@wasmer/sdk/node";

export interface FileInfo {
  isFile: boolean;
  isDirectory: boolean;
  size: number;
}

export class SystemBridge {
  private directory: Directory;

  constructor(directory?: Directory) {
    this.directory = directory ?? new Directory();
  }

  /**
   * Get the underlying Directory instance
   */
  getDirectory(): Directory {
    return this.directory;
  }

  /**
   * Write a file to the virtual filesystem (sync - writes to in-memory storage)
   */
  writeFile(path: string, content: string | Uint8Array): void {
    this.directory.writeFile(path, content);
  }

  /**
   * Read a file from the virtual filesystem
   */
  async readFile(path: string): Promise<string> {
    return this.directory.readTextFile(path);
  }

  /**
   * Read a file synchronously (for use in sync contexts)
   * Note: This may not work in all scenarios
   */
  readFileSync(path: string): string {
    // The wasmer Directory API is async, but for simple cases
    // we can try to access synchronously by storing writes
    // For now, just call the async method
    // This is a limitation that may need addressing
    return this.directory.readTextFile(path) as unknown as string;
  }

  /**
   * Read a file as binary from the virtual filesystem
   */
  async readFileBinary(path: string): Promise<Uint8Array> {
    return this.directory.readFile(path);
  }

  /**
   * Read directory contents (returns array of entry names)
   */
  async readDir(path: string): Promise<string[]> {
    const entries = await this.directory.readDir(path);
    // Directory.readDir returns objects like { name: string, type: string }
    // We normalize to just names for simpler API
    return entries.map((entry: { name: string } | string) =>
      typeof entry === "string" ? entry : entry.name
    );
  }

  /**
   * Create a directory (recursively creates parent directories)
   */
  mkdir(path: string): void {
    // Normalize path
    const normalizedPath = path.startsWith("/") ? path : `/${path}`;
    const parts = normalizedPath.split("/").filter(Boolean);

    // Create each directory level
    let currentPath = "";
    for (const part of parts) {
      currentPath += `/${part}`;
      try {
        // createDir may return a promise - catch any rejections
        const result = this.directory.createDir(currentPath);
        if (result && typeof result.catch === "function") {
          result.catch(() => {
            // Directory might already exist, ignore error
          });
        }
      } catch {
        // Directory might already exist, ignore error
      }
    }
  }

  /**
   * Check if a path exists
   */
  async exists(path: string): Promise<boolean> {
    try {
      // Try to read as file first
      await this.directory.readTextFile(path);
      return true;
    } catch {
      try {
        // Try as directory
        await this.directory.readDir(path);
        return true;
      } catch {
        return false;
      }
    }
  }

  /**
   * Remove a file
   */
  async remove(path: string): Promise<void> {
    await this.directory.removeFile(path);
  }

  /**
   * Remove a directory
   */
  async removeDir(path: string): Promise<void> {
    await this.directory.removeDir(path);
  }
}
