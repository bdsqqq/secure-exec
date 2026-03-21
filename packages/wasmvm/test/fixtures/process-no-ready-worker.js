/**
 * Test fixture worker that never signals readyBuffer.
 *
 * Used to test spawn timeout behavior when a child Worker
 * fails to initialize properly.
 */
import { parentPort } from 'node:worker_threads';

parentPort.on('message', () => {
  // Deliberately do NOT signal readyBuffer.
  // The parent should hit the 5-second spawn-ready timeout.
  // Also never respond — simulate a hung worker.
});
