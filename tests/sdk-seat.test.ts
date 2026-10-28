import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { advisorTransportError, callAdvisor } from "../src/backend.js";
import { preflightSdkBackend, type SdkBackendConfig } from "../src/sdk-backend.js";
import { runCouncil } from "../src/council.js";
import { runDebate } from "../src/debate.js";
import type { BpxCouncilConfig } from "../src/config.js";

const service = vi.hoisted(() => ({
	preflight: vi.fn(), call: vi.fn(),
}));
vi.mock("../src/sdk-provider-service.js", () => ({ getSdkProviderService: () => service }));
beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BPX_COUNCIL_MODEL", ""); vi.stubEnv("ANTHROPIC_MODEL", "");
	service.preflight.mockImplementation(route => route.model === "unknown" ? { ok: false, error: "SDK model unavailable", revision: "account-1" } : { ok: true, revision: "account-1" });
	service.call.mockResolvedValue({ ok: true, text: "Answer", usage: { inputTokens: 2, outputTokens: 3 } });
});
afterEach(() => vi.unstubAllEnvs());

/** Create explicit SDK transport config. @returns Pinned backend. */
function backend(): SdkBackendConfig { return { type: "sdk", provider: "openai", model: "gpt-5-mini", effort: "low" }; }
/** Create SDK mode config. @returns Shared route with independent SDK critic. */
function config(): BpxCouncilConfig {
	return { defaultMode: "council", solo: { backend: backend() }, council: { members: ["architect", "critic"], backends: { critic: "sdk:anthropic:claude-model@high" }, synthesizer: "sdk:openai:verdict@medium" } };
}

describe("SDK transport dispatch", () => {
	it("passes exact model, effort and bounds into service, without host model translation", async () => {
		const route = { ...backend(), timeoutMs: 321, maxOutputTokens: 87, maxOutputBytes: 456 };
		const signal = new AbortController().signal;
		expect(await callAdvisor("System", "Question", route, signal)).toMatchObject({ ok: true, text: "Answer", usage: { inputTokens: 2, outputTokens: 3 } });
		expect(service.call).toHaveBeenCalledWith({ provider: "openai", model: "gpt-5-mini", effort: "low", systemPrompt: "System", userMessage: "Question", timeoutMs: 321, maxOutputTokens: 87, maxOutputBytes: 456, expectedRevision: "account-1" }, signal);
	});
	it("never starts inference when local preflight refuses", async () => {
		service.preflight.mockReturnValue({ ok: false, error: "SDK account missing", revision: "missing" });
		expect(advisorTransportError(backend())).toBe("SDK account missing");
		expect(await callAdvisor("S", "Q", backend())).toMatchObject({ ok: false, error: "SDK account missing" });
		expect(service.call).not.toHaveBeenCalled();
	});
	it.each([{ model: undefined }, { effort: "ultra" }, { images: ["image.png"] }, { timeoutMs: 0 }, { timeoutMs: 600_001 }, { maxOutputTokens: 128_001 }, { maxOutputBytes: 4 * 1024 * 1024 + 1 }])("rejects invalid route before service call: %o", fields => {
		expect(preflightSdkBackend({ ...backend(), ...fields }).ok).toBe(false);
		expect(service.call).not.toHaveBeenCalled(); expect(service.preflight).not.toHaveBeenCalled();
	});
	it("propagates owned cancellation and waits for service cleanup rather than racing result", async () => {
		const abort = new AbortController();
		let release!: () => void;
		service.call.mockImplementation((_request, signal: AbortSignal) => new Promise(resolve => {
			signal.addEventListener("abort", () => { release = () => resolve({ ok: false, text: "", error: "Advisor call cancelled" }); });
		}));
		let settled = false;
		const pending = callAdvisor("S", "Q", backend(), abort.signal).then(result => { settled = true; return result; });
		abort.abort(); await Promise.resolve(); expect(settled).toBe(false);
		release(); expect(await pending).toMatchObject({ ok: false, error: "Advisor call cancelled" });
	});
	it("pre-aborted calls do no preflight or inference", async () => {
		expect(await callAdvisor("S", "Q", backend(), AbortSignal.abort())).toMatchObject({ ok: false });
		expect(service.call).not.toHaveBeenCalled(); expect(service.preflight).not.toHaveBeenCalled();
	});
	it("keeps thrown SDK errors private", async () => {
		service.call.mockRejectedValue({ credential: "secret", message: "raw secret" });
		expect(await callAdvisor("S", "Q", backend())).toEqual({ ok: false, text: "", error: "SDK advisor call failed" });
	});
});

describe("SDK independent seats and partial output", () => {
	it("dispatches each member and verdict with its own provider/model/effort", async () => {
		const result = await runCouncil({ question: "Q", config: config() });
		expect(result.ok).toBe(true);
		expect(service.call.mock.calls.map(([request]) => [request.provider, request.model, request.effort])).toEqual([["openai", "gpt-5-mini", "low"], ["anthropic", "claude-model", "high"], ["openai", "verdict", "medium"]]);
		if (result.ok) expect(result.text).toContain("sdk:anthropic:claude-model@high");
	});
	it("batch preflight rejects later SDK seat with zero earlier calls", async () => {
		const draft = config(); draft.council!.synthesizer = "sdk:openai:unknown";
		await expect(runCouncil({ question: "Q", config: draft })).rejects.toThrow("SDK model unavailable");
		expect(service.call).not.toHaveBeenCalled();
		await expect(runDebate({ question: "Q", config: draft, critic: "sdk:openai:unknown" })).rejects.toThrow("SDK model unavailable");
		expect(service.call).not.toHaveBeenCalled();
	});
	it("image-bearing SDK seat rejects before any seat starts", async () => {
		await expect(runCouncil({ question: "Q", config: config(), seatOptions: { images: ["image.png"] } })).rejects.toThrow(/SDK.*image/);
		expect(service.call).not.toHaveBeenCalled();
	});
	it("retains completed council members if SDK synthesis fails", async () => {
		service.call.mockImplementation(request => Promise.resolve(request.model === "verdict" ? { ok: false, text: "", error: "SDK timeout" } : { ok: true, text: `Answer ${request.model}` }));
		const result = await runCouncil({ question: "Q", config: config() });
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) { expect(result.partial).toContain("Answer gpt-5-mini"); expect(result.partial).toContain("Answer claude-model"); }
	});
	it("retains completed SDK debate turn after critic failure", async () => {
		service.call.mockResolvedValueOnce({ ok: true, text: "Completed advocate" }).mockResolvedValueOnce({ ok: false, text: "", error: "SDK timeout" });
		const result = await runDebate({ question: "Q", config: config(), critic: "sdk:anthropic:claude-model@high", rounds: 1 });
		expect(result).toMatchObject({ ok: false });
		if (!result.ok) expect(result.partial).toContain("Completed advocate");
		expect(service.call).toHaveBeenCalledTimes(2);
	});
});
