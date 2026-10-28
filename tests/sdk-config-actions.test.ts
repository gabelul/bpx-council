import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultConfigActions as actions, resolveActionBackend } from "../src/config-actions.js";
import type { BpxCouncilConfig } from "../src/config.js";
import { ConfigDraft } from "../src/config-draft.js";
import type { SdkProviderService } from "../src/sdk-types.js";

const service = vi.hoisted(() => ({ preflight: vi.fn(), call: vi.fn(), inventory: vi.fn(() => []), catalog: vi.fn(() => []) }));
vi.mock("../src/sdk-provider-service.js", () => ({ getSdkProviderService: () => service }));
let revision = "account-1";
const advisor = { section: "advisor", role: "Advisor" } as const;
const member = { section: "council", role: "critic", member: true } as const;
const candidate = { name: "builder", stance: "neutral", systemPrompt: "Find practical trade-offs." };
beforeEach(() => {
	vi.clearAllMocks(); revision = "account-1";
	vi.stubEnv("BPX_COUNCIL_MODEL", ""); vi.stubEnv("ANTHROPIC_MODEL", "");
	service.preflight.mockImplementation(() => ({ ok: true, revision }));
	service.call.mockResolvedValue({ ok: true, text: "OK" });
});
afterEach(() => vi.unstubAllEnvs());

/** Build an unsaved direct SDK draft. @returns SDK config. */
function config(): BpxCouncilConfig {
	return { defaultMode: "solo", solo: { backend: { type: "sdk", provider: "openai", model: "gpt-5-mini", effort: "low", timeoutMs: 99_999 } } };
}
/** Create controller with local-only injected services. @param draft Settings. @returns Isolated controller. */
function controller(draft = config()): ConfigDraft {
	return new ConfigDraft(draft, { path: "test.json", scope: "global" }, [], { listModels: async () => [], listEfforts: async () => null }, actions, { inventory: () => [], check: async () => [] }, service as unknown as SdkProviderService);
}
/** Open explicit test confirmation without invoking transport. @param draft Controller. */
function confirmTest(draft: ConfigDraft): void { draft.pane = "detail"; draft.move("last"); draft.enter(); expect(draft.confirmation?.type).toBe("cost"); }
/** Confirm selected cost dialog. @param draft Controller. */
function runConfirmed(draft: ConfigDraft): void { draft.move("last"); draft.enter(); }
/** Wait for asynchronous work without cancelling it. @param draft Controller. @returns When operation clears. */
async function finished(draft: ConfigDraft): Promise<void> { await vi.waitFor(() => expect(draft.operation).toBeUndefined()); }

describe("SDK settings actions", () => {
	it("requires local SDK preflight for both actions, carrying opaque generation only", async () => {
		service.preflight.mockReturnValue({ ok: false, revision: "missing-account", error: "Store a Council account first." });
		expect(actions.preflight(config(), advisor, "test")).toMatchObject({ error: "Store a Council account first.", revision: "missing-account" });
		expect(actions.preflight(config(), advisor, "generate")).toMatchObject({ error: "Store a Council account first.", revision: "missing-account" });
		expect(await actions.test(config(), advisor, new AbortController().signal)).toMatchObject({ ok: false });
		expect(await actions.generate(config(), advisor, "Builder", new AbortController().signal)).toMatchObject({ ok: false });
		expect(service.call).not.toHaveBeenCalled();
	});
	it("tests unsaved exact pins and admitted SDK ceiling with byte/time bounds", async () => {
		const draft = config(); const before = structuredClone(draft);
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: true, route: "sdk:openai:gpt-5-mini@low", text: "Route responded." });
		expect(service.call).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai", model: "gpt-5-mini", effort: "low", timeoutMs: 15_000, maxOutputTokens: undefined, maxOutputBytes: 4096 }), expect.any(AbortSignal));
		expect(draft).toEqual(before);
	});
	it("supports strict persona JSON through supported SDK transport", async () => {
		service.call.mockResolvedValue({ ok: true, text: JSON.stringify(candidate) });
		expect(await actions.generate(config(), advisor, "Builder", new AbortController().signal)).toMatchObject({ ok: true, candidate });
		expect(service.call).toHaveBeenCalledWith(expect.objectContaining({ maxOutputTokens: undefined, maxOutputBytes: 32_768, timeoutMs: 45_000 }), expect.any(AbortSignal));
	});
	it("legacy ultra is not silently clamped for SDK; independent seat ignores inherited effort", async () => {
		const draft = config(); delete draft.solo.backend!.effort; draft.solo.thinkingLevel = "ultra";
		expect(actions.preflight(draft, advisor).error).toMatch(/ultra.*unsupported/);
		await actions.test(draft, advisor, new AbortController().signal); expect(service.call).not.toHaveBeenCalled();
		draft.council = { backends: { critic: "sdk:anthropic:claude-model@high" } };
		expect(resolveActionBackend(draft, member)).toMatchObject({ type: "sdk", provider: "anthropic", model: "claude-model", effort: "high" });
	});
	it("ambient host models never replace SDK pins, including independent seat", async () => {
		vi.stubEnv("ANTHROPIC_MODEL", "host-model");
		const draft = config(); draft.council = { backends: { critic: "sdk:anthropic:claude-model@high" } };
		expect(resolveActionBackend(draft, advisor).model).toBe("gpt-5-mini");
		expect(actions.preflight(draft, member).error).toMatch(/ambient model conflicts/);
		expect(await actions.test(draft, member, new AbortController().signal)).toMatchObject({ ok: false });
		expect(service.call).not.toHaveBeenCalled();
	});
	it.each(["test", "generate"] as const)("%s preserves confirmed generation through fresh wrapper preflight", async purpose => {
		revision = "replacement";
		const context = { sdkAccountRevision: "account-1" };
		const result = purpose === "test"
			? await actions.test(config(), advisor, new AbortController().signal, context)
			: await actions.generate(config(), advisor, "Builder", new AbortController().signal, context);
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("reconfirm") });
		expect(service.call).not.toHaveBeenCalled();
	});
	it("keeps SDK rejection objects private", async () => {
		service.preflight.mockImplementation(() => { throw { credentials: "private-account", message: "raw secret" }; });
		expect(actions.preflight(config(), advisor).error).toBe("SDK route preflight failed; check provider, model and local account");
		service.preflight.mockReturnValue({ ok: true, revision }); service.call.mockRejectedValue({ credential: "private-account" });
		expect(await actions.test(config(), advisor, new AbortController().signal)).toMatchObject({ ok: false, error: "SDK advisor call failed", text: "" });
	});
	it("cancelled action waits for service cleanup and discards response", async () => {
		const abort = new AbortController(); let release!: () => void;
		service.call.mockImplementation((_request, signal: AbortSignal) => new Promise(resolve => {
			signal.addEventListener("abort", () => { release = () => resolve({ ok: true, text: "late response" }); });
		}));
		let settled = false;
		const pending = actions.test(config(), advisor, abort.signal).then(result => { settled = true; return result; });
		abort.abort(); await Promise.resolve(); expect(settled).toBe(false);
		release(); expect(await pending).toMatchObject({ ok: false, cancelled: true, text: "" });
	});
});

describe("SDK auth-generation confirmation staleness", () => {
	it("account generation change before confirmation sends zero calls", async () => {
		const draft = controller(); confirmTest(draft);
		const fingerprint = draft.routeFingerprint(advisor);
		revision = "account-2"; expect(draft.routeFingerprint(advisor)).not.toBe(fingerprint);
		runConfirmed(draft); await finished(draft);
		expect(service.call).not.toHaveBeenCalled(); expect(draft.error).toMatch(/changed/);
	});
	it("account replacement after controller check but before wrapper preflight sends zero requests", async () => {
		const originalTest = actions.test;
		const spy = vi.spyOn(actions, "test").mockImplementation((settings, target, signal, context) => {
			expect(context).toEqual({ sdkAccountRevision: "account-1" });
			revision = "account-2";
			return originalTest(settings, target, signal, context);
		});
		try {
			const draft = controller(); confirmTest(draft); runConfirmed(draft); await finished(draft);
			expect(spy).toHaveBeenCalledTimes(1); expect(service.call).not.toHaveBeenCalled();
			expect(draft.testResults.some(row => row.result.ok)).toBe(false);
		} finally { spy.mockRestore(); }
	});
	it("account replacement while call runs invalidates returned connection result", async () => {
		let release!: () => void;
		service.call.mockImplementation(() => new Promise(resolve => { release = () => resolve({ ok: true, text: "OK" }); }));
		const draft = controller(); confirmTest(draft); runConfirmed(draft);
		expect(service.call).toHaveBeenCalledTimes(1);
		revision = "account-2"; release(); await finished(draft);
		expect(draft.testResults.some(row => row.result.ok)).toBe(false);
	});
	it("account replacement while generating ignores stale candidate", async () => {
		let release!: () => void;
		service.call.mockImplementation(() => new Promise(resolve => { release = () => resolve({ ok: true, text: JSON.stringify(candidate) }); }));
		const draft = controller(); draft.screen = { type: "ai" }; draft.pane = "detail"; draft.generationFocus = "Builder";
		draft.move("last"); draft.enter(); expect(draft.confirmation?.type).toBe("cost"); runConfirmed(draft);
		revision = "account-2"; release(); await finished(draft);
		expect(draft.candidate).toBeUndefined(); expect(draft.error).toMatch(/stale candidate/);
	});
});
