import { afterEach, describe, expect, it } from "vitest";
import {
	allowAllFs,
	allowAllNetwork,
	NodeRuntime,
	createInMemoryFileSystem,
} from "../../../src/index.js";
import type { NetworkAdapter } from "../../../src/types.js";
import { createTestNodeRuntime } from "../../test-utils.js";

const DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES = 16 * 1024 * 1024;
const DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES = 4 * 1024 * 1024;
const MAX_CONFIGURED_PAYLOAD_BYTES = 64 * 1024 * 1024;
const PAYLOAD_LIMIT_ERROR_CODE = "ERR_SANDBOX_PAYLOAD_TOO_LARGE";

type CapturedConsoleEvent = {
	channel: "stdout" | "stderr";
	message: string;
};

function formatConsoleChannel(
	events: CapturedConsoleEvent[],
	channel: CapturedConsoleEvent["channel"],
): string {
	const lines = events
		.filter((event) => event.channel === channel)
		.map((event) => event.message);
	return lines.join("\n") + (lines.length > 0 ? "\n" : "");
}

function createConsoleCapture() {
	const events: CapturedConsoleEvent[] = [];
	return {
		onStdio: (event: CapturedConsoleEvent) => {
			events.push(event);
		},
		stdout: () => formatConsoleChannel(events, "stdout"),
	};
}

function bytesOverBase64Limit(limitBytes: number): number {
	return Math.floor(limitBytes / 4) * 3 + 1;
}

function createEchoNetworkAdapter(): NetworkAdapter {
	return {
		async fetch(url, options) {
			return {
				ok: true,
				status: 200,
				statusText: "OK",
				headers: {},
				body: options.body ?? "",
				url,
				redirected: false,
			};
		},
		async dnsLookup() {
			return { address: "127.0.0.1", family: 4 };
		},
		async httpRequest(url, options) {
			return {
				status: 200,
				statusText: "OK",
				headers: {},
				body: options.body ?? "",
				url,
			};
		},
	};
}

describe("NodeRuntime payload limits", () => {
	let proc: NodeRuntime | undefined;

	afterEach(() => {
		proc?.dispose();
		proc = undefined;
	});

	it("preserves in-limit binary read/write behavior", async () => {
		const fs = createInMemoryFileSystem();
		const payload = new Uint8Array([0, 1, 2, 3, 255]);
		await fs.mkdir("/data");
		await fs.writeFile("/data/source.bin", payload);

		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({
			filesystem: fs,
			permissions: allowAllFs,
			onStdio: capture.onStdio,
		});
		const result = await proc.exec(`
      const fs = require('fs');
      const input = fs.readFileSync('/data/source.bin');
      fs.writeFileSync('/data/copy.bin', input);
      console.log(input.length);
    `);

		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("5\n");

		const copied = await fs.readFile("/data/copy.bin");
		expect(Array.from(copied)).toEqual(Array.from(payload));
	});

	it("rejects oversized binary reads before returning base64 payloads", async () => {
		const fs = createInMemoryFileSystem();
		const oversizedRawBytes = bytesOverBase64Limit(
			DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES,
		);
		await fs.mkdir("/data");
		await fs.writeFile("/data/too-large-read.bin", new Uint8Array(oversizedRawBytes));

		proc = createTestNodeRuntime({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(`
      const fs = require('fs');
      fs.readFileSync('/data/too-large-read.bin');
    `);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain(PAYLOAD_LIMIT_ERROR_CODE);
		expect(result.errorMessage).toContain("fs.readFileBinary");
	});

	it("rejects oversized binary writes before base64 decode", async () => {
		const fs = createInMemoryFileSystem();
		const oversizedRawBytes = bytesOverBase64Limit(
			DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES,
		);
		await fs.mkdir("/data");

		proc = createTestNodeRuntime({ filesystem: fs, permissions: allowAllFs });
		const result = await proc.exec(`
      const fs = require('fs');
      fs.writeFileSync('/data/too-large-write.bin', Buffer.alloc(${oversizedRawBytes}));
    `);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain(PAYLOAD_LIMIT_ERROR_CODE);
		expect(result.errorMessage).toContain("fs.writeFileBinary");
		expect(await fs.exists("/data/too-large-write.bin")).toBe(false);
	});

	it("preserves in-limit JSON bridge payload parsing behavior", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({
			networkAdapter: createEchoNetworkAdapter(),
			permissions: allowAllNetwork,
			onStdio: capture.onStdio,
		});
		const result = await proc.exec(`
      (async () => {
        const response = await fetch('https://example.test/in-limit', {
          method: 'POST',
          body: 'ok',
        });
        console.log(await response.text());
      })();
    `);

		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("ok\n");
	});

	it("rejects oversized JSON payloads before host JSON.parse", async () => {
		proc = createTestNodeRuntime({
			networkAdapter: createEchoNetworkAdapter(),
			permissions: allowAllNetwork,
		});
		const result = await proc.exec(`
      (async () => {
        const body = 'x'.repeat(${DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES + 1024});
        await fetch('https://example.test/too-large', {
          method: 'POST',
          body,
        });
      })();
    `);

		expect(result.code).toBe(1);
		expect(result.errorMessage).toContain(PAYLOAD_LIMIT_ERROR_CODE);
		expect(result.errorMessage).toContain("network.fetch options");
	});

	it("allows larger base64 payloads with in-range configured limits", async () => {
		const fs = createInMemoryFileSystem();
		const oversizedRawBytes = bytesOverBase64Limit(
			DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES,
		);
		await fs.mkdir("/data");

		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({
			filesystem: fs,
			permissions: allowAllFs,
			onStdio: capture.onStdio,
			payloadLimits: {
				base64TransferBytes: DEFAULT_BRIDGE_BASE64_TRANSFER_BYTES + 4096,
			},
		});
		const result = await proc.exec(`
      const fs = require('fs');
      fs.writeFileSync('/data/large-configured.bin', Buffer.alloc(${oversizedRawBytes}));
      console.log('ok');
    `);

		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("ok\n");
		const stored = await fs.readFile("/data/large-configured.bin");
		expect(stored.byteLength).toBe(oversizedRawBytes);
	});

	it("allows larger JSON payloads with in-range configured limits", async () => {
		const capture = createConsoleCapture();
		proc = createTestNodeRuntime({
			networkAdapter: createEchoNetworkAdapter(),
			permissions: allowAllNetwork,
			onStdio: capture.onStdio,
			payloadLimits: {
				jsonPayloadBytes: DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES + 4096,
			},
		});
		const result = await proc.exec(`
      (async () => {
        const body = 'x'.repeat(${DEFAULT_ISOLATE_JSON_PAYLOAD_BYTES + 1024});
        await fetch('https://example.test/configured', { method: 'POST', body });
        console.log('ok');
      })();
    `);

		expect(result.code).toBe(0);
		expect(result).not.toHaveProperty("stdout");
		expect(capture.stdout()).toBe("ok\n");
	});

	it("rejects out-of-range payload limit configuration", () => {
		expect(
			() => createTestNodeRuntime({ payloadLimits: { jsonPayloadBytes: 0 } }),
		).toThrow(RangeError);
		expect(
			() =>
				createTestNodeRuntime({
					payloadLimits: {
						base64TransferBytes: MAX_CONFIGURED_PAYLOAD_BYTES + 1,
					},
				}),
		).toThrow(RangeError);
	});
});
