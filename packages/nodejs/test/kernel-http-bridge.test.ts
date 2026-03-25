import { describe, expect, it } from "vitest";
import { deserialize } from "node:v8";
import { SocketTable, type PermissionDecision } from "@secure-exec/core";
import { HOST_BRIDGE_GLOBAL_KEYS } from "../src/bridge-contract.ts";
import {
	buildNetworkBridgeHandlers,
	resolveHttpServerResponse,
} from "../src/bridge-handlers.ts";
import { createDefaultNetworkAdapter } from "../src/default-network-adapter.ts";
import { createNodeHostNetworkAdapter } from "../src/host-network-adapter.ts";
import { createBudgetState } from "../src/isolate-bootstrap.ts";

const allowAll = (): PermissionDecision => ({ allow: true });

describe("kernel HTTP bridge", () => {
	it("serves host-side HTTP requests through the kernel-backed listener", async () => {
		const adapter = createDefaultNetworkAdapter();
		const socketTable = new SocketTable({
			hostAdapter: createNodeHostNetworkAdapter(),
			networkCheck: allowAll,
		});

		const result = buildNetworkBridgeHandlers({
			networkAdapter: adapter,
			budgetState: createBudgetState(),
			isolateJsonPayloadLimitBytes: 1024 * 1024,
			activeHttpServerIds: new Set(),
			activeHttpServerClosers: new Map(),
			pendingHttpServerStarts: { count: 0 },
			sendStreamEvent(eventType, payload) {
				if (eventType !== "http_request") return;
				const event = deserialize(Buffer.from(payload)) as {
					requestId: number;
					serverId: number;
				};
				resolveHttpServerResponse({
					requestId: event.requestId,
					serverId: event.serverId,
					responseJson: JSON.stringify({
						status: 200,
						headers: [["content-type", "text/plain"]],
						body: "bridge-ok",
						bodyEncoding: "utf8",
					}),
				});
			},
			socketTable,
			pid: 1,
		});

		const listenRaw = result.handlers[HOST_BRIDGE_GLOBAL_KEYS.networkHttpServerListenRaw];
		const closeRaw = result.handlers[HOST_BRIDGE_GLOBAL_KEYS.networkHttpServerCloseRaw];
		const listenResult = await Promise.resolve(
			listenRaw(JSON.stringify({ serverId: 1, hostname: "127.0.0.1", port: 0 })),
		);
		const { address } = JSON.parse(String(listenResult)) as {
			address: { address: string; port: number } | null;
		};

		if (!address) {
			throw new Error("expected kernel listener address");
		}

		try {
			const httpResponse = await Promise.race([
				adapter.httpRequest(`http://127.0.0.1:${address.port}/`, { method: "GET" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("httpRequest timed out")), 1000),
				),
			]);

			expect(httpResponse.status).toBe(200);
			expect(httpResponse.body).toBe("bridge-ok");

			const fetchResponse = await Promise.race([
				adapter.fetch(`http://127.0.0.1:${address.port}/`, { method: "GET" }),
				new Promise<never>((_, reject) =>
					setTimeout(() => reject(new Error("fetch timed out")), 1000),
				),
			]);

			expect(fetchResponse.status).toBe(200);
			expect(fetchResponse.body).toBe("bridge-ok");
		} finally {
			await Promise.resolve(closeRaw(1));
			await result.dispose();
		}
	});
});
