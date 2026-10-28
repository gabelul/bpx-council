/** HTTP timeouts must cover the full response and release timers on every exit. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
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

	it("preaborted call never fetches or creates deadline", async () => {
		const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
		const controller = new AbortController(); controller.abort();
		expect(await callHttpAdvisor("system", "question", backend, 9000, controller.signal)).toMatchObject({ ok: false, error: "Advisor call cancelled" });
		expect(fetch).not.toHaveBeenCalled();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("propagates external abort to fetch and removes listener/deadline", async () => {
		const controller = new AbortController();
		const remove = vi.spyOn(controller.signal, "removeEventListener");
		let transport: AbortSignal | null | undefined;
		vi.stubGlobal("fetch", vi.fn((_url: unknown, init: RequestInit) => {
			transport = init.signal;
			return new Promise((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("do not echo secret"))));
		}));
		const pending = callHttpAdvisor("system", "question", backend, 9000, controller.signal);
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: "Advisor call cancelled", text: "" });
		expect(transport?.aborted).toBe(true);
		expect(remove).toHaveBeenCalledWith("abort", expect.any(Function));
		expect(vi.getTimerCount()).toBe(0);
	});

	it("aborts a stalled response body reader, not only request headers", async () => {
		const cancel = vi.fn();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(stream) { stream.enqueue(new TextEncoder().encode('{"content":[')); }, cancel }))));
		const controller = new AbortController();
		const pending = callHttpAdvisor("system", "question", backend, 9000, controller.signal);
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		expect(await pending).toMatchObject({ ok: false, error: "Advisor call cancelled" });
		expect(cancel).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(0);
	});

	it("awaits asynchronous response-body cancellation before returning", async () => {
		let release!: () => void;
		const cleanup = new Promise<void>((done) => { release = done; });
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel: () => cleanup }))));
		const controller = new AbortController();
		let settled = false;
		const pending = callHttpAdvisor("system", "question", backend, 9000, controller.signal).then((result) => { settled = true; return result; });
		await vi.advanceTimersByTimeAsync(0);
		controller.abort();
		await Promise.resolve();
		expect(settled).toBe(false);
		release();
		expect(await pending).toMatchObject({ ok: false, error: "Advisor call cancelled" });
		expect(vi.getTimerCount()).toBe(0);
	});

	it("bounds streamed body bytes and cancels oversized responses", async () => {
		const cancel = vi.fn();
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(new ReadableStream({ start(stream) { stream.enqueue(new Uint8Array(101)); }, cancel }))));
		expect(await callHttpAdvisor("system", "question", { ...backend, maxResponseBytes: 100 }, 9000)).toMatchObject({ ok: false, text: "", error: "anthropic HTTP response exceeded 100 bytes" });
		expect(cancel).toHaveBeenCalledTimes(1);
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

	it("aborts actual localhost socket while response body is still arriving", async () => {
		vi.useRealTimers();
		let bodyStarted!: () => void;
		let socketClosed!: () => void;
		const started = new Promise<void>((done) => { bodyStarted = done; });
		const closed = new Promise<void>((done) => { socketClosed = done; });
		const server = createServer((_request, response) => {
			response.on("close", socketClosed);
			response.writeHead(200, { "content-type": "application/json" });
			response.write('{"content":[');
			bodyStarted();
		});
		await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
		const port = (server.address() as AddressInfo).port;
		const controller = new AbortController();
		try {
			const pending = callHttpAdvisor("synthetic", "probe", { ...backend, baseUrl: `http://127.0.0.1:${port}` }, 2000, controller.signal);
			await started;
			controller.abort();
			expect(await pending).toMatchObject({ ok: false, text: "", error: "Advisor call cancelled" });
			await closed;
		} finally {
			controller.abort();
			server.closeAllConnections();
			await new Promise<void>((done) => server.close(() => done()));
		}
	});
});
