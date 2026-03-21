/**
 * Tests for ring-buffer.ts — SharedArrayBuffer ring buffer with timeouts.
 */

import { describe, test, expect } from 'vitest';
import { Worker } from 'node:worker_threads';
import { join } from 'node:path';
import { createRingBuffer, RingBufferWriter, RingBufferReader } from '../src/ring-buffer.ts';

const RING_BUFFER_WORKER = join(__dirname, 'fixtures', 'ring-buffer-worker.js');

describe('RingBuffer - basic read/write', () => {
  test('writer writes and reader reads data', () => {
    const sab = createRingBuffer(64);
    const writer = new RingBufferWriter(sab);
    const reader = new RingBufferReader(sab);

    const data = new TextEncoder().encode('hello');
    writer.write(data);
    writer.close();

    const buf = new Uint8Array(64);
    const n = reader.read(buf);
    expect(n).toBe(5);
    expect(new TextDecoder().decode(buf.subarray(0, n))).toBe('hello');
  });

  test('reader returns 0 (EOF) after writer closes', () => {
    const sab = createRingBuffer(64);
    const writer = new RingBufferWriter(sab);
    const reader = new RingBufferReader(sab);

    writer.close();

    const buf = new Uint8Array(64);
    const n = reader.read(buf);
    expect(n).toBe(0);
  });

  test('multiple writes and reads', () => {
    const sab = createRingBuffer(64);
    const writer = new RingBufferWriter(sab);
    const reader = new RingBufferReader(sab);

    writer.write(new TextEncoder().encode('abc'));
    writer.write(new TextEncoder().encode('def'));
    writer.close();

    const buf = new Uint8Array(64);
    let total = '';
    let n;
    while ((n = reader.read(buf)) > 0) {
      total += new TextDecoder().decode(buf.subarray(0, n));
    }
    expect(total).toBe('abcdef');
  });
});

describe('RingBuffer - writer timeout when reader is dead', () => {
  test('writer times out and returns partial write when buffer full and reader absent', () => {
    // Use a tiny buffer (8 bytes) and very short timeouts for fast testing
    const sab = createRingBuffer(8);
    const writer = new RingBufferWriter(sab, { waitTimeoutMs: 50, maxRetries: 2 });

    // Fill the buffer completely (8 bytes)
    const fillData = new Uint8Array(8);
    fillData.fill(0x42);
    const written1 = writer.write(fillData);
    expect(written1).toBe(8);

    // Try to write more — no reader is consuming, so writer should timeout
    const moreData = new Uint8Array(4);
    moreData.fill(0x43);
    const written2 = writer.write(moreData);
    expect(written2).toBe(0);

    // Buffer should be closed (EOF signaled)
    const header = new Int32Array(sab, 0, 4);
    expect(Atomics.load(header, 2)).toBe(1);
  });
});

describe('RingBuffer - reader timeout when writer is dead', () => {
  test('reader times out and returns EOF when writer disappears', () => {
    const sab = createRingBuffer(64);
    // No writer — reader will wait and timeout
    const reader = new RingBufferReader(sab, { waitTimeoutMs: 50, maxRetries: 2 });

    const buf = new Uint8Array(64);
    const n = reader.read(buf);
    expect(n).toBe(0);

    // Buffer should be marked closed
    const header = new Int32Array(sab, 0, 4);
    expect(Atomics.load(header, 2)).toBe(1);
  });
});

describe('RingBuffer - cross-thread communication', () => {
  test('writer in one thread sends data, reader in other thread receives correctly', async () => {
    const sab = createRingBuffer(128);
    const dataToWrite = new Uint8Array(64);
    for (let i = 0; i < 64; i++) dataToWrite[i] = i;

    const writerWorker = new Worker(RING_BUFFER_WORKER);
    const readerWorker = new Worker(RING_BUFFER_WORKER);

    try {
      const readerDone = new Promise<number[]>((resolve, reject) => {
        readerWorker.on('message', (msg: { type: string; data: number[] }) => {
          if (msg.type === 'readDone') resolve(msg.data);
        });
        readerWorker.on('error', reject);
      });

      const writerDone = new Promise<number>((resolve, reject) => {
        writerWorker.on('message', (msg: { type: string; written: number }) => {
          if (msg.type === 'writeDone') resolve(msg.written);
        });
        writerWorker.on('error', reject);
      });

      // Start reader first (blocks waiting for data), then writer
      readerWorker.postMessage({ type: 'read', sab, readSize: 16 });
      writerWorker.postMessage({ type: 'write', sab, data: Array.from(dataToWrite) });

      const [received, written] = await Promise.all([readerDone, writerDone]);

      expect(written).toBe(64);
      expect(received.length).toBe(64);
      expect(received).toEqual(Array.from(dataToWrite));
    } finally {
      await Promise.all([writerWorker.terminate(), readerWorker.terminate()]);
    }
  });

  test('wraparound: write more data than buffer capacity across threads', async () => {
    // 16-byte buffer, 256 bytes of data → 16 full cycles of wraparound
    const sab = createRingBuffer(16);
    const dataToWrite = new Uint8Array(256);
    for (let i = 0; i < 256; i++) dataToWrite[i] = i & 0xff;

    const writerWorker = new Worker(RING_BUFFER_WORKER);
    const readerWorker = new Worker(RING_BUFFER_WORKER);

    try {
      const readerDone = new Promise<number[]>((resolve, reject) => {
        readerWorker.on('message', (msg: { type: string; data: number[] }) => {
          if (msg.type === 'readDone') resolve(msg.data);
        });
        readerWorker.on('error', reject);
      });

      const writerDone = new Promise<number>((resolve, reject) => {
        writerWorker.on('message', (msg: { type: string; written: number }) => {
          if (msg.type === 'writeDone') resolve(msg.written);
        });
        writerWorker.on('error', reject);
      });

      // Odd read size forces misaligned reads across the wrap boundary
      readerWorker.postMessage({ type: 'read', sab, readSize: 7 });
      writerWorker.postMessage({ type: 'write', sab, data: Array.from(dataToWrite) });

      const [received, written] = await Promise.all([readerDone, writerDone]);

      expect(written).toBe(256);
      expect(received.length).toBe(256);
      expect(received).toEqual(Array.from(dataToWrite));
    } finally {
      await Promise.all([writerWorker.terminate(), readerWorker.terminate()]);
    }
  });
});

describe('RingBuffer - boundary and edge cases', () => {
  test('interleaved read/write at buffer boundary — no data corruption', () => {
    const sab = createRingBuffer(8);
    const writer = new RingBufferWriter(sab);
    const reader = new RingBufferReader(sab);
    const readBuf = new Uint8Array(16);

    // Write 6 bytes (fills 6/8 of buffer)
    writer.write(new Uint8Array([1, 2, 3, 4, 5, 6]));

    // Read all 6 — readPos=6, writePos=6
    let n = reader.read(readBuf);
    expect(n).toBe(6);
    expect(Array.from(readBuf.subarray(0, n))).toEqual([1, 2, 3, 4, 5, 6]);

    // Write 6 more — wraps around: indices 6,7,0,1,2,3
    writer.write(new Uint8Array([7, 8, 9, 10, 11, 12]));

    // Read wrapped data
    n = reader.read(readBuf);
    expect(n).toBe(6);
    expect(Array.from(readBuf.subarray(0, n))).toEqual([7, 8, 9, 10, 11, 12]);

    // Write exactly full buffer at a non-zero offset (writePos=12 → index 4)
    writer.write(new Uint8Array([13, 14, 15, 16, 17, 18, 19, 20]));
    writer.close();

    n = reader.read(readBuf);
    expect(n).toBe(8);
    expect(Array.from(readBuf.subarray(0, n))).toEqual([13, 14, 15, 16, 17, 18, 19, 20]);

    // EOF
    n = reader.read(readBuf);
    expect(n).toBe(0);
  });

  test('zero-length read buffer returns 0 bytes without error', () => {
    const sab = createRingBuffer(64);
    const writer = new RingBufferWriter(sab);
    const reader = new RingBufferReader(sab);

    // Write data so buffer is non-empty
    writer.write(new Uint8Array([1, 2, 3]));
    writer.close();

    // Zero-length read returns 0 without consuming data
    const emptyBuf = new Uint8Array(0);
    const n = reader.read(emptyBuf);
    expect(n).toBe(0);

    // Data is still available (readPos unchanged)
    const realBuf = new Uint8Array(64);
    const n2 = reader.read(realBuf);
    expect(n2).toBe(3);
    expect(Array.from(realBuf.subarray(0, n2))).toEqual([1, 2, 3]);
  });
});
