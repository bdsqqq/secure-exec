/**
 * @secure-exec/os-browser
 *
 * Browser platform adapter — provides in-memory/OPFS filesystem
 * and Web Worker abstractions for the kernel.
 *
 * @deprecated Canonical source is now @secure-exec/browser
 */

export { InMemoryFileSystem, BrowserWorkerAdapter } from "@secure-exec/browser";
export type { WorkerHandle } from "@secure-exec/browser";
