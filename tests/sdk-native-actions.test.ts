import { mkdtemp, rm } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SdkProviderService } from "../src/sdk-types.js";
import type { BpxCouncilConfig } from "../src/config.js";
import type { RouteTarget } from "../src/config-editor.js";

const holder = vi.hoisted(() => ({ service: undefined as SdkProviderService | undefined }));
vi.mock("../src/sdk-provider-service.js", async importOriginal => ({
	...await importOriginal<typeof import("../src/sdk-provider-service.js")>(),
	getSdkProviderService: () => { if (!holder.service) throw new Error("Fixture service not initialized"); return holder.service; },
}));
import { createSdkProviderService } from "../src/sdk-provider-service.js";
import { defaultConfigActions } from "../src/config-actions.js";

const target: RouteTarget = { section: "advisor" };
const own = "sk-fixture-own-api-credential";
let root: string;
let mode = "normal";
let mock: { baseUrl: string; state: { requests: { model: string; maxTokens: number; thinking?: { budget_tokens?: number }; toolDeclarations: number; ownCredentialUsed: boolean }[] }; stop(): Promise<void> };
let originalFetch: typeof fetch;

/** Build an explicit SDK draft. @param provider Stock provider. @param ceiling Optional exact ceiling. @returns Unsaved config. */
function draft(provider: "openai" | "anthropic", ceiling?: number): BpxCouncilConfig {
	return { defaultMode: "solo", solo: { backend: { type: "sdk", provider, model: provider === "openai" ? "gpt-5-mini" : "claude-sonnet-4-5", effort: "low" } }, ...(ceiling === undefined ? {} : { gutCheck: { maxOutputTokens: ceiling } }) };
}

beforeEach(async () => {
	root = await mkdtemp(join(realpathSync(tmpdir()), "sdk-native-actions-"));
	mock = await (await import(new URL("../scripts/sdk-proof/mock.mjs", import.meta.url).href)).startMock();
	originalFetch = globalThis.fetch; mode = "normal";
	// Keep real stock model metadata/factories; only this test's fetch routes requests to loopback.
	vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (!["https://api.openai.com", "https://api.anthropic.com"].includes(url.origin)) throw new Error("External SDK action request forbidden");
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.set("x-proof-mode", mode);
		return originalFetch(new URL(url.pathname + url.search, mock.baseUrl), { ...init, headers });
	});
	for (const prefix of ["OPENAI", "ANTHROPIC"]) {
		vi.stubEnv(`${prefix}_API_KEY`, "sk-fixture-ambient-api-credential");
		vi.stubEnv(`${prefix}_LOG`, "off"); vi.stubEnv(`${prefix}_CUSTOM_HEADERS`, "");
	}
	holder.service = createSdkProviderService({ directory: join(root, "accounts") });
	for (const provider of ["openai", "anthropic"]) expect((await holder.service.setApiKey(provider, own, new AbortController().signal)).ok).toBe(true);
});
afterEach(async () => {
	await holder.service?.settle(); await mock.stop(); holder.service = undefined;
	vi.unstubAllGlobals(); vi.unstubAllEnvs(); await rm(root, { recursive: true, force: true });
});

describe("real SDK workbench action ceilings", () => {
	it.each(["openai", "anthropic"] as const)("%s default test keeps preflight ceiling and selected thinking", async provider => {
		const config = draft(provider); const checked = defaultConfigActions.preflight(config, target);
		expect(checked.error).toBeUndefined(); expect(checked.warning).toContain("default, up to 8192");
		const result = await defaultConfigActions.test(config, target, new AbortController().signal, { sdkAccountRevision: checked.revision });
		expect(result).toMatchObject({ ok: true, text: "Route responded." });
		expect(mock.state.requests).toHaveLength(1);
		expect(mock.state.requests[0]).toMatchObject({ model: config.solo!.backend!.model, maxTokens: 8192, toolDeclarations: 0, ownCredentialUsed: true });
		if (provider === "anthropic") expect(mock.state.requests[0].thinking?.budget_tokens).toBe(2048);
		expect(config).toEqual(draft(provider));
	});
	it.each(["openai", "anthropic"] as const)("%s generation returns strict candidate without reducing thinking ceiling", async provider => {
		mode = "persona"; const ceiling = provider === "openai" ? 512 : 4096; const config = draft(provider, ceiling);
		const seat: RouteTarget = { section: "gut-check" };
		const checked = defaultConfigActions.preflight(config, seat, "generate"); expect(checked.error).toBeUndefined();
		const result = await defaultConfigActions.generate(config, seat, "Review SDK token budgets", new AbortController().signal, { sdkAccountRevision: checked.revision });
		expect(result).toMatchObject({ ok: true, candidate: { name: "sdk-reviewer", stance: "neutral" } });
		expect(mock.state.requests).toHaveLength(1); expect(mock.state.requests[0].maxTokens).toBe(ceiling);
		expect(config).toEqual(draft(provider, ceiling));
	});
	it.each(["openai", "anthropic"] as const)("%s impossible ceiling is blocked before transport", async provider => {
		const config = draft(provider, 8); const seat: RouteTarget = { section: "gut-check" };
		expect(defaultConfigActions.preflight(config, seat).error).toBeTruthy();
		expect((await defaultConfigActions.test(config, seat, new AbortController().signal)).ok).toBe(false);
		expect(mock.state.requests).toHaveLength(0);
	});
});
