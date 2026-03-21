/**
 * Worker adapter layer for browser and Node.js.
 *
 * Provides a unified Worker abstraction that works in both browser
 * (Web Workers) and Node.js (worker_threads), normalizing the API
 * for spawn, messaging, and termination.
 */

// Environment detection
const isBrowser = typeof globalThis.window !== 'undefined'
  && typeof globalThis.document !== 'undefined';

/** Unified interface for worker handles. */
export interface WorkerHandle {
  postMessage(data: unknown, transferList?: Transferable[]): void;
  onMessage(handler: (data: unknown) => void): void;
  onError(handler: (err: Error) => void): void;
  onExit(handler: (code: number) => void): void;
  terminate(): void | Promise<number>;
}

export interface SpawnOptions {
  workerData?: unknown;
  transferList?: Transferable[];
}

/**
 * Wraps a Node.js worker_threads.Worker with a browser-like interface.
 */
class NodeWorkerHandle implements WorkerHandle {
  private _worker: import('node:worker_threads').Worker;
  private _messageHandlers: Array<(data: unknown) => void> = [];
  private _errorHandlers: Array<(err: Error) => void> = [];
  private _exitHandlers: Array<(code: number) => void> = [];

  constructor(worker: import('node:worker_threads').Worker) {
    this._worker = worker;

    this._worker.on('message', (data: unknown) => {
      for (const handler of this._messageHandlers) {
        handler(data);
      }
    });

    this._worker.on('error', (err: Error) => {
      for (const handler of this._errorHandlers) {
        handler(err);
      }
    });

    this._worker.on('exit', (code: number) => {
      for (const handler of this._exitHandlers) {
        handler(code);
      }
    });
  }

  postMessage(data: unknown, transferList?: Transferable[]): void {
    this._worker.postMessage(data, transferList as import('node:worker_threads').TransferListItem[] | undefined);
  }

  onMessage(handler: (data: unknown) => void): void {
    this._messageHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this._errorHandlers.push(handler);
  }

  onExit(handler: (code: number) => void): void {
    this._exitHandlers.push(handler);
  }

  terminate(): Promise<number> {
    return this._worker.terminate();
  }

  get threadId(): number {
    return this._worker.threadId;
  }
}

/**
 * Wraps a browser Web Worker with the same interface as NodeWorkerHandle.
 */
class BrowserWorkerHandle implements WorkerHandle {
  private _worker: globalThis.Worker;
  private _messageHandlers: Array<(data: unknown) => void> = [];
  private _errorHandlers: Array<(err: Error) => void> = [];

  constructor(worker: globalThis.Worker) {
    this._worker = worker;

    this._worker.onmessage = (event: MessageEvent) => {
      for (const handler of this._messageHandlers) {
        handler(event.data);
      }
    };

    this._worker.onerror = (event: ErrorEvent) => {
      const err = new Error(event.message || 'Worker error');
      for (const handler of this._errorHandlers) {
        handler(err);
      }
    };
  }

  postMessage(data: unknown, transferList?: Transferable[]): void {
    if (transferList) {
      this._worker.postMessage(data, transferList);
    } else {
      this._worker.postMessage(data);
    }
  }

  onMessage(handler: (data: unknown) => void): void {
    this._messageHandlers.push(handler);
  }

  onError(handler: (err: Error) => void): void {
    this._errorHandlers.push(handler);
  }

  onExit(_handler: (code: number) => void): void {
    // Web Workers don't have an exit event equivalent.
    // Termination is fire-and-forget.
  }

  terminate(): void {
    this._worker.terminate();
  }
}

/**
 * Unified Worker abstraction for browser and Node.js.
 */
export class WorkerAdapter {
  private _environment: 'browser' | 'node';

  constructor() {
    this._environment = isBrowser ? 'browser' : 'node';
  }

  get environment(): 'browser' | 'node' {
    return this._environment;
  }

  async spawn(script: string | URL, options: SpawnOptions = {}): Promise<WorkerHandle> {
    if (this._environment === 'node') {
      return this._spawnNode(script, options);
    } else {
      return this._spawnBrowser(script, options);
    }
  }

  private async _spawnNode(script: string | URL, options: SpawnOptions): Promise<WorkerHandle> {
    const { Worker } = await import('node:worker_threads');
    // If the script is a .ts file, pass --import tsx so the worker can load TypeScript
    const scriptStr = typeof script === 'string' ? script : script.href;
    const execArgv = scriptStr.endsWith('.ts') ? ['--import', 'tsx'] : [];
    const worker = new Worker(script, {
      workerData: options.workerData,
      transferList: options.transferList as import('node:worker_threads').TransferListItem[],
      execArgv,
    });
    return new NodeWorkerHandle(worker);
  }

  private async _spawnBrowser(script: string | URL, options: SpawnOptions): Promise<WorkerHandle> {
    const worker = new globalThis.Worker(script, { type: 'module' });
    const handle = new BrowserWorkerHandle(worker);

    // In browser, pass workerData as an initial message since
    // Web Workers don't have a workerData constructor option.
    if (options.workerData !== undefined) {
      handle.postMessage({
        type: '__workerData',
        data: options.workerData,
      }, options.transferList);
    }

    return handle;
  }

  static isSharedArrayBufferAvailable(): boolean {
    return typeof SharedArrayBuffer !== 'undefined';
  }
}
