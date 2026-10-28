import { mkdtemp, readFile, readdir, rm, mkdir, symlink } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/utils/event-stream";
import type { Provider } from "@earendil-works/pi-ai/models";
import type { AssistantMessage, Credential } from "@earendil-works/pi-ai";
import { createSdkProviderService, getSdkProviderService } from "../src/sdk-provider-service.js";
import * as sdkServiceModule from "../src/sdk-provider-service.js";
import { defaultConfigActions } from "../src/config-actions.js";
import { SdkCredentials } from "../src/sdk-credentials.js";
import { sdkBoundedFetch } from "../src/sdk-inference-policy.js";
import { addAttempt, newReceipt, seatAttempt, settleReceipt } from "../src/receipt.js";
import type { SdkCallRequest, SdkProviderService } from "../src/sdk-types.js";

interface Wire { model: string; effort: string; maxTokens: number; ownCredentialUsed: boolean; ownOAuthUsed: boolean; ambientCredentialUsed: boolean; toolDeclarations: number; personaPresent: boolean }
interface Mock { baseUrl: string; state: { requests: Wire[]; oauthRequests: number; oauthDelayMs: number; oauthFailure: boolean }; stop(): Promise<void> }
const SYNTHETIC = { own: "sk-fixture-own-api-credential", ambient: "sk-fixture-ambient-api-credential", access: "sk-ant-oat01-fixture-access", refresh: "fixture-refresh-secret" };
const STOCK_ACCOUNTS = [
	{ provider: "openai", method: "api_key", wireCredential: SYNTHETIC.own },
	{ provider: "anthropic", method: "api_key", wireCredential: SYNTHETIC.own },
	{ provider: "anthropic", method: "oauth", wireCredential: "sk-ant-oat01-fixture-rotated-access" },
] as const;
let root: string;
let mock: Mock;
let service: SdkProviderService;
let store: SdkCredentials;
let mode: string;
let externalAttempts: number;
let originalFetch: typeof fetch;
let callbackOrigin: string | undefined;
let stockEcho: { text: string; splitAt?: number; truncate?: boolean } | undefined;
let stockWire: { origin: string; model: string; maxTokens: number | undefined; thinkingBudget: number | undefined; thinkingType: string | undefined; effort: string | undefined; tenantHeader: boolean; ownCredential: boolean; ambientCredential: boolean; tools: number }[];

/** Route trusted bundled model endpoints to mock only in explicit test factory injection. @param provider SDK factory. @returns Synthetic provider. */
function loopback(provider: Provider): Provider {
	return { ...provider, getModels: () => provider.getModels().map(model => ({ ...model,
		baseUrl: provider.id === "openai" ? `${mock.baseUrl}/v1` : mock.baseUrl,
		headers: { "x-proof-mode": mode } })) };
}

/** Replace fixture answer in native SSE, optionally splitting deltas or cutting terminal frames. @param fixture Loopback response. @returns Test-only SSE. */
function echoFixture(fixture: string): string {
	const echo = stockEcho!;
	const frames: string[] = [];
	let replacedDelta = false;
	for (const frame of fixture.split("\n\n").filter(Boolean)) {
		const data = frame.split("\n").find(line => line.startsWith("data: "))!;
		let event = JSON.parse(data.slice(6));
		if (event.type === "response.output_text.delta" || event.type === "content_block_delta") {
			if (replacedDelta) continue;
			replacedDelta = true;
			const parts = echo.splitAt === undefined ? [echo.text] : [echo.text.slice(0, echo.splitAt), echo.text.slice(echo.splitAt)];
			for (const part of parts) {
				const delta = event.type === "response.output_text.delta" ? { ...event, delta: part } : { ...event, delta: { ...event.delta, text: part } };
				frames.push(`event: ${delta.type}\ndata: ${JSON.stringify(delta)}\n\n`);
			}
			if (echo.truncate) break;
		} else {
			event = JSON.parse(JSON.stringify(event).replaceAll(JSON.stringify("Council fixture answer"), JSON.stringify(echo.text)));
			frames.push(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
		}
	}
	return frames.join("");
}

/** Exact text-only fixture request. @param provider Provider ID. @returns Pinned DTO. */
function request(provider = "openai"): SdkCallRequest {
	return { provider, model: provider === "openai" ? "gpt-5-mini" : "claude-sonnet-4-6", effort: "low",
		systemPrompt: "Council fixture persona", userMessage: "Synthetic question", maxOutputTokens: 16, maxOutputBytes: 256, timeoutMs: 4000 };
}

/** Seed only synthetic private OAuth fixture through explicit account intent. @returns Completion. */
async function expiredOAuth(): Promise<void> {
	const credential: Credential = { type: "oauth", access: SYNTHETIC.access, refresh: SYNTHETIC.refresh, expires: 0 };
	await store.accountAction({ provider: "anthropic", expectedRevision: store.summary("anthropic").revision, receipt: { changed: false } },
		() => store.modify("anthropic", async () => credential));
}

/** Wait for observable mock/storage phase. @param check Phase predicate. @returns Completion. */
async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!check()) { if (Date.now() > end) throw new Error("Fixture observation deadline."); await delay(5); }
}

beforeEach(async () => {
	root = await mkdtemp(join(realpathSync(tmpdir()), "council-service-"));
	const module = await import(new URL("../scripts/sdk-proof/mock.mjs", import.meta.url).href);
	mock = await module.startMock() as Mock; mode = "normal"; externalAttempts = 0; callbackOrigin = undefined; stockWire = []; stockEcho = undefined;
	originalFetch = globalThis.fetch;
	// Public SDK owns OAuth PKCE, exchange, refresh and auth derivation unchanged.
	vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		if (url.href === "https://platform.claude.com/v1/oauth/token") return originalFetch(`${mock.baseUrl}/oauth`, init);
		if (["https://api.openai.com", "https://api.anthropic.com"].includes(url.origin)) {
			const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
			const rawBody = init?.body ?? (input instanceof Request ? await input.clone().text() : "{}");
			const body = JSON.parse(String(rawBody));
			stockWire.push({ origin: url.origin, model: body.model, maxTokens: body.max_output_tokens ?? body.max_tokens,
				thinkingBudget: body.thinking?.budget_tokens, thinkingType: body.thinking?.type, effort: body.reasoning?.effort ?? body.output_config?.effort,
				tenantHeader: headers.has("openai-organization") || headers.has("openai-project"),
				ownCredential: headers.get("authorization") === `Bearer ${SYNTHETIC.own}` || headers.get("x-api-key") === SYNTHETIC.own,
				ambientCredential: headers.get("authorization") === `Bearer ${SYNTHETIC.ambient}` || headers.get("x-api-key") === SYNTHETIC.ambient,
				tools: body.tools?.length ?? 0 });
			headers.set("x-proof-mode", mode);
			const target = new URL(url.pathname + url.search, mock.baseUrl);
			const response = await originalFetch(input instanceof Request ? new Request(target, input) : target, { ...init, headers });
			if (stockEcho) return new Response(echoFixture(await response.text()), { status: response.status, headers: response.headers });
			// Fixture-only truncation: native SDK must retain message_start usage on EOF.
			if (mode === "partial-usage" && url.origin === "https://api.anthropic.com") {
				const fixture = await response.text();
				return new Response(fixture.slice(0, fixture.indexOf("\n\n") + 2), { status: response.status, headers: response.headers });
			}
			return response;
		}
		if (url.origin === mock.baseUrl || (callbackOrigin === url.origin && url.pathname === "/callback")) return originalFetch(input, init);
		externalAttempts++; throw new Error("External fetch forbidden in SDK service tests.");
	});
	vi.stubEnv("OPENAI_API_KEY", SYNTHETIC.ambient); vi.stubEnv("ANTHROPIC_API_KEY", SYNTHETIC.ambient);
	vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "forbidden-pi-sentinel"));
	store = new SdkCredentials(join(root, "accounts"));
	service = createSdkProviderService({ credentials: store, providers: [loopback(openaiProvider()), loopback(anthropicProvider())] });
});
afterEach(async () => {
	await service.settle(); await mock.stop();
	expect(externalAttempts).toBe(0);
	vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks();
	await rm(root, { recursive: true, force: true });
});

describe("production Council SDK service", () => {
	it("constructs lazily, is opaque, and reads inventory/catalog/preflight without writes/network/refresh", async () => {
		expect(JSON.stringify(service)).toBe("{}");
		const singleton = getSdkProviderService(); expect(getSdkProviderService()).toBe(singleton); expect(JSON.stringify(singleton)).toBe("{}");
		const providers = service.inventory();
		expect(providers.map(provider => provider.id)).toEqual(["openai", "anthropic"]);
		expect(providers[0].methods.map(method => method.id)).toEqual(["api_key"]);
		expect(providers[1].methods.map(method => method.id)).toEqual(["api_key", "oauth"]);
		expect(service.catalog("openai").some(model => model.id === "gpt-5-mini")).toBe(true);
		expect(service.catalog("openai-codex")).toEqual([]);
		expect(service.preflight(request())).toMatchObject({ ok: false });
		expect(await readdir(root)).toEqual([]);
		expect(mock.state.requests).toHaveLength(0); expect(mock.state.oauthRequests).toBe(0);
		await expiredOAuth(); const before = await readFile(join(store.directory, "auth.json"), "utf8");
		expect(service.preflight({ provider: "anthropic", model: "claude-sonnet-4-6", effort: "low" }).ok).toBe(true);
		service.inventory(); service.catalog("anthropic");
		expect(mock.state.oauthRequests).toBe(0); expect(await readFile(join(store.directory, "auth.json"), "utf8")).toBe(before);
	});

	it("binds legitimate default HOME symlink lazily while refusing account-leaf symlinks", async () => {
		const realHome = join(root, "canonical-home"); await mkdir(realHome, { mode: 0o700 });
		const alias = join(root, "home-alias"); await symlink(realHome, alias); vi.stubEnv("HOME", alias);
		store = new SdkCredentials();
		const summary = vi.spyOn(store, "summary");
		service = createSdkProviderService({ credentials: store, providers: [loopback(openaiProvider()), loopback(anthropicProvider())] });
		expect(summary).not.toHaveBeenCalled(); expect(await readdir(realHome)).toEqual([]); expect(mock.state.requests).toHaveLength(0);
		expect(await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal)).toMatchObject({ ok: true, changed: true });
		expect(store.directory).toBe(join(realHome, ".bpx-council"));
		expect(await readdir(join(realHome, ".bpx-council"))).toEqual(["auth.json"]);
		await rm(join(realHome, ".bpx-council"), { recursive: true });
		const outside = join(root, "outside-accounts"); await mkdir(outside, { mode: 0o700 });
		await symlink(outside, join(realHome, ".bpx-council"));
		expect(await service.setApiKey("openai", "sk-replacement-key", new AbortController().signal)).toMatchObject({ ok: false, changed: false, account: { state: "invalid" } });
		expect(await readdir(outside)).toEqual([]);
	});

	it("ignores hostile ambient keys and refuses missing own accounts with zero requests", async () => {
		for (const provider of ["openai", "anthropic"]) {
			expect(await service.call(request(provider))).toMatchObject({ ok: false, text: "", error: expect.stringContaining("Council account") });
		}
		expect(mock.state.requests).toHaveLength(0);
		const unsupported = await service.authenticate("openai", "oauth", { onEvent: () => undefined, prompt: async () => "unused" }, new AbortController().signal);
		expect(unsupported).toMatchObject({ ok: false, changed: false }); expect(mock.state.oauthRequests).toBe(0);
	});

	it.each(["openai", "anthropic"])("runs %s key inference with exact model/effort, bounded tokens and zero tools", async provider => {
		const saved = await service.setApiKey(provider, SYNTHETIC.own, new AbortController().signal);
		expect(saved).toMatchObject({ ok: true, changed: true, account: { method: "api_key", state: "stored" } });
		const response = await service.call(request(provider));
		expect(response).toMatchObject({ ok: true, text: "Council fixture answer", usage: { inputTokens: 10, outputTokens: 4 } });
		expect(response.usage).toEqual({ inputTokens: 10, outputTokens: 4 });
		const wire = mock.state.requests.at(-1)!;
		expect(wire).toMatchObject({ model: request(provider).model, effort: "low", maxTokens: 16, ownCredentialUsed: true,
			ambientCredentialUsed: false, personaPresent: true, toolDeclarations: 0 });
		expect(JSON.stringify(saved)).not.toContain(SYNTHETIC.own);
	});

	it("actual stock factories ignore hostile endpoint/tenant/auth env concurrently", async () => {
		service = createSdkProviderService({ credentials: store });
		vi.stubEnv("OPENAI_BASE_URL", "https://hostile-endpoint.invalid/steal"); vi.stubEnv("ANTHROPIC_BASE_URL", "https://hostile-endpoint.invalid/steal");
		vi.stubEnv("OPENAI_ORG_ID", "fixture-hostile-org"); vi.stubEnv("OPENAI_PROJECT_ID", "fixture-hostile-project");
		vi.stubEnv("OPENAI_ADMIN_KEY", "fixture-hostile-admin-key"); vi.stubEnv("ANTHROPIC_AUTH_TOKEN", "fixture-hostile-auth-token");
		for (const provider of ["openai", "anthropic"]) expect((await service.setApiKey(provider, SYNTHETIC.own, new AbortController().signal)).ok).toBe(true);
		const results = await Promise.all(["openai", "anthropic", "openai", "anthropic"].map(provider => service.call(request(provider))));
		expect(results.every(result => result.ok)).toBe(true); expect(stockWire).toHaveLength(4);
		for (const wire of stockWire) expect(wire).toMatchObject({ maxTokens: 16, effort: "low", tenantHeader: false, ownCredential: true, ambientCredential: false, tools: 0 });
		expect(new Set(stockWire.map(wire => wire.origin))).toEqual(new Set(["https://api.openai.com", "https://api.anthropic.com"]));
		expect(process.env.OPENAI_ORG_ID).toBe("fixture-hostile-org"); expect(process.env.OPENAI_PROJECT_ID).toBe("fixture-hostile-project");
	});

	it.each(STOCK_ACCOUNTS.flatMap(account => [false, true].map(split => ({ ...account, split }))))(
		"stock $provider $method rejects successful wire-credential echo (split=$split) with usage and no retries", async account => {
		service = createSdkProviderService({ credentials: store });
		if (account.method === "oauth") await expiredOAuth();
		else await service.setApiKey(account.provider, SYNTHETIC.own, new AbortController().signal);
		const logs = [vi.spyOn(console, "log").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined)];
		stockEcho = { text: account.wireCredential, ...(account.split ? { splitAt: 9 } : {}) };
		const result = await service.call(request(account.provider));
		expect(result).toEqual({ ok: false, text: "", error: "SDK response contains credential values.", usage: { inputTokens: 10, outputTokens: 4 } });
		const receipt = newReceipt(); addAttempt(receipt, seatAttempt("advisor", null, { type: "sdk", provider: account.provider, model: request(account.provider).model }, result));
		settleReceipt(receipt, result);
		expect(receipt).toMatchObject({ status: "failed", advice: null, usage: { attempted: 1, reported: 1, unknown: 0, inputTokens: 10, outputTokens: 4 } });
		expect(JSON.stringify([result, receipt, service, service.inventory(), ...logs.map(log => log.mock.calls)])).not.toContain(account.wireCredential);
		expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
		expect(stockWire[0]).toMatchObject({ maxTokens: 16, effort: "low", tools: 0, ambientCredential: false });
		if (account.method === "oauth") { expect(mock.state.oauthRequests).toBe(1); expect(mock.state.requests[0].ownOAuthUsed).toBe(true); }
	});

	it.each(STOCK_ACCOUNTS)("stock $provider $method blanks capped credential prefix", async account => {
		service = createSdkProviderService({ credentials: store });
		if (account.method === "oauth") await expiredOAuth();
		else await service.setApiKey(account.provider, SYNTHETIC.own, new AbortController().signal);
		stockEcho = { text: account.wireCredential, splitAt: 9 };
		const result = await service.call({ ...request(account.provider), maxOutputBytes: account.wireCredential.length - 4 });
		expect(result).toMatchObject({ ok: false, text: "", error: "SDK output exceeded byte limit." });
		const receipt = newReceipt(); addAttempt(receipt, seatAttempt("advisor", null, { type: "sdk", provider: account.provider, model: request(account.provider).model }, result));
		settleReceipt(receipt, result);
		expect(JSON.stringify([result, receipt])).not.toContain(account.wireCredential.slice(0, 9));
		expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
	});

	it.each(STOCK_ACCOUNTS)("stock $provider $method blanks failed credential prefix", async account => {
		service = createSdkProviderService({ credentials: store });
		if (account.method === "oauth") await expiredOAuth();
		else await service.setApiKey(account.provider, SYNTHETIC.own, new AbortController().signal);
		stockEcho = { text: account.wireCredential.slice(0, 9), truncate: true };
		const result = await service.call(request(account.provider));
		expect(result).toMatchObject({ ok: false, text: "", error: "SDK provider request failed." });
		if (account.provider === "anthropic") expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
		expect(JSON.stringify(result)).not.toContain(account.wireCredential.slice(0, 9));
		expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
	});

	it.each(STOCK_ACCOUNTS.flatMap(account => [false, true].map(capped => ({ ...account, capped }))))(
		"stock $provider $method cannot turn echoed wire credential into AI persona candidate (capped=$capped)", async account => {
		service = createSdkProviderService({ credentials: store });
		vi.spyOn(sdkServiceModule, "getSdkProviderService").mockReturnValue(service);
		if (account.method === "oauth") await expiredOAuth();
		else await service.setApiKey(account.provider, SYNTHETIC.own, new AbortController().signal);
		stockEcho = { text: JSON.stringify({ name: "echo-reviewer", stance: "neutral", systemPrompt: account.capped ? "x".repeat(32700) + account.wireCredential : `Review ${account.wireCredential}` }), splitAt: account.capped ? 32764 : 75 };
		if (account.capped) {
			const start = stockEcho.text.indexOf(account.wireCredential);
			expect(start).toBeLessThan(32768); expect(start + account.wireCredential.length).toBeGreaterThan(32768);
		}
		const config = { defaultMode: "solo" as const, solo: { backend: { type: "sdk" as const, provider: account.provider, model: request(account.provider).model, effort: "low" } } };
		const original = structuredClone(config);
		const result = await defaultConfigActions.generate(config, { section: "advisor" }, "Review token budgets", new AbortController().signal,
			{ sdkAccountRevision: store.summary(account.provider).revision });
		expect(result).toMatchObject({ ok: false, text: "", error: account.capped ? "SDK output exceeded byte limit." : "SDK response contains credential values." });
		expect(result.candidate).toBeUndefined(); expect(config).toEqual(original);
		expect(JSON.stringify([result, config])).not.toContain(account.wireCredential.slice(0, 9));
		expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
	});

	it.each(["openai", "anthropic"].flatMap(provider => ["", " \t\n"].map(text => ({ provider, text }))))(
		"stock $provider rejects otherwise-successful empty/whitespace text '$text' without losing usage", async ({ provider, text }) => {
		service = createSdkProviderService({ credentials: store });
		await service.setApiKey(provider, SYNTHETIC.own, new AbortController().signal);
		stockEcho = { text };
		const result = await service.call(request(provider));
		expect(result).toEqual({ ok: false, text: "", error: "SDK provider returned no usable text.", usage: { inputTokens: 10, outputTokens: 4 } });
		const receipt = newReceipt(); addAttempt(receipt, seatAttempt("advisor", null, { type: "sdk", provider, model: request(provider).model }, result));
		settleReceipt(receipt, result);
		expect(receipt).toMatchObject({ status: "failed", advice: null, usage: { attempted: 1, reported: 1, unknown: 0, inputTokens: 10, outputTokens: 4 } });
		expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
	});

	it.each(["openai", "anthropic"].flatMap(provider => ["429", "retry", "error"].map(failingMode => [provider, failingMode] as const)))(
		"actual stock %s SDK %s failure has unknown usage, one request and no secret leaks", async (provider, failingMode) => {
		service = createSdkProviderService({ credentials: store });
		await service.setApiKey(provider, SYNTHETIC.own, new AbortController().signal); mode = failingMode;
		const result = await service.call(request(provider)); expect(result.ok).toBe(false); expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
		expect(result.usage).toBeUndefined(); expect(JSON.stringify(result)).not.toContain(SYNTHETIC.own);
		const receipt = newReceipt(); addAttempt(receipt, seatAttempt("advisor", null, { type: "sdk", provider, model: request(provider).model, effort: "low" }, result));
		expect(receipt.usage).toMatchObject({ attempted: 1, reported: 0, unknown: 1, inputTokens: null, outputTokens: null,
			cacheReadInputTokens: null, cacheCreationInputTokens: null, cacheReadReported: 0, cacheCreationReported: 0 });
	});

	it("native SDK message_start positive usage survives truncated error stream without inventing cache reports", async () => {
		service = createSdkProviderService({ credentials: store });
		await service.setApiKey("anthropic", SYNTHETIC.own, new AbortController().signal); mode = "partial-usage";
		const result = await service.call(request("anthropic"));
		expect(result.ok).toBe(false); expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 0 });
		const receipt = newReceipt(); addAttempt(receipt, seatAttempt("advisor", null, { type: "sdk", provider: "anthropic", model: "claude-sonnet-4-6", effort: "low" }, result));
		expect(receipt.usage).toMatchObject({ reported: 1, unknown: 0, inputTokens: 10, outputTokens: 0, cacheReadReported: 0, cacheCreationReported: 0 });
		expect(stockWire).toHaveLength(1); expect(mock.state.requests).toHaveLength(1);
	});

	it("actual stock legacy thinking keeps selected SDK budget while ceiling remains exact", async () => {
		service = createSdkProviderService({ credentials: store });
		await service.setApiKey("anthropic", SYNTHETIC.own, new AbortController().signal);
		const result = await service.call({ ...request("anthropic"), model: "claude-sonnet-4-5", maxOutputTokens: 4096 });
		expect(result.ok).toBe(true); expect(stockWire.at(-1)).toMatchObject({ maxTokens: 4096, thinkingBudget: 2048, thinkingType: "enabled", tools: 0 });
		expect(await service.call({ ...request("anthropic"), model: "claude-sonnet-4-5", maxOutputTokens: 3071 })).toMatchObject({ ok: false, error: expect.stringContaining("full SDK thinking budget") });
		expect(stockWire).toHaveLength(1);
	});

	it("unsafe vendor logging/custom headers and invalid OpenAI key shapes fail before SDK HTTP", async () => {
		service = createSdkProviderService({ credentials: store });
		const invalid = await service.setApiKey("openai", "fixture-non-api-key-token", new AbortController().signal);
		expect(invalid).toMatchObject({ ok: false, changed: false });
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		for (const [name, value] of [["OPENAI_LOG", "debug"], ["OPENAI_CUSTOM_HEADERS", "Authorization: Bearer fixture-hostile-key"]]) {
			vi.stubEnv(name, value); expect((await service.call(request())).ok).toBe(false); vi.stubEnv(name, "");
		}
		expect(stockWire).toHaveLength(0); expect(mock.state.requests).toHaveLength(0);
	});

	it("stock oversized HTTP frame stops before SDK parser receives excess bytes", async () => {
		service = createSdkProviderService({ credentials: store }); await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal); mode = "large";
		expect(await service.call({ ...request(), maxOutputBytes: 8 })).toMatchObject({ ok: false, error: "SDK output exceeded byte limit." });
		expect(stockWire).toHaveLength(1);
		let exceeded = 0; let delivered = 0;
		const bounded = sdkBoundedFetch(async () => new Response(new ReadableStream<Uint8Array>({
			start(controller) { controller.enqueue(new Uint8Array(128)); controller.close(); },
		})), 64, () => { exceeded++; });
		const response = await bounded("https://fixture.invalid");
		await expect((async () => { for await (const chunk of response.body!) delivered += chunk.byteLength; })()).rejects.toThrow("SDK HTTP response exceeded byte limit.");
		expect(exceeded).toBe(1); expect(delivered).toBe(0);
	});

	it("preflights impossible default legacy effort and native OpenAI floor without auth refresh", async () => {
		service = createSdkProviderService({ credentials: store }); await expiredOAuth();
		expect(service.preflight({ provider: "anthropic", model: "claude-sonnet-4-5", effort: "medium" })).toMatchObject({ ok: false, error: expect.stringContaining("full SDK thinking budget") });
		expect(await service.call({ ...request("anthropic"), model: "claude-sonnet-4-5", effort: "high", maxOutputTokens: 16384 })).toMatchObject({ ok: false, error: expect.stringContaining("full SDK thinking budget") });
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		expect(await service.call({ ...request(), maxOutputTokens: 15 })).toMatchObject({ ok: false, error: expect.stringContaining("at least 16") });
		expect(stockWire).toHaveLength(0); expect(mock.state.oauthRequests).toBe(0);
	});

	it("approved preflight bounds reject impossible batch seats but allow full legacy thinking budget", async () => {
		service = createSdkProviderService({ credentials: store });
		for (const provider of ["openai", "anthropic"]) await service.setApiKey(provider, SYNTHETIC.own, new AbortController().signal);
		expect(service.preflight({ provider: "openai", model: "gpt-5-mini", effort: "low" }, { maxOutputTokens: 15 }).ok).toBe(false);
		expect(service.preflight({ provider: "anthropic", model: "claude-sonnet-4-5", effort: "low" }, { maxOutputTokens: 16 }).ok).toBe(false);
		expect(service.preflight({ provider: "anthropic", model: "claude-sonnet-4-5", effort: "high" }, { maxOutputTokens: 16384 }).ok).toBe(false);
		expect(service.preflight({ provider: "anthropic", model: "claude-sonnet-4-5", effort: "high" }, { maxOutputTokens: 32768 }).ok).toBe(true);
		expect(stockWire).toHaveLength(0); expect(mock.state.oauthRequests).toBe(0);
	});

	it("rechecks original generation after SDK payload hook immediately before actual HTTP", async () => {
		const native = openaiProvider();
		const interrupted: Provider = { ...native, streamSimple: (model, context, options) => native.streamSimple(model, context, {
			...options,
			onPayload: async (payload, pinned) => {
				expect((await service.setApiKey("openai", "sk-post-payload-key", new AbortController().signal)).ok).toBe(true);
				return options?.onPayload?.(payload, pinned);
			},
		}) };
		service = createSdkProviderService({ credentials: store, providers: [interrupted, anthropicProvider()] });
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		const original = store.summary("openai").revision;
		expect(await service.call({ ...request(), expectedRevision: original })).toMatchObject({ ok: false, text: "", error: "SDK account changed; confirm route again." });
		expect(stockWire).toHaveLength(0); expect(mock.state.requests).toHaveLength(0);
	});

	it("uses SDK-owned Anthropic OAuth login/inference/refresh without changing account identity", async () => {
		let state = ""; const events: string[] = [];
		const login = await service.authenticate("anthropic", "oauth", {
			onEvent: event => { events.push(event.type); if (event.type === "url") state = new URL(event.url).searchParams.get("state")!; },
			prompt: async prompt => prompt.label.includes("Select Anthropic login method") ? "copy_code" : `fixture-code#${state}`,
		}, new AbortController().signal);
		expect(login).toMatchObject({ ok: true, changed: true, account: { method: "oauth" } }); expect(state).not.toBe("");
		expect(events).toContain("url"); expect(mock.state.oauthRequests).toBe(1);
		const response = await service.call(request("anthropic")); expect(response.ok).toBe(true); expect(mock.state.requests.at(-1)?.ownOAuthUsed).toBe(true);
		const revision = login.account.revision;
		await store.modify("anthropic", async credential => ({ ...credential as Credential & { expires: number }, expires: 0 }));
		expect((await service.call({ ...request("anthropic"), expectedRevision: revision })).ok).toBe(true);
		expect(store.summary("anthropic").revision).toBe(revision); expect(mock.state.oauthRequests).toBe(2);
	});

	it.each(["429", "retry"])("never retries %s and never exposes private errors or logs", async failingMode => {
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal); mode = failingMode;
		const logs = [vi.spyOn(console, "log").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined)];
		const result = await service.call(request()); await delay(650);
		expect(result).toMatchObject({ ok: false, error: "SDK provider request failed." }); expect(mock.state.requests).toHaveLength(1);
		expect(JSON.stringify([result, ...logs.map(log => log.mock.calls)])).not.toContain(SYNTHETIC.own);
	});

	it("never returns or logs raw key/token embedded in provider failures", async () => {
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		const logs = [vi.spyOn(console, "log").mockImplementation(() => undefined), vi.spyOn(console, "warn").mockImplementation(() => undefined), vi.spyOn(console, "error").mockImplementation(() => undefined)];
		mode = "error"; const keyError = await service.call(request());
		mode = "normal"; await expiredOAuth(); mock.state.oauthFailure = true; const tokenError = await service.call(request("anthropic"));
		const output = JSON.stringify([keyError, tokenError, ...logs.map(log => log.mock.calls)]);
		expect(output).not.toContain(SYNTHETIC.own); expect(output).not.toContain(SYNTHETIC.refresh);
		expect(keyError.ok).toBe(false); expect(tokenError.ok).toBe(false);
	});

	it("rejects unknown aliases/effort and auth/header/env/tool/image overrides before dispatch", async () => {
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		for (const change of [{ model: "gpt-5" + "-unknown" }, { effort: "ultra" }, { apiKey: SYNTHETIC.ambient }, { env: { OPENAI_API_KEY: SYNTHETIC.ambient } },
			{ headers: { Authorization: "Bearer override" } }, { tools: [] }, { images: [] }, { baseUrl: "http://example.invalid" }]) {
			expect((await service.call({ ...request(), ...change } as SdkCallRequest)).ok).toBe(false);
		}
		expect(mock.state.requests).toHaveLength(0);
		expect(service.preflight({ provider: "openai", model: "gpt-5-mini", effort: "ultra" }).error).toContain("thinking");
		expect(service.preflight({ provider: "openai" }).error).toContain("exact");
	});

	it("refuses impossible legacy budgets locally, but restores supported total cap without downmapping thinking", async () => {
		await service.setApiKey("anthropic", SYNTHETIC.own, new AbortController().signal);
		const result = await service.call({ ...request("anthropic"), model: "claude-sonnet-4-5" });
		expect(result).toMatchObject({ ok: false, error: expect.stringContaining("full SDK thinking budget") });
		expect(mock.state.requests).toHaveLength(0);
		const supported = await service.call({ ...request("anthropic"), model: "claude-sonnet-4-5", maxOutputTokens: 4096 });
		expect(supported.ok).toBe(true); expect(mock.state.requests.at(-1)?.maxTokens).toBe(4096);
	});

	it("caps text and classifies timeout/cancellation after actual signal abortion", async () => {
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal); mode = "bound";
		const capped = await service.call({ ...request(), maxOutputBytes: 200 }); expect(capped).toMatchObject({ ok: false, error: "SDK output exceeded byte limit." });
		expect(capped.text).toBe("");
		mode = "slow"; const timed = await service.call({ ...request(), timeoutMs: 30 }); expect(timed.error).toBe("SDK request timed out."); expect(timed.text).toBe("");
		const abort = new AbortController(); const before = mock.state.requests.length; const inFlight = service.call(request(), abort.signal);
		await until(() => mock.state.requests.length > before); abort.abort(); expect(await inFlight).toMatchObject({ error: "SDK request cancelled.", text: "" });
		const after = mock.state.requests.length; await delay(300); expect(mock.state.requests).toHaveLength(after);
	});

	it("awaits long OAuth refresh/persist after native SDK abort, then returns no remaining work", async () => {
		await expiredOAuth(); const revision = store.summary("anthropic").revision; mock.state.oauthDelayMs = 130;
		const result = await service.call({ ...request("anthropic"), timeoutMs: 30, expectedRevision: revision });
		expect(result.error).toBe("SDK request timed out."); expect(mock.state.oauthRequests).toBe(1); expect(mock.state.requests).toHaveLength(0);
		expect((await store.read("anthropic") as { access: string }).access).toBe("sk-ant-oat01-fixture-rotated-access");
		expect(store.summary("anthropic").revision).toBe(revision);
		expect(await readdir(store.directory)).toEqual(["auth.json"]); await service.settle();
	});

	it("fresh concurrent SDK collections share one locked OAuth refresh", async () => {
		await expiredOAuth(); const revision = store.summary("anthropic").revision; mock.state.oauthDelayMs = 40;
		const results = await Promise.all(Array.from({ length: 6 }, () => service.call({ ...request("anthropic"), expectedRevision: revision })));
		expect(results.every(result => result.ok)).toBe(true); expect(mock.state.oauthRequests).toBe(1);
		expect(mock.state.requests).toHaveLength(6); expect(store.summary("anthropic").revision).toBe(revision);
	});

	it("preserves failed refresh, reports cancellation safely, and prevents logout resurrection", async () => {
		await expiredOAuth(); mock.state.oauthFailure = true;
		const failure = await service.call(request("anthropic")); expect(failure.ok).toBe(false); expect(JSON.stringify(failure)).not.toContain(SYNTHETIC.refresh);
		expect((await store.read("anthropic") as { expires: number }).expires).toBe(0);
		mock.state.oauthFailure = false; mock.state.oauthDelayMs = 100;
		const revision = store.summary("anthropic").revision; const before = mock.state.oauthRequests;
		const call = service.call(request("anthropic")); await until(() => mock.state.oauthRequests > before);
		const logout = service.logout("anthropic", revision, new AbortController().signal);
		await Promise.all([call, logout]); expect(store.summary("anthropic").state).toBe("missing");
		expect(await store.read("anthropic")).toBeUndefined();
	});

	it("cancels pending login prompts without starting exchange or storing an account", async () => {
		const abort = new AbortController(); let prompting = false;
		const pending = service.authenticate("anthropic", "oauth", { onEvent: () => undefined,
			prompt: async () => { prompting = true; return new Promise<string>(() => undefined); } }, abort.signal);
		await until(() => prompting); abort.abort(); const result = await pending;
		expect(result).toMatchObject({ ok: false, changed: false, cancelled: true }); expect(mock.state.oauthRequests).toBe(0);
	});

	it("rejects stale login result and stale logout after concurrent key changes", async () => {
		await service.setApiKey("anthropic", "original-key", new AbortController().signal);
		const revision = store.summary("anthropic").revision; let state = ""; let release!: (value: string) => void;
		const login = service.authenticate("anthropic", "oauth", {
			onEvent: event => { if (event.type === "url") state = new URL(event.url).searchParams.get("state")!; },
			prompt: async prompt => prompt.label.includes("Select Anthropic login method") ? "copy_code" : new Promise<string>(resolve => { release = resolve; }),
		}, new AbortController().signal);
		await until(() => !!release);
		const saved = await service.setApiKey("anthropic", "new-key", new AbortController().signal); expect(saved.ok).toBe(true);
		release(`fixture-code#${state}`); expect(await login).toMatchObject({ ok: false, changed: false, error: "Account changed; reopen account settings." });
		expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "new-key" });
		expect(await service.logout("anthropic", revision, new AbortController().signal)).toMatchObject({ ok: false, changed: false });
	});

	it("checks expectedRevision inside actual credential read, not just synchronous preflight", async () => {
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		const revision = store.summary("openai").revision; let release!: () => void; let waiting = false;
		const originalRead = store.read.bind(store);
		vi.spyOn(store, "read").mockImplementation((provider, options) => store.barrier.track(async () => {
			waiting = true; await new Promise<void>(resolve => { release = resolve; }); return originalRead(provider, options);
		}));
		const call = service.call({ ...request(), expectedRevision: revision }); await until(() => waiting);
		await service.setApiKey("openai", "sk-concurrent-key", new AbortController().signal); release();
		expect(await call).toMatchObject({ ok: false, text: "", error: "SDK account changed; confirm route again." }); expect(mock.state.requests).toHaveLength(0);
	});

	it("reports committed account change even when cancelled immediately after atomic persistence", async () => {
		const abort = new AbortController();
		const internal = store as unknown as { persist(file: unknown, intent?: unknown): Promise<void> };
		const persist = internal.persist.bind(store);
		vi.spyOn(internal, "persist").mockImplementation(async (file, intent) => { await persist(file, intent); abort.abort(); });
		const saved = await service.setApiKey("openai", SYNTHETIC.own, abort.signal);
		expect(saved).toMatchObject({ ok: false, changed: true, cancelled: true, account: { state: "stored" } });
		expect(await store.read("openai")).toEqual({ type: "api_key", key: SYNTHETIC.own });
	});

	it("awaits abort during refresh persistence and unlock before returning", async () => {
		await expiredOAuth();
		let release!: () => void; let writing = false;
		const internal = store as unknown as { persist(file: unknown, intent?: unknown): Promise<void> };
		const persist = internal.persist.bind(store);
		vi.spyOn(internal, "persist").mockImplementation(async (file, intent) => {
			writing = true; await new Promise<void>(resolve => { release = resolve; }); await persist(file, intent);
		});
		const abort = new AbortController(); let returned = false;
		const pending = service.call(request("anthropic"), abort.signal).then(result => { returned = true; return result; });
		await until(() => writing); abort.abort(); await delay(20); expect(returned).toBe(false);
		release(); expect((await pending).error).toBe("SDK request cancelled.");
		expect(await readdir(store.directory)).toEqual(["auth.json"]); expect(mock.state.requests).toHaveLength(0);
	});

	it("checks confirmed generation again after auth resolution, before provider dispatch", async () => {
		const factory = openaiProvider(); let release!: () => void; let resolving = false;
		const apiKey = factory.auth.apiKey!;
		const delayed: Provider = { ...loopback(factory), auth: { apiKey: { ...apiKey, resolve: async input => {
			resolving = true; await new Promise<void>(resolve => { release = resolve; }); return apiKey.resolve(input);
		} } } };
		service = createSdkProviderService({ credentials: store, providers: [delayed] });
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		const revision = store.summary("openai").revision;
		const pending = service.call({ ...request(), expectedRevision: revision }); await until(() => resolving);
		await service.setApiKey("openai", "sk-post-read-key", new AbortController().signal); release();
		expect(await pending).toMatchObject({ ok: false, text: "", error: "SDK account changed; confirm route again." }); expect(mock.state.requests).toHaveLength(0);
	});

	it("warms real SDK inference then uses newly confirmed credentials, never cached prior account", async () => {
		await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
		const oldRevision = store.summary("openai").revision;
		expect((await service.call({ ...request(), expectedRevision: oldRevision })).ok).toBe(true);
		expect(mock.state.requests.at(-1)?.ownCredentialUsed).toBe(true);
		// Mock's second token-match flag distinguishes new own key from both old own and ambient keys.
		const newAccount = await service.setApiKey("openai", "sk-ant-oat01-fixture-rotated-access", new AbortController().signal);
		const before = mock.state.requests.length;
		expect((await service.call({ ...request(), expectedRevision: oldRevision })).error).toContain("confirm route again");
		expect(mock.state.requests).toHaveLength(before);
		expect((await service.call({ ...request(), expectedRevision: newAccount.account.revision })).ok).toBe(true);
		expect(mock.state.requests.at(-1)).toMatchObject({ ownCredentialUsed: false, ownOAuthUsed: true, ambientCredentialUsed: false });
	});

	it("SDK-owned delayed OAuth exchange abort settles without commit or late UI events", async () => {
		mock.state.oauthDelayMs = 150;
		let state = ""; let events = 0; const abort = new AbortController();
		const login = service.authenticate("anthropic", "oauth", {
			onEvent: event => { events++; if (event.type === "url") state = new URL(event.url).searchParams.get("state")!; },
			prompt: async prompt => prompt.label.includes("Select Anthropic login method") ? "copy_code" : `fixture-code#${state}`,
		}, abort.signal);
		await until(() => mock.state.oauthRequests === 1); abort.abort();
		expect(await login).toMatchObject({ ok: false, changed: false, cancelled: true });
		const terminalEvents = events; await delay(200); expect(events).toBe(terminalEvents); expect(store.summary("anthropic").state).toBe("missing");
	});

	it("SDK-owned OAuth login cancellation after commit retains changed receipt and no late events", async () => {
		const abort = new AbortController(); let state = ""; let events = 0;
		const internal = store as unknown as { persist(file: unknown, intent?: unknown): Promise<void> };
		const persist = internal.persist.bind(store);
		vi.spyOn(internal, "persist").mockImplementation(async (file, intent) => { await persist(file, intent); abort.abort(); });
		const login = await service.authenticate("anthropic", "oauth", {
			onEvent: event => { events++; if (event.type === "url") state = new URL(event.url).searchParams.get("state")!; },
			prompt: async prompt => prompt.label.includes("Select Anthropic login method") ? "copy_code" : `fixture-code#${state}`,
		}, abort.signal);
		expect(login).toMatchObject({ ok: false, changed: true, cancelled: true, account: { state: "stored", method: "oauth" } });
		const terminalEvents = events; await delay(20); expect(events).toBe(terminalEvents);
	});

	it("SDK-owned browser callback login closes callback server after success", async () => {
		let authorize: URL | undefined;
		const login = service.authenticate("anthropic", "oauth", {
			onEvent: event => { if (event.type === "url") authorize = new URL(event.url); },
			prompt: async prompt => prompt.label.includes("Select Anthropic login method") ? "browser" : new Promise<string>(() => undefined),
		}, new AbortController().signal);
		await until(() => !!authorize);
		const callback = new URL(authorize!.searchParams.get("redirect_uri")!); callback.hostname = "127.0.0.1"; callbackOrigin = callback.origin;
		callback.searchParams.set("code", "synthetic-callback-code"); callback.searchParams.set("state", authorize!.searchParams.get("state")!);
		expect((await fetch(callback)).ok).toBe(true);
		expect(await login).toMatchObject({ ok: true, changed: true, account: { state: "stored", method: "oauth" } });
		await expect(originalFetch(callback)).rejects.toThrow();
	});

	it("SDK-owned browser prompt abort closes callback server and emits no late events", async () => {
		let authorize: URL | undefined; let events = 0; const abort = new AbortController();
		const login = service.authenticate("anthropic", "oauth", {
			onEvent: event => { events++; if (event.type === "url") authorize = new URL(event.url); },
			prompt: async prompt => prompt.label.includes("Select Anthropic login method") ? "browser" : new Promise<string>(() => undefined),
		}, abort.signal);
		await until(() => !!authorize); const callback = new URL(authorize!.searchParams.get("redirect_uri")!); callback.hostname = "127.0.0.1";
		abort.abort(); expect(await login).toMatchObject({ ok: false, changed: false, cancelled: true });
		await expect(originalFetch(callback)).rejects.toThrow(); const terminalEvents = events; await delay(20); expect(events).toBe(terminalEvents);
		expect(mock.state.oauthRequests).toBe(0);
	});

	it("has no coding-agent/global registry/default helper/CLI source imports", async () => {
		const source = await readFile(new URL("../src/sdk-provider-service.ts", import.meta.url), "utf8");
		expect(source).not.toMatch(/pi-coding-agent|ModelRuntime|Durable|\/compat(?:["']|\/)|child_process|process\.env|PI_CODING_AGENT_DIR|\.pi\/|\/dist\//);
	});
});

/** Produce terminal fixture message with no private SDK state. @returns Assistant message. */
function terminal(): AssistantMessage {
	return { role: "assistant", api: "openai-responses", provider: "openai", model: "gpt-5-mini", content: [], stopReason: "stop", timestamp: Date.now(),
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}

it.each([
	{ label: "credential echo", text: SYNTHETIC.own, error: "SDK response contains credential values." },
	{ label: "empty success", text: "", error: "SDK provider returned no usable text." },
])("waits for terminal and owned lease drain before rejecting $label", async sample => {
	const native = openaiProvider();
	let release!: () => void; let ended = false; let returned = false;
	const gate = new Promise<void>(resolve => { release = resolve; });
	const fake: Provider = { ...native, streamSimple: () => {
		const stream = createAssistantMessageEventStream(); const message = terminal();
		message.content = [{ type: "text", text: sample.text }];
		message.usage = { ...message.usage, input: 10, output: 4, totalTokens: 14 };
		void store.barrier.track(async () => { await gate; });
		queueMicrotask(() => {
			stream.push({ type: "text_delta", contentIndex: 0, delta: sample.text.slice(0, 9), partial: message });
			stream.push({ type: "text_delta", contentIndex: 0, delta: sample.text.slice(9), partial: message });
			stream.end(message); ended = true;
		});
		return stream;
	} };
	service = createSdkProviderService({ credentials: store, providers: [fake] });
	await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
	const pending = service.call(request()).then(result => { returned = true; return result; });
	try { await until(() => ended); await delay(20); expect(returned).toBe(false); }
	finally { release(); }
	expect(await pending).toEqual({ ok: false, text: "", error: sample.error, usage: { inputTokens: 10, outputTokens: 4 } });
	await service.settle(); expect(await readdir(store.directory)).toEqual(["auth.json"]);
});

it.each(["error", "cancelled", "length", "cap"] as const)("blanks %s credential prefixes while retaining positive partial usage", async failure => {
	const native = openaiProvider(); const abort = new AbortController();
	const fake: Provider = { ...native, streamSimple: (_model, _context, options) => {
		const stream = createAssistantMessageEventStream(); const message = terminal();
		const fragment = options!.apiKey!.slice(0, 9);
		message.content = [{ type: "text", text: fragment }];
		message.stopReason = failure === "error" ? "error" : failure === "length" ? "length" : "stop";
		message.usage = { ...message.usage, input: 3, output: 2, totalTokens: 5 };
		queueMicrotask(() => {
			stream.push({ type: "text_delta", contentIndex: 0, delta: fragment, partial: message });
			if (failure === "cancelled") abort.abort();
			stream.end(message);
		});
		return stream;
	} };
	service = createSdkProviderService({ credentials: store, providers: [fake] });
	await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
	const result = await service.call({ ...request(), ...(failure === "cap" ? { maxOutputBytes: 8 } : {}) }, abort.signal);
	expect(result).toEqual({ ok: false, text: "", error: failure === "cap" ? "SDK output exceeded byte limit."
		: failure === "cancelled" ? "SDK request cancelled." : "SDK provider request failed.", usage: { inputTokens: 3, outputTokens: 2 } });
	const receipt = newReceipt(); addAttempt(receipt, seatAttempt("advisor", null, { type: "sdk", provider: "openai", model: "gpt-5-mini" }, result));
	settleReceipt(receipt, result);
	expect(receipt.usage).toMatchObject({ reported: 1, unknown: 0, inputTokens: 3, outputTokens: 2 });
	expect(JSON.stringify([result, receipt])).not.toContain(SYNTHETIC.own.slice(0, 8));
});

it.each([
	{ label: "all-zero success remains unknown", failed: false, input: 0, output: 0, read: 0, write: 0, expected: undefined },
	{ label: "positive failed usage survives", failed: true, input: 3, output: 2, read: 0, write: 0, expected: { inputTokens: 3, outputTokens: 2 } },
	{ label: "cache-read-only usage excludes unsupported zero write", failed: true, input: 0, output: 0, read: 7, write: 0, expected: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 7 } },
	{ label: "SDK uncached input stays separate from positive caches", failed: true, input: 3, output: 2, read: 7, write: 5, expected: { inputTokens: 3, outputTokens: 2, cacheReadInputTokens: 7, cacheCreationInputTokens: 5 } },
])("normalizes SDK usage truthfully: $label", async sample => {
	const native = openaiProvider();
	const fake: Provider = { ...native, streamSimple: () => {
		const stream = createAssistantMessageEventStream(); const message = terminal();
		message.stopReason = sample.failed ? "error" : "stop";
		message.usage = { ...message.usage, input: sample.input, output: sample.output, cacheRead: sample.read, cacheWrite: sample.write,
			totalTokens: sample.input + sample.output + sample.read + sample.write };
		message.content = [{ type: "text", text: "Safe fixture answer" }];
		queueMicrotask(() => {
			stream.push({ type: "text_delta", contentIndex: 0, delta: "Safe fixture answer", partial: message });
			stream.end(message);
		}); return stream;
	} };
	service = createSdkProviderService({ credentials: store, providers: [fake] });
	await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
	const result = await service.call(request()); expect(result.ok).toBe(!sample.failed); expect(result.usage).toEqual(sample.expected);
	expect(result.text).toBe(sample.failed ? "" : "Safe fixture answer");
	expect(mock.state.requests).toHaveLength(0);
});

it.each(["thinking", "toolCall"])("caps hostile raw %s output with fake SDK provider handler", async kind => {
	const base = loopback(openaiProvider()); let observedSignal: AbortSignal | undefined;
	const fake: Provider = { ...base, streamSimple: (_model, _context, options) => {
		observedSignal = options?.signal; const stream = createAssistantMessageEventStream(); const message = terminal();
		queueMicrotask(() => {
			if (kind === "thinking") {
				message.content = [{ type: "thinking", thinking: "x".repeat(512) }];
				stream.push({ type: "thinking_delta", contentIndex: 0, delta: "x".repeat(512), partial: message });
			} else {
				message.content = [{ type: "toolCall", id: "fixture", name: "forbidden", arguments: { raw: "x".repeat(512) } }];
				stream.push({ type: "toolcall_delta", contentIndex: 0, delta: "x".repeat(512), partial: message });
			}
			stream.end(message);
		}); return stream;
	} };
	service = createSdkProviderService({ credentials: store, providers: [fake] });
	await service.setApiKey("openai", SYNTHETIC.own, new AbortController().signal);
	const result = await service.call({ ...request(), maxOutputBytes: 100 });
	expect(result).toMatchObject({ ok: false, text: "", error: "SDK output exceeded byte limit." }); expect(observedSignal?.aborted).toBe(true);
	expect(mock.state.requests).toHaveLength(0);
});
