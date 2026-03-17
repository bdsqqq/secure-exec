/**
 * PTY manager.
 *
 * Allocates pseudo-terminal master/slave pairs with bidirectional data flow.
 * Writing to master → readable from slave (input direction).
 * Writing to slave → readable from master (output direction).
 * Follows the same FileDescription/refCount pattern as PipeManager.
 */

import type { FileDescription } from "./types.js";
import {
	FILETYPE_CHARACTER_DEVICE,
	O_RDWR,
	KernelError,
	SIGINT,
	SIGQUIT,
	SIGTSTP,
} from "./types.js";
import type { ProcessFDTable } from "./fd-table.js";

export interface LineDisciplineConfig {
	/** Canonical mode: buffer input until newline, handle backspace. */
	canonical: boolean;
	/** Echo input bytes back through output (master reads them). */
	echo: boolean;
	/** Enable signal generation from control chars (^C, ^Z, ^\). */
	isig: boolean;
}

export interface PtyEnd {
	description: FileDescription;
	filetype: typeof FILETYPE_CHARACTER_DEVICE;
}

interface PtyState {
	id: number;
	path: string; // /dev/pts/N
	masterDescription: FileDescription;
	slaveDescription: FileDescription;
	/** Data written to master, readable from slave (input direction) */
	inputBuffer: Uint8Array[];
	/** Data written to slave, readable from master (output direction) */
	outputBuffer: Uint8Array[];
	closed: { master: boolean; slave: boolean };
	/** Resolves waiting for input data (slave reads) */
	inputWaiters: Array<(data: Uint8Array | null) => void>;
	/** Resolves waiting for output data (master reads) */
	outputWaiters: Array<(data: Uint8Array | null) => void>;
	/** Line discipline configuration */
	discipline: LineDisciplineConfig;
	/** Canonical mode line editing buffer */
	lineBuffer: number[];
	/** Foreground process group for signal delivery */
	foregroundPgid: number;
}

let nextPtyId = 0;
let nextPtyDescId = 200_000; // High range to avoid FD/pipe ID collisions

export class PtyManager {
	private ptys: Map<number, PtyState> = new Map();
	/** Map description ID → pty ID and which end */
	private descToPty: Map<number, { ptyId: number; end: "master" | "slave" }> = new Map();
	/** Callback for signal delivery (pgid, signal) */
	private onSignal: ((pgid: number, signal: number) => void) | null;

	constructor(onSignal?: (pgid: number, signal: number) => void) {
		this.onSignal = onSignal ?? null;
	}

	/**
	 * Allocate a PTY pair. Returns two FileDescriptions:
	 * one for the master and one for the slave.
	 */
	createPty(): { master: PtyEnd; slave: PtyEnd; path: string } {
		const id = nextPtyId++;
		const path = `/dev/pts/${id}`;

		const masterDesc: FileDescription = {
			id: nextPtyDescId++,
			path: `pty:${id}:master`,
			cursor: 0n,
			flags: O_RDWR,
			refCount: 0, // openWith() will bump
		};

		const slaveDesc: FileDescription = {
			id: nextPtyDescId++,
			path: path,
			cursor: 0n,
			flags: O_RDWR,
			refCount: 0, // openWith() will bump
		};

		const state: PtyState = {
			id,
			path,
			masterDescription: masterDesc,
			slaveDescription: slaveDesc,
			inputBuffer: [],
			outputBuffer: [],
			closed: { master: false, slave: false },
			inputWaiters: [],
			outputWaiters: [],
			discipline: { canonical: false, echo: false, isig: false },
			lineBuffer: [],
			foregroundPgid: 0,
		};

		this.ptys.set(id, state);
		this.descToPty.set(masterDesc.id, { ptyId: id, end: "master" });
		this.descToPty.set(slaveDesc.id, { ptyId: id, end: "slave" });

		return {
			master: { description: masterDesc, filetype: FILETYPE_CHARACTER_DEVICE },
			slave: { description: slaveDesc, filetype: FILETYPE_CHARACTER_DEVICE },
			path,
		};
	}

	/**
	 * Write data to a PTY end.
	 * Master write → slave can read (input direction).
	 * Slave write → master can read (output direction).
	 */
	write(descriptionId: number, data: Uint8Array): number {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) throw new KernelError("EBADF", "not a PTY end");

		const state = this.ptys.get(ref.ptyId);
		if (!state) throw new KernelError("EBADF", "PTY not found");

		if (ref.end === "master") {
			// Master write → input direction, processed through line discipline
			if (state.closed.master) throw new KernelError("EIO", "master closed");
			if (state.closed.slave) throw new KernelError("EIO", "slave closed");
			return this.processInput(state, data);
		} else {
			// Slave write → output buffer (master reads)
			if (state.closed.slave) throw new KernelError("EIO", "slave closed");
			if (state.closed.master) throw new KernelError("EIO", "master closed");

			if (state.outputWaiters.length > 0) {
				const waiter = state.outputWaiters.shift()!;
				waiter(data);
			} else {
				state.outputBuffer.push(new Uint8Array(data));
			}
		}

		return data.length;
	}

	/**
	 * Read data from a PTY end.
	 * Master read → data written by slave (output direction).
	 * Slave read → data written by master (input direction).
	 * Returns null on hangup (other end closed).
	 */
	read(descriptionId: number, length: number): Promise<Uint8Array | null> {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) throw new KernelError("EBADF", "not a PTY end");

		const state = this.ptys.get(ref.ptyId);
		if (!state) throw new KernelError("EBADF", "PTY not found");

		if (ref.end === "master") {
			// Master reads from output buffer (data written by slave)
			if (state.closed.master) throw new KernelError("EIO", "master closed");

			if (state.outputBuffer.length > 0) {
				return Promise.resolve(this.drainBuffer(state.outputBuffer, length));
			}
			// Slave closed → EIO (terminal hangup)
			if (state.closed.slave) {
				return Promise.resolve(null);
			}
			return new Promise((resolve) => {
				state.outputWaiters.push(resolve);
			});
		} else {
			// Slave reads from input buffer (data written by master)
			if (state.closed.slave) throw new KernelError("EIO", "slave closed");

			if (state.inputBuffer.length > 0) {
				return Promise.resolve(this.drainBuffer(state.inputBuffer, length));
			}
			// Master closed → EIO (terminal hangup)
			if (state.closed.master) {
				return Promise.resolve(null);
			}
			return new Promise((resolve) => {
				state.inputWaiters.push(resolve);
			});
		}
	}

	/** Close one end of a PTY. */
	close(descriptionId: number): void {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) return;

		const state = this.ptys.get(ref.ptyId);
		if (!state) return;

		if (ref.end === "master") {
			state.closed.master = true;
			// Notify blocked slave readers with null (EIO / hangup)
			for (const waiter of state.inputWaiters) {
				waiter(null);
			}
			state.inputWaiters.length = 0;
		} else {
			state.closed.slave = true;
			// Notify blocked master readers with null (EIO / hangup)
			for (const waiter of state.outputWaiters) {
				waiter(null);
			}
			state.outputWaiters.length = 0;
		}

		this.descToPty.delete(descriptionId);

		// Clean up when both ends closed
		if (state.closed.master && state.closed.slave) {
			this.ptys.delete(ref.ptyId);
		}
	}

	/** Check if a description ID belongs to a PTY. */
	isPty(descriptionId: number): boolean {
		return this.descToPty.has(descriptionId);
	}

	/** Check if a description ID is a PTY slave (terminal). */
	isSlave(descriptionId: number): boolean {
		const ref = this.descToPty.get(descriptionId);
		return ref?.end === "slave";
	}

	/**
	 * Allocate PTY FDs in the given FD table.
	 * Returns master/slave FD numbers and the /dev/pts/N path.
	 */
	createPtyFDs(fdTable: ProcessFDTable): { masterFd: number; slaveFd: number; path: string } {
		const { master, slave, path } = this.createPty();
		const masterFd = fdTable.openWith(master.description, master.filetype);
		const slaveFd = fdTable.openWith(slave.description, slave.filetype);
		return { masterFd, slaveFd, path };
	}

	/** Set line discipline options for the PTY containing this description. */
	setDiscipline(
		descriptionId: number,
		config: Partial<LineDisciplineConfig>,
	): void {
		const ptyId = this.getPtyId(descriptionId);
		const state = this.ptys.get(ptyId);
		if (!state) throw new KernelError("EBADF", "PTY not found");

		if (config.canonical !== undefined) state.discipline.canonical = config.canonical;
		if (config.echo !== undefined) state.discipline.echo = config.echo;
		if (config.isig !== undefined) state.discipline.isig = config.isig;
	}

	/** Set the foreground process group for signal delivery on this PTY. */
	setForegroundPgid(descriptionId: number, pgid: number): void {
		const ptyId = this.getPtyId(descriptionId);
		const state = this.ptys.get(ptyId);
		if (!state) throw new KernelError("EBADF", "PTY not found");
		state.foregroundPgid = pgid;
	}

	/** Get the PTY ID from a description ID. */
	private getPtyId(descriptionId: number): number {
		const ref = this.descToPty.get(descriptionId);
		if (!ref) throw new KernelError("EBADF", "not a PTY end");
		return ref.ptyId;
	}

	// -------------------------------------------------------------------
	// Line discipline input processing
	// -------------------------------------------------------------------

	/**
	 * Process input data through line discipline.
	 * Master writes go through here before reaching the slave's input buffer.
	 */
	private processInput(state: PtyState, data: Uint8Array): number {
		const { discipline } = state;

		// Fast path: no discipline processing (raw pass-through)
		if (!discipline.canonical && !discipline.echo && !discipline.isig) {
			this.deliverInput(state, data);
			return data.length;
		}

		// Process byte by byte through discipline
		for (const byte of data) {
			// Signal character handling (requires isig)
			if (discipline.isig) {
				const signal = this.signalForByte(byte);
				if (signal !== null) {
					if (discipline.canonical) state.lineBuffer.length = 0;
					if (state.foregroundPgid > 0) this.onSignal?.(state.foregroundPgid, signal);
					continue;
				}
			}

			if (discipline.canonical) {
				// ^D: EOF or flush
				if (byte === 0x04) {
					if (state.lineBuffer.length === 0) {
						this.deliverInput(state, new Uint8Array(0));
					} else {
						this.deliverInput(state, new Uint8Array(state.lineBuffer));
						state.lineBuffer.length = 0;
					}
					continue;
				}

				// Backspace / DEL: erase last char
				if (byte === 0x7f || byte === 0x08) {
					if (state.lineBuffer.length > 0) {
						state.lineBuffer.pop();
						if (discipline.echo) {
							this.echoOutput(state, new Uint8Array([0x08, 0x20, 0x08]));
						}
					}
					continue;
				}

				// Newline: flush line
				if (byte === 0x0a) {
					state.lineBuffer.push(0x0a);
					if (discipline.echo) this.echoOutput(state, new Uint8Array([0x0a]));
					this.deliverInput(state, new Uint8Array(state.lineBuffer));
					state.lineBuffer.length = 0;
					continue;
				}

				// Regular char: buffer
				state.lineBuffer.push(byte);
				if (discipline.echo) this.echoOutput(state, new Uint8Array([byte]));
			} else {
				// Raw mode: deliver immediately
				if (discipline.echo) this.echoOutput(state, new Uint8Array([byte]));
				this.deliverInput(state, new Uint8Array([byte]));
			}
		}

		return data.length;
	}

	/** Deliver input data to slave (input buffer / waiters). */
	private deliverInput(state: PtyState, data: Uint8Array): void {
		if (state.inputWaiters.length > 0) {
			const waiter = state.inputWaiters.shift()!;
			waiter(data);
		} else {
			state.inputBuffer.push(new Uint8Array(data));
		}
	}

	/** Echo data to output (master reads it back for display). */
	private echoOutput(state: PtyState, data: Uint8Array): void {
		if (state.outputWaiters.length > 0) {
			const waiter = state.outputWaiters.shift()!;
			waiter(data);
		} else {
			state.outputBuffer.push(new Uint8Array(data));
		}
	}

	/** Map control byte to signal number, or null if not a signal char. */
	private signalForByte(byte: number): number | null {
		switch (byte) {
			case 0x03: return SIGINT;   // ^C
			case 0x1a: return SIGTSTP;  // ^Z
			case 0x1c: return SIGQUIT;  // ^\
			default: return null;
		}
	}

	private drainBuffer(buffer: Uint8Array[], length: number): Uint8Array {
		const chunks: Uint8Array[] = [];
		let remaining = length;

		while (remaining > 0 && buffer.length > 0) {
			const chunk = buffer[0];
			if (chunk.length <= remaining) {
				chunks.push(chunk);
				remaining -= chunk.length;
				buffer.shift();
			} else {
				chunks.push(chunk.subarray(0, remaining));
				buffer[0] = chunk.subarray(remaining);
				remaining = 0;
			}
		}

		if (chunks.length === 1) return chunks[0];

		const total = chunks.reduce((sum, c) => sum + c.length, 0);
		const result = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			result.set(chunk, offset);
			offset += chunk.length;
		}
		return result;
	}
}
