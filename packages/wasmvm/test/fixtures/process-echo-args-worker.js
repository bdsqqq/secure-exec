/**
 * Test fixture worker for ProcessManager argv/envp deserialization tests.
 *
 * Echoes back the received command, args, env, and cwd as JSON,
 * then exits with code 0.
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', (msg) => {
  // Signal readyBuffer if provided (spawn-ready handshake)
  if (msg.readyBuffer) {
    const view = new Int32Array(msg.readyBuffer);
    Atomics.store(view, 0, 1);
    Atomics.notify(view, 0);
  }

  const { command, args, env, cwd } = msg;
  const encoder = new TextEncoder();

  // Echo the parsed arguments back as JSON
  const info = JSON.stringify({ command, args, env, cwd });
  const stdout = encoder.encode(info + '\n');

  // Signal waitBuffer via Atomics
  if (msg.waitBuffer) {
    const waitView = new Int32Array(msg.waitBuffer);
    Atomics.store(waitView, 0, 0);  // IDX_EXIT_CODE
    Atomics.store(waitView, 1, 1);  // IDX_DONE_FLAG
    Atomics.notify(waitView, 1);
  }

  parentPort.postMessage({
    exitCode: 0,
    stdout,
    stderr: new Uint8Array(0),
    vfsChanges: [],
  });
});
