/** HTTP timeouts must cover the full response and release timers on every exit. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callHttpAdvisor } from "../src/http-backend.js";

const backend = { type: "http", provider: "anthropic", model: "test-model" } as const;
let previousKey: string | undefined;

beforeEach(() => {
	previousKey = process.env.ANTHROPIC_API_KEY;
	process.env.ANTHROPIC_API_KEY = "test-key";
	vi.useFakeTimers();
});

afterEach(() => {
	if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
	else process.env.ANTHROPIC_API_KEY = previousKey;
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("callHttpAdvisor timeout", () => {
	it("clears its deadline when fetch fails immediately", async () => {
		vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
		const result = await callHttpAdvisor("system", "question", backend, 9000);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("anthropic HTTP request failed");
		expect(vi.getTimerCount()).toBe(0);
	});

	it("keeps the deadline active through response-body reading", async () => {
		vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => Promise.resolve({
			ok: true,
			json: () => new Promise((_, reject) => {
				init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
			}),
		})));
		const pending = callHttpAdvisor("system", "question", backend, 50);
		await vi.advanceTimersByTimeAsync(50);
		const result = await pending;
		expect(result.error).toContain("timed out after 50ms");
		expect(vi.getTimerCount()).toBe(0);
	});
});
