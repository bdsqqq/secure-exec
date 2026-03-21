/**
 * Simple echo worker for testing WorkerAdapter.
 * Receives a message and echoes it back with metadata.
 */
import { workerData, parentPort } from 'node:worker_threads';

// Send workerData back immediately if present
if (workerData !== undefined) {
  parentPort.postMessage({ type: 'workerData', data: workerData });
}

// Echo back any messages received
parentPort.on('message', (msg) => {
  if (msg.type === 'echo') {
    parentPort.postMessage({ type: 'echo', data: msg.data });
  } else if (msg.type === 'exit') {
    process.exit(msg.code || 0);
  } else if (msg.type === 'sharedBuffer') {
    // Write to a SharedArrayBuffer to prove it works
    const view = new Int32Array(msg.buffer);
    Atomics.store(view, 0, 42);
    Atomics.notify(view, 0, 1);
    parentPort.postMessage({ type: 'sharedBufferDone' });
  } else {
    parentPort.postMessage({ type: 'unknown', original: msg });
  }
});
