/**
 * Worker fixture for ring buffer cross-thread tests.
 * Implements writer and reader roles using raw Atomics
 * (matches ring-buffer.ts protocol without TypeScript imports).
 */
import { parentPort } from 'node:worker_threads';

const HEADER_INTS = 4;
const HEADER_BYTES = HEADER_INTS * 4;
const IDX_WRITE_POS = 0;
const IDX_READ_POS = 1;
const IDX_CLOSED = 2;
const WAIT_TIMEOUT = 5000;

parentPort.on('message', (msg) => {
  if (msg.type === 'write') {
    const header = new Int32Array(msg.sab, 0, HEADER_INTS);
    const ringData = new Uint8Array(msg.sab, HEADER_BYTES);
    const capacity = ringData.length;
    const data = new Uint8Array(msg.data);

    let written = 0;
    while (written < data.length) {
      const writePos = Atomics.load(header, IDX_WRITE_POS);
      const readPos = Atomics.load(header, IDX_READ_POS);
      const avail = capacity - (writePos - readPos);

      if (avail <= 0) {
        Atomics.wait(header, IDX_READ_POS, readPos, WAIT_TIMEOUT);
        continue;
      }

      const chunk = Math.min(data.length - written, avail);
      for (let i = 0; i < chunk; i++) {
        ringData[(writePos + i) % capacity] = data[written + i];
      }
      Atomics.store(header, IDX_WRITE_POS, writePos + chunk);
      Atomics.notify(header, IDX_WRITE_POS);
      written += chunk;
    }

    // Signal EOF
    Atomics.store(header, IDX_CLOSED, 1);
    Atomics.notify(header, IDX_WRITE_POS);
    parentPort.postMessage({ type: 'writeDone', written });

  } else if (msg.type === 'read') {
    const header = new Int32Array(msg.sab, 0, HEADER_INTS);
    const ringData = new Uint8Array(msg.sab, HEADER_BYTES);
    const capacity = ringData.length;
    const readChunkSize = msg.readSize || 32;
    const received = [];

    while (true) {
      const writePos = Atomics.load(header, IDX_WRITE_POS);
      const readPos = Atomics.load(header, IDX_READ_POS);
      const avail = writePos - readPos;

      if (avail > 0) {
        const chunk = Math.min(readChunkSize, avail);
        for (let i = 0; i < chunk; i++) {
          received.push(ringData[(readPos + i) % capacity]);
        }
        Atomics.store(header, IDX_READ_POS, readPos + chunk);
        Atomics.notify(header, IDX_READ_POS);
        continue;
      }

      if (Atomics.load(header, IDX_CLOSED) === 1) break;
      Atomics.wait(header, IDX_WRITE_POS, writePos, WAIT_TIMEOUT);
    }

    parentPort.postMessage({ type: 'readDone', data: received });
  }
});
