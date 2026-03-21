/**
 * Test fixture worker for ProcessManager tests.
 *
 * Simulates a child process that responds immediately with exit code 0.
 * Accepts the same message format as worker-entry.js.
 *
 * Mirrors the real worker-entry.ts by signaling readyBuffer and waitBuffer
 * via Atomics so that the parent can call proc_waitpid without yielding to
 * the event loop.
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  // Signal readyBuffer if provided (spawn-ready handshake)
  if (msg.readyBuffer) {
    const view = new Int32Array(msg.readyBuffer);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
  }

  const { command, args = [] } = msg;
  const encoder = new TextEncoder();

  let exitCode = 0;
  let stdout = new Uint8Array(0);
  let stderr = new Uint8Array(0);

  switch (command) {
    case 'echo':
      stdout = encoder.encode(args.join(' ') + '\n');
      break;
    case 'true':
      exitCode = 0;
      break;
    case 'false':
      exitCode = 1;
      break;
    default:
      stdout = encoder.encode('');
      break;
  }

  // Signal waitBuffer via Atomics (mirrors worker-entry.ts behavior).
  // Critical: the parent may be blocked on Atomics.wait in proc_waitpid,
  // so we must signal via shared memory, not just postMessage.
  if (msg.waitBuffer) {
    const waitView = new Int32Array(msg.waitBuffer);
    Atomics.store(waitView, 0, exitCode); // IDX_EXIT_CODE
    Atomics.store(waitView, 1, 1);        // IDX_DONE_FLAG
    Atomics.notify(waitView, 1);          // wake parent
  }

  parentPort.postMessage({
    exitCode,
    stdout,
    stderr,
    vfsChanges: [],
  });
});
