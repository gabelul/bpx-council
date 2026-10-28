import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBackendArg, detectBackend, resolveSeatBackend, backendLabel } from "../src/detect.js";
import { validateConfig } from "../src/config-validation.js";
import { mergeConfigs, type BpxCouncilConfig } from "../src/config.js";
import { backendName, changeConfigRoute, configRoute } from "../src/config-editor.js";
import { backendConfigFromSpec, buildConfig } from "../src/config-wizard.js";
import { backendListsModels, listModels, listEfforts } from "../src/models-list.js";
import { parseSdkRoute, serializeSdkRoute, sdkAmbientModelError } from "../src/sdk-route.js";

const service = vi.hoisted(() => ({
	catalog: vi.fn(() => [{ id: "gpt-5-mini", label: "GPT", thinkingLevels: ["low", "medium", "high"] }]),
	preflight: vi.fn(() => ({ ok: true, revision: "account-1" })), call: vi.fn(),
}));
vi.mock("../src/sdk-provider-service.js", () => ({ getSdkProviderService: () => service }));

beforeEach(() => {
	vi.clearAllMocks();
	vi.stubEnv("BPX_COUNCIL_MODEL", ""); vi.stubEnv("ANTHROPIC_MODEL", "");
});
afterEach(() => vi.unstubAllEnvs());

/** Assemble a trusted SDK config without consulting local accounts. @returns Pinned config. */
function sdkConfig(): BpxCouncilConfig {
	return { defaultMode: "solo", solo: { backend: { type: "sdk", provider: "openai", model: "gpt-5-mini", effort: "low" } } };
}

describe("SDK route namespace", () => {
	it("splits after provider, retaining later colons and literal @ protection", () => {
		expect(parseBackendArg("sdk:openai:gpt-5-mini@low")).toEqual({ type: "sdk", provider: "openai", model: "gpt-5-mini", effort: "low" });
		for (const model of ["team:model", "team:model@low", "team@model@", "team:model@high:revision"]) {
			const route = { provider: "anthropic", model };
			expect(parseSdkRoute(serializeSdkRoute(route))).toEqual({ ...route, effort: undefined });
			expect(parseSdkRoute(serializeSdkRoute({ ...route, effort: "high" }))).toEqual({ ...route, effort: "high" });
		}
		expect(parseBackendArg("sdk:openai")).toEqual({ type: "sdk", provider: "openai", model: undefined, effort: undefined });
	});
	it.each(["sdk:", "sdk:../openai:model", "sdk:OpenAI:model", "sdk:openai/model:x", "sdk:openai:model\n", "sdk:openai:model@bad effort"])("rejects unsafe shape %s", spec => {
		expect(() => parseBackendArg(spec)).toThrow(/SDK/);
	});
	it("keeps HTTP and CLI names unchanged", () => {
		expect(parseBackendArg("openai:gpt-5-mini").type).toBe("http");
		for (const name of ["pi", "claude", "codex", "my-advisor"]) expect(parseBackendArg(`${name}:model@low`)).toMatchObject({ type: "cli", command: name });
	});
	it("does not auto-select SDK from host env or installed credentials", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "host-key"); vi.stubEnv("OPENAI_API_KEY", "host-openai");
		expect(detectBackend()).toMatchObject({ type: "http", provider: "anthropic" });
		expect(service.preflight).not.toHaveBeenCalled(); expect(service.catalog).not.toHaveBeenCalled();
	});
	it("attributes exact selected namespace, model and effort", () => {
		const selected = detectBackend(parseBackendArg("sdk:openai:gpt-5-mini@low"));
		expect(backendLabel(selected)).toBe("sdk:openai:gpt-5-mini@low");
		expect(backendName(selected)).toBe("sdk:openai");
	});
	it("blocks both conflicting ambient model vars without assigning either", () => {
		const route = { provider: "openai", model: "gpt-5-mini" };
		expect(sdkAmbientModelError(route, { BPX_COUNCIL_MODEL: "gpt-5-mini" })).toBeUndefined();
		expect(sdkAmbientModelError(route, { BPX_COUNCIL_MODEL: "gpt-5-mini", ANTHROPIC_MODEL: "host-model" })).toMatch(/conflicts/);
		expect(route.model).toBe("gpt-5-mini");
	});
});

describe("SDK config trust and field edits", () => {
	it("allows provider-only staged trusted pins but no project SDK authoring", () => {
		const staged = { solo: { backend: { type: "sdk", provider: "openai" } } };
		expect(() => validateConfig(staged, "trusted", false)).not.toThrow();
		expect(() => validateConfig(staged, "project", true)).toThrow(/project/);
		for (const layer of [{ gutCheck: { backend: "sdk:openai:gpt-5-mini" } }, { council: { backends: { critic: "sdk:anthropic:model" } } }, { debate: { synthesizer: "sdk:openai" } }]) {
			expect(() => validateConfig(layer, "trusted", false)).not.toThrow();
			expect(() => validateConfig(layer, "project", true)).toThrow(/project/);
		}
		expect(() => validateConfig({ solo: { backend: { type: "http", provider: "new-provider" } } }, "trusted", false)).toThrow(/provider/);
	});
	it("forbids credentials, endpoints and CLI settings on SDK config", () => {
		for (const extra of [{ apiKeyEnv: "SECRET" }, { baseUrl: "https://example.test" }, { args: [] }, { command: "pi" }, { isolate: true }]) {
			expect(() => validateConfig({ solo: { backend: { type: "sdk", provider: "openai", ...extra } } }, "trusted", false)).toThrow(/SDK|HTTP|CLI/);
		}
	});
	it("inherits global SDK through project layer but resolves independent seats", () => {
		const global = sdkConfig();
		const project = { debate: { critic: "anthropic:project-model", advocate: null } };
		validateConfig(project, "project", true);
		const merged = mergeConfigs(global, project);
		const shared = detectBackend(global.solo.backend);
		expect(merged.solo.backend).toEqual(global.solo.backend);
		expect(resolveSeatBackend(merged.debate?.advocate, shared)).toBe(shared);
		expect(resolveSeatBackend(merged.debate?.critic, shared)).toMatchObject({ type: "http", model: "project-model" });
		expect(resolveSeatBackend("sdk:anthropic:other@high", shared)).toMatchObject({ type: "sdk", provider: "anthropic", model: "other", effort: "high" });
	});
	it("roundtrips literal @ after seat field edits and retains null inheritance", () => {
		const target = { section: "debate", role: "critic" } as const;
		let draft = changeConfigRoute(sdkConfig(), target, { field: "backend", value: "sdk:openai" });
		draft = changeConfigRoute(draft, target, { field: "model", value: "team:model@low" });
		expect(draft.debate?.critic).toBe("sdk:openai:team:model@low@");
		expect(configRoute(draft, target)?.model).toBe("team:model@low");
		draft = changeConfigRoute(draft, target, { field: "backend", value: null });
		expect(draft.debate?.critic).toBeNull(); expect(draft.solo).toEqual(sdkConfig().solo);
	});
	it("retains untouched legacy custom args/options and SDK timeout on same-provider edit", () => {
		const old: BpxCouncilConfig = { defaultMode: "solo", solo: { thinkingLevel: "ultra", backend: { type: "cli", command: "my-advisor", args: ["--literal"], timeoutMs: 987 } }, council: { synthesizer: "pi:custom" } };
		const changed = changeConfigRoute(old, { section: "debate", role: "critic" }, { field: "backend", value: "sdk:openai:gpt-5-mini" });
		expect(changed.solo).toEqual(old.solo); expect(changed.council).toEqual(old.council);
		const existing = sdkConfig(); existing.solo.backend!.timeoutMs = 987;
		expect(buildConfig({ mode: "solo", soloSpec: "sdk:openai" }, existing).solo.backend).toEqual(existing.solo.backend);
		expect(backendConfigFromSpec("sdk:openai:gpt-5-mini@low")).toEqual({ type: "sdk", provider: "openai", model: "gpt-5-mini", effort: "low" });
	});
});

describe("bundled SDK catalogs", () => {
	it("uses static namespaced discovery without inference or auth preflight", async () => {
		expect(backendListsModels("sdk:openai")).toBe(true);
		expect(await listModels("sdk:openai")).toEqual(["gpt-5-mini"]);
		expect(await listEfforts("sdk:openai", "gpt-5-mini")).toEqual({ levels: ["low", "medium", "high"] });
		expect(await listEfforts("sdk:openai", "unknown")).toBeNull();
		expect(service.call).not.toHaveBeenCalled(); expect(service.preflight).not.toHaveBeenCalled();
	});
	it("returns cancelled discovery without touching service", async () => {
		const signal = AbortSignal.abort();
		expect(await listModels("sdk:openai", signal)).toEqual([]);
		expect(await listEfforts("sdk:openai", "gpt-5-mini", signal)).toBeNull();
		expect(service.catalog).not.toHaveBeenCalled();
	});
});
