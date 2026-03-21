/**
 * Test fixture worker for waitpid timeout tests.
 *
 * Signals readyBuffer (so spawn succeeds) but never signals waitBuffer
 * or exits — simulates a hung child process.
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  // Signal readyBuffer so spawn succeeds
  if (msg.readyBuffer) {
    const view = new Int32Array(msg.readyBuffer);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
  }

  // Never signal waitBuffer — hang forever
  // (The worker will be terminated by proc_kill or waitpid timeout)
});
