import { afterEach, expect, it } from "vitest";
import type { NodeSuiteContext } from "./runtime.js";

export function runNodeNetworkSuite(context: NodeSuiteContext): void {
	afterEach(async () => {
		await context.teardown();
	});

	it("supports fetch through runtime network adapter", async () => {
		const runtime = await context.createRuntime();
		const result = await runtime.network.fetch(
			"data:text/plain,test-suite-network-ok",
		);
		expect(result.ok).toBe(true);
		expect(result.body).toContain("test-suite-network-ok");
	});

	it("keeps deterministic DNS lookup behavior per runtime target", async () => {
		const runtime = await context.createRuntime();
		const result = await runtime.network.dnsLookup("localhost");

		if (context.target === "browser") {
			expect(result).toEqual({
				error: "DNS not supported in browser",
				code: "ENOSYS",
			});
			return;
		}

		if ("error" in result) {
			throw new Error(`expected localhost DNS resolution, got: ${result.error}`);
		}
		expect(result.address.length).toBeGreaterThan(0);
	});
}
