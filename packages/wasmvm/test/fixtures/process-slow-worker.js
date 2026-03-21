/**
 * Test fixture worker for ProcessManager kill tests.
 *
 * Simulates a long-running child process that takes 10 seconds to complete.
 * Used to test proc_kill behavior.
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  // Signal readyBuffer if provided (spawn-ready handshake)
  if (msg.readyBuffer) {
    const view = new Int32Array(msg.readyBuffer);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
  }

  // Simulate a long-running process — respond after 10 seconds
  setTimeout(() => {
    // Signal waitBuffer via Atomics
    if (msg.waitBuffer) {
      const waitView = new Int32Array(msg.waitBuffer);
      Atomics.store(waitView, 0, 0);  // IDX_EXIT_CODE
      Atomics.store(waitView, 1, 1);  // IDX_DONE_FLAG
      Atomics.notify(waitView, 1);
    }

    parentPort.postMessage({
      exitCode: 0,
      stdout: new Uint8Array(0),
      stderr: new Uint8Array(0),
      vfsChanges: [],
    });
  }, 10000);
});
