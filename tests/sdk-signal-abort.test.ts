import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { callAdvisor } from "../src/backend.js";
import { runSolo } from "../src/solo.js";
import { runCouncil } from "../src/council.js";
import { runDebate } from "../src/debate.js";
import { runInvocation } from "../src/invocation-lifecycle.js";
import { newReceipt, addAttempt, settleReceipt } from "../src/receipt.js";
import type { BackendConfig } from "../src/backend.js";
const service = vi.hoisted(() => ({ preflight: vi.fn(), call: vi.fn(), settle: vi.fn(async () => undefined) }));
vi.mock("../src/sdk-provider-service.js", () => ({ getSdkProviderService: () => service }));
let revision = "original";
const backend: BackendConfig = { type: "sdk", provider: "anthropic", model: "claude-sonnet-4-6", effort: "low" };
const config = { defaultMode: "solo" as const, solo: { backend }, council: { members: ["architect", "critic"] } };
beforeEach(() => {
	vi.clearAllMocks(); revision = "original";
	vi.stubEnv("BPX_COUNCIL_MODEL", ""); vi.stubEnv("ANTHROPIC_MODEL", "");
	service.preflight.mockImplementation(() => ({ ok: true, revision }));
	service.call.mockResolvedValue({ ok: true, text: "Earned answer" });
});
afterEach(() => { vi.unstubAllEnvs(); process.exitCode = undefined; });

/** Build receipt callbacks for one invocation. @returns Receipt and mode hooks. */
function tracked() {
	const receipt = newReceipt();
	return { receipt, onPlan: (seats: typeof receipt.planned) => { receipt.planned = seats; }, onAttempt: (attempt: Parameters<typeof addAttempt>[1]) => addAttempt(receipt, attempt) };
}

describe("mode cancellation and account authority", () => {
	it.each(["solo", "council", "debate"])("pre-aborted %s makes zero calls and accounts skipped seats", async mode => {
		const abort = new AbortController(); abort.abort(); const hooks = tracked();
		const input = { config, backend, question: "Question", signal: abort.signal, ...hooks };
		const result = mode === "solo" ? await runSolo(input) : mode === "council" ? await runCouncil(input) : await runDebate({ ...input, rounds: 2 });
		expect(result.ok).toBe(false); expect(service.call).not.toHaveBeenCalled();
		const receipt = settleReceipt(hooks.receipt, result);
		expect(receipt.attempts).toHaveLength(0); expect(receipt.notRun).toEqual(receipt.planned);
		expect(receipt.planned.length).toBe(mode === "solo" ? 1 : mode === "council" ? 3 : 5);
	});
	it("debate cancellation retains completed advocate, skips critic/later rounds/verdict", async () => {
		const abort = new AbortController(); const hooks = tracked();
		service.call.mockImplementationOnce(async (_request, signal) => { expect(signal).toBe(abort.signal); abort.abort(); return { ok: true, text: "Earned first turn" }; });
		const result = await runDebate({ config, backend, question: "Q", rounds: 2, signal: abort.signal, ...hooks });
		expect(service.call).toHaveBeenCalledTimes(1); expect(result).toMatchObject({ ok: false, partial: expect.stringContaining("Earned first turn") });
		const receipt = settleReceipt(hooks.receipt, result);
		expect(receipt.status).toBe("partial"); expect(receipt.notRun).toEqual([{ seat: "critic", round: 1 }, { seat: "advocate", round: 2 }, { seat: "critic", round: 2 }, { seat: "synthesizer", round: null }]);
	});
	it("council waits aborted member cleanup, retains earned answer and never synthesizes", async () => {
		const abort = new AbortController(); const hooks = tracked(); let release!: () => void;
		service.call.mockResolvedValueOnce({ ok: true, text: "Earned member" }).mockImplementationOnce((_request, signal: AbortSignal) => new Promise(resolve => {
			signal.addEventListener("abort", () => { release = () => resolve({ ok: false, text: "", error: "cancelled" }); });
		}));
		let done = false; const pending = runCouncil({ config, backend, question: "Q", signal: abort.signal, ...hooks }).then(value => { done = true; return value; });
		await Promise.resolve(); abort.abort(); await Promise.resolve(); expect(done).toBe(false); release();
		const result = await pending; expect(result).toMatchObject({ ok: false, partial: expect.stringContaining("Earned member") }); expect(service.call).toHaveBeenCalledTimes(2);
		const receipt = settleReceipt(hooks.receipt, result); expect(receipt.status).toBe("partial"); expect(receipt.notRun).toEqual([{ seat: "synthesizer", round: null }]);
	});
	it("account replacement after first debate turn cannot bill next seat", async () => {
		service.call.mockImplementationOnce(async request => { expect(request.expectedRevision).toBe("original"); revision = "replacement"; return { ok: true, text: "Earned old account" }; });
		const result = await runDebate({ config, backend, question: "Q", rounds: 2 });
		expect(service.call).toHaveBeenCalledTimes(1); expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reconfirm"), partial: expect.stringContaining("Earned old account") });
	});
	it("account replacement after council members cannot replace frozen synthesis authority", async () => {
		service.call.mockImplementation(async request => { expect(request.expectedRevision).toBe("original"); revision = "replacement"; return { ok: true, text: "Earned member" }; });
		const result = await runCouncil({ config, backend, question: "Q" });
		expect(service.call).toHaveBeenCalledTimes(1); expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reconfirm"), partial: expect.stringContaining("Earned member") });
	});
	it("wrapper rejects supplied old generation without replacing it", async () => {
		revision = "replacement";
		expect(await callAdvisor("Persona", "Q", backend, undefined, { sdkAccountRevision: "original" })).toMatchObject({ ok: false, error: expect.stringContaining("reconfirm") });
		expect(service.call).not.toHaveBeenCalled();
	});
});

describe("inference SIGINT gate", () => {
	it("repeated interrupts retain handler through call, storage drain and output publication", async () => {
		const initial = process.listenerCount("SIGINT"); let releaseCall!: () => void; let releaseStore!: () => void; let releaseOutput!: () => void;
		const pending = runInvocation(signal => new Promise<void>(resolve => { signal.addEventListener("abort", () => { releaseCall = resolve; }); }), () => new Promise(resolve => { releaseStore = resolve; }), () => new Promise(resolve => { releaseOutput = resolve; }));
		process.emit("SIGINT"); process.emit("SIGINT"); expect(process.listenerCount("SIGINT")).toBe(initial + 1);
		releaseCall(); await vi.waitFor(() => expect(releaseStore).toBeTypeOf("function")); process.emit("SIGINT"); releaseStore();
		await vi.waitFor(() => expect(releaseOutput).toBeTypeOf("function")); process.emit("SIGINT"); expect(process.listenerCount("SIGINT")).toBe(initial + 1); releaseOutput();
		expect(await pending).toMatchObject({ cancelled: true }); expect(process.exitCode).toBe(130); expect(process.listenerCount("SIGINT")).toBe(initial);
	});
	it("work exception still drains storage and removes SIGINT handler", async () => {
		const initial = process.listenerCount("SIGINT"); const settle = vi.fn(async () => undefined);
		await expect(runInvocation(async () => { throw new Error("Fixture failure"); }, settle)).rejects.toThrow("Fixture failure");
		expect(settle).toHaveBeenCalledTimes(1); expect(process.listenerCount("SIGINT")).toBe(initial);
	});
});
