/**
 * SharedArrayBuffer-backed ring buffer for inter-Worker pipe communication.
 *
 * Layout (all Int32-aligned):
 *   [0]  writePos   - total bytes written (monotonic)
 *   [1]  readPos    - total bytes read (monotonic)
 *   [2]  closed     - 0 = open, 1 = writer closed (EOF)
 *   [3]  reserved
 *   [16..] data     - ring buffer payload
 *
 * Protocol:
 *   Writer: writes to data[writePos % capacity], blocks if full (writePos - readPos >= capacity)
 *   Reader: reads from data[readPos % capacity], blocks if empty (readPos >= writePos)
 *   EOF:    writer sets closed=1, notifies reader; reader returns 0 when empty+closed
 */

const HEADER_INTS = 4;      // 4 Int32 header fields
const HEADER_BYTES = HEADER_INTS * 4; // 16 bytes
const IDX_WRITE_POS = 0;
const IDX_READ_POS = 1;
const IDX_CLOSED = 2;

/** Timeout per Atomics.wait attempt (milliseconds). */
const WAIT_TIMEOUT_MS = 5000;
/** Maximum retry attempts before giving up. */
const MAX_RETRIES = 3;

/** Default ring buffer capacity (data portion): 64KB */
const DEFAULT_CAPACITY = 64 * 1024;

/**
 * Create a SharedArrayBuffer for use as a ring buffer.
 */
export function createRingBuffer(capacity: number = DEFAULT_CAPACITY): SharedArrayBuffer {
  const sab = new SharedArrayBuffer(HEADER_BYTES + capacity);
  // Header initialized to zero by default (writePos=0, readPos=0, closed=0)
  return sab;
}

/** Options for configuring ring buffer timeout behavior. */
export interface RingBufferOptions {
  /** Timeout per Atomics.wait attempt in ms (default: 5000). */
  waitTimeoutMs?: number;
  /** Max retries before giving up (default: 3). */
  maxRetries?: number;
}

/**
 * Writer end of a ring buffer pipe.
 */
export class RingBufferWriter {
  private _sab: SharedArrayBuffer;
  private _header: Int32Array;
  private _data: Uint8Array;
  private _capacity: number;
  private _waitTimeoutMs: number;
  private _maxRetries: number;

  constructor(sab: SharedArrayBuffer, options?: RingBufferOptions) {
    this._sab = sab;
    this._header = new Int32Array(sab, 0, HEADER_INTS);
    this._data = new Uint8Array(sab, HEADER_BYTES);
    this._capacity = this._data.length;
    this._waitTimeoutMs = options?.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
    this._maxRetries = options?.maxRetries ?? MAX_RETRIES;
  }

  /**
   * Write data into the ring buffer, blocking if full.
   */
  write(buf: Uint8Array, offset: number = 0, length?: number): number {
    const len = length ?? (buf.length - offset);
    let written = 0;
    let retries = 0;

    while (written < len) {
      const writePos = Atomics.load(this._header, IDX_WRITE_POS);
      const readPos = Atomics.load(this._header, IDX_READ_POS);
      const available = this._capacity - (writePos - readPos);

      if (available <= 0) {
        // Buffer full — wait for reader to consume (with timeout)
        const result = Atomics.wait(this._header, IDX_READ_POS, readPos, this._waitTimeoutMs);
        if (result === 'timed-out') {
          retries++;
          if (retries >= this._maxRetries) {
            // Reader is dead — close buffer and signal EOF
            this.close();
            return written;
          }
          continue;
        }
        retries = 0; // Reset on successful wait
        continue;
      }

      retries = 0; // Reset when making progress
      const chunk = Math.min(len - written, available);

      // Write into ring buffer (may wrap around)
      for (let i = 0; i < chunk; i++) {
        this._data[(writePos + i) % this._capacity] = buf[offset + written + i];
      }

      // Advance write position and notify reader
      Atomics.store(this._header, IDX_WRITE_POS, writePos + chunk);
      Atomics.notify(this._header, IDX_WRITE_POS);
      written += chunk;
    }

    return written;
  }

  /**
   * Signal EOF — no more data will be written.
   */
  close(): void {
    Atomics.store(this._header, IDX_CLOSED, 1);
    Atomics.notify(this._header, IDX_WRITE_POS); // wake reader
  }
}

/**
 * Reader end of a ring buffer pipe.
 */
export class RingBufferReader {
  private _sab: SharedArrayBuffer;
  private _header: Int32Array;
  private _data: Uint8Array;
  private _capacity: number;
  private _waitTimeoutMs: number;
  private _maxRetries: number;

  constructor(sab: SharedArrayBuffer, options?: RingBufferOptions) {
    this._sab = sab;
    this._header = new Int32Array(sab, 0, HEADER_INTS);
    this._data = new Uint8Array(sab, HEADER_BYTES);
    this._capacity = this._data.length;
    this._waitTimeoutMs = options?.waitTimeoutMs ?? WAIT_TIMEOUT_MS;
    this._maxRetries = options?.maxRetries ?? MAX_RETRIES;
  }

  /**
   * Read data from the ring buffer, blocking if empty.
   * Returns 0 on EOF.
   */
  read(buf: Uint8Array, offset: number = 0, length?: number): number {
    const maxLen = length ?? (buf.length - offset);
    let retries = 0;

    while (true) {
      const writePos = Atomics.load(this._header, IDX_WRITE_POS);
      const readPos = Atomics.load(this._header, IDX_READ_POS);
      const available = writePos - readPos;

      if (available > 0) {
        const chunk = Math.min(maxLen, available);

        // Read from ring buffer (may wrap around)
        for (let i = 0; i < chunk; i++) {
          buf[offset + i] = this._data[(readPos + i) % this._capacity];
        }

        // Advance read position and notify writer
        Atomics.store(this._header, IDX_READ_POS, readPos + chunk);
        Atomics.notify(this._header, IDX_READ_POS);
        return chunk;
      }

      // Buffer empty — check if closed
      if (Atomics.load(this._header, IDX_CLOSED) === 1) {
        return 0; // EOF
      }

      // Wait for writer to produce data (with timeout)
      const result = Atomics.wait(this._header, IDX_WRITE_POS, writePos, this._waitTimeoutMs);
      if (result === 'timed-out') {
        retries++;
        if (retries >= this._maxRetries) {
          // Writer is dead — signal EOF by closing the buffer
          Atomics.store(this._header, IDX_CLOSED, 1);
          Atomics.notify(this._header, IDX_WRITE_POS);
          return 0; // EOF
        }
        continue;
      }
      retries = 0; // Reset on successful wait
    }
  }
}
