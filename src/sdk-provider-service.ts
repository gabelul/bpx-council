import { createModels, getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { MutableModels, Provider } from "@earendil-works/pi-ai/models";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { openaiProvider } from "@earendil-works/pi-ai/providers/openai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { zaiProvider } from "@earendil-works/pi-ai/providers/zai";
import type { AuthEvent, AuthInteraction, AuthPrompt, ModelsStore, ModelsStoreEntry, ModelThinkingLevel, ThinkingLevel, Usage, Model, Api, ProviderRequestOptions } from "@earendil-works/pi-ai";
import type { BackendResult } from "./backend.js";
import { SdkCredentialError, SdkCredentials, SdkOperationBarrier, OAUTH_PROVIDERS } from "./sdk-credentials.js";
import type { CredentialService } from "./sdk-credentials.js";
import { PiSharedCredentials } from "./pi-shared-credentials.js";
import { sdkBoundedFetch, sdkBudgetError, sdkOwnFetch, sdkVendorEnvironmentError } from "./sdk-inference-policy.js";
import type { SdkAccountResult, SdkAuthInteraction, SdkAuthMethod, SdkCallRequest, SdkModelSummary, SdkPreflight, SdkPreflightBounds, SdkProviderService, SdkProviderSummary, SdkRoute } from "./sdk-types.js";

const PROVIDER_IDS = ["openai", "anthropic", "openai-codex", "zai"] as const;
/** Bundled factories in admission order; baseUrl pins the audited endpoint per provider. */
const PROVIDER_FACTORIES = (): Provider[] => [openaiProvider(), anthropicProvider(), openaiCodexProvider(), zaiProvider()];
/** The only SDK model endpoints this Council admits, pinned per provider. */
const EXPECTED_BASE_URLS: Record<string, string> = {
	openai: "https://api.openai.com/v1",
	anthropic: "https://api.anthropic.com",
	"openai-codex": "https://chatgpt.com/backend-api",
	zai: "https://api.z.ai/api/coding/paas/v4",
};
/** Hosts each provider's OAuth login may send the user to; anything else is refused. */
const LOGIN_URL_HOSTS: Record<string, readonly string[]> = {
	anthropic: ["claude.ai"],
	"openai-codex": ["auth.openai.com", "chatgpt.com"],
};
const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 600_000;
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const ROUTE_KEYS = new Set(["provider", "model", "effort"]);
const CALL_KEYS = new Set([...ROUTE_KEYS, "systemPrompt", "userMessage", "maxOutputTokens", "maxOutputBytes", "timeoutMs", "expectedRevision"]);

/** In-memory catalog only. No SDK default store or discovery. */
class CouncilModelsStore implements ModelsStore {
	private readonly entries = new Map<string, ModelsStoreEntry>();
	/** @param provider Exact provider. @param options Cancellation. @returns Private cached metadata. */
	async read(provider: string, options: { signal?: AbortSignal } = {}): Promise<ModelsStoreEntry | undefined> {
		options.signal?.throwIfAborted(); return this.entries.get(provider);
	}
	/** @param provider Exact provider. @param entry Catalog. @param options Cancellation. @returns Completion. */
	async write(provider: string, entry: ModelsStoreEntry, options: { signal?: AbortSignal } = {}): Promise<void> {
		options.signal?.throwIfAborted(); this.entries.set(provider, structuredClone(entry));
	}
	/** @param provider Exact provider. @param options Cancellation. @returns Completion. */
	async delete(provider: string, options: { signal?: AbortSignal } = {}): Promise<void> {
		options.signal?.throwIfAborted(); this.entries.delete(provider);
	}
}

/** Construction seam for isolated synthetic tests; never selected through environment/config. */
export interface SdkProviderServiceOptions {
	/** Explicit own directory with symlink-free ancestors; default binds canonical HOME lazily. */
	directory?: string;
	/** Read and write the pi agent's own credential file instead of Council storage. */
	shared?: boolean;
	/** Test-only factory injection, retaining production admission and storage rules. */
	providers?: readonly Provider[];
	/** Test-only own store with the same strict production implementation. */
	credentials?: CredentialService;
}

/** Read a bounded SDK/UI metadata string. @param value Metadata. @returns Terminal-safe text. */
function display(value: string): string { return value.replace(/[\x00-\x1f\x7f-\x9f]/g, " ").slice(0, 512); }

/** Reject unsupported runtime overrides without inspecting secret values. @param value Request object. @param keys Allowed fields. @returns Validity. */
function knownKeys(value: object, keys: Set<string>): boolean { return Object.keys(value).every(key => keys.has(key)); }

/** Validate integer budgets without clamping. @param value Requested value. @param max Upper bound. @returns Validity. */
function budget(value: number | undefined, max: number): boolean { return value === undefined || (Number.isSafeInteger(value) && value > 0 && value <= max); }

/** Preserve UTF-8 byte bounds without split code points. @param text Chunk. @param bytes Remaining capacity. @returns Bounded string. */
function prefix(text: string, bytes: number): string { return Buffer.from(text).subarray(0, Math.max(0, bytes)).toString("utf8").replace(/\uFFFD$/, ""); }

/** Normalize numeric usage only. @param value SDK counter. @returns Safe counter. */
function counter(value: number): number { return Number.isFinite(value) && value >= 0 ? value : 0; }

/** Preserve positive SDK usage without treating SDK-initialized zeros as provider reports.
 * Admitted SDK adapters expose uncached input separately from cache counters. SDK loses
 * field-source presence, so all-zero usage is unknown and zero cache fields stay absent.
 * This can omit a real zero report; it cannot manufacture one from an HTTP failure.
 * @param usage SDK terminal counters, including positive partial usage after failure.
 * @returns Council usage when any admitted counter is positive; otherwise undefined.
 */
function usageSummary(usage: Usage): BackendResult["usage"] {
	const input = counter(usage.input); const output = counter(usage.output);
	const read = counter(usage.cacheRead); const write = counter(usage.cacheWrite);
	if (input === 0 && output === 0 && read === 0 && write === 0) return undefined;
	return { inputTokens: input, outputTokens: output,
		...(read > 0 ? { cacheReadInputTokens: read } : {}),
		...(write > 0 ? { cacheCreationInputTokens: write } : {}) };
}

/** Classify private errors by safe code, never their message or serialization. @param error SDK/storage failure. @returns Safe text. */
function accountError(error: unknown): string {
	let current = error;
	for (let depth = 0; depth < 4 && current && typeof current === "object"; depth++) {
		if (current instanceof SdkCredentialError) return current.message;
		current = "cause" in current ? current.cause : undefined;
	}
	return "Provider login failed. Check account details and try again.";
}

/** Race transient UI input against SDK cancellation without waiting for an abandoned UI prompt. @param task Input. @param signal Cancellation. @returns Answer. */
function cancellableInput(task: Promise<string>, signal: AbortSignal): Promise<string> {
	return new Promise((resolve, reject) => {
		/** Remove listener and return answer. @param value UI response. @returns Nothing. */
		const finish = (value: string): void => { signal.removeEventListener("abort", abort); resolve(value); };
		/** Remove listener and reject safely. @param error Private failure. @returns Nothing. */
		const fail = (error: unknown): void => { signal.removeEventListener("abort", abort); reject(error); };
		/** Abort this SDK prompt, not persistence. @returns Nothing. */
		const abort = (): void => { fail(signal.reason); };
		signal.addEventListener("abort", abort, { once: true });
		task.then(finish, fail);
		if (signal.aborted) abort();
	});
}

/** Map public SDK-owned login to frozen Council interaction. @param ui Transient bridge. @param signal Deadline/caller cancellation. @returns SDK interaction. */
function authInteraction(ui: SdkAuthInteraction, signal: AbortSignal, provider: string): AuthInteraction {
	return {
		signal,
		/** @param prompt SDK input metadata. @returns Transient input. */
		prompt: async (prompt: AuthPrompt): Promise<string> => {
			const combined = prompt.signal ? AbortSignal.any([signal, prompt.signal]) : signal;
			combined.throwIfAborted();
			const label = prompt.type === "select"
				? `${display(prompt.message)} ${prompt.options.map(option => `${option.id}: ${display(option.label)}`).join("; ")}`
				: display(prompt.message);
			return cancellableInput(ui.prompt({ label, secret: prompt.type === "secret" || prompt.type === "manual_code",
				placeholder: "placeholder" in prompt ? prompt.placeholder : undefined }), combined);
		},
		/** @param event SDK event, never an error. @returns Nothing. */
		notify: (event: AuthEvent): void => {
			if (signal.aborted) return;
			if (event.type === "auth_url") {
				const url = new URL(event.url);
				if (url.protocol !== "https:" || url.username || url.password || !(LOGIN_URL_HOSTS[provider] ?? []).includes(url.hostname)) throw new Error("Unsupported login URL.");
				ui.onEvent({ type: "url", url: url.href, instructions: event.instructions && display(event.instructions) });
			} else if (event.type === "progress" || event.type === "info") {
				ui.onEvent({ type: "progress", message: display(event.message) });
			}
		},
	};
}

/** Direct SDK provider/account boundary with no ambient authentication or automatic refresh/discovery. */
class CouncilSdkProviderService implements SdkProviderService {
	readonly #barrier: SdkOperationBarrier;
	readonly #credentials: CredentialService;
	readonly #models: MutableModels;
	readonly #testProviders: readonly Provider[] | undefined;
	/** @param options Explicit synthetic seams or production defaults. No storage reads here. */
	constructor(options: SdkProviderServiceOptions) {
		this.#credentials = options.credentials ?? (options.shared ? new PiSharedCredentials(options.directory) : new SdkCredentials(options.directory));
		this.#barrier = this.#credentials.barrier;
		this.#testProviders = options.providers;
		this.#models = this.#operationModels();
	}
	/** Fresh factories per operation; metadata never resolves auth. @param captureCredential Private observer of resolved wire credentials. @returns Explicit isolated collection. */
	#operationModels(captureCredential?: (credential: string) => void): MutableModels {
		const models = createModels({ credentials: this.#credentials, modelsStore: new CouncilModelsStore(),
			authContext: { env: async () => undefined, fileExists: async () => false } });
		const providers = this.#testProviders ?? PROVIDER_FACTORIES();
		for (const provider of providers) {
			if (!PROVIDER_IDS.includes(provider.id as typeof PROVIDER_IDS[number]) || models.getProvider(provider.id)) throw new Error("Unsupported SDK provider factory.");
			const expectedUrl = EXPECTED_BASE_URLS[provider.id];
			const bundled = Object.freeze(provider.getModels().map(model => {
				if (!this.#testProviders && (model.provider !== provider.id || model.baseUrl !== expectedUrl)) throw new Error("Unsupported SDK model endpoint.");
				return Object.freeze({ ...model, headers: model.headers && Object.freeze({ ...model.headers }), compat: model.compat && Object.freeze({ ...model.compat }),
					thinkingLevelMap: model.thinkingLevelMap && Object.freeze({ ...model.thinkingLevelMap }) });
			}));
			/** Freeze effective auth/tenant routing without changing global environment. @param model Exact model. @param options Resolved SDK options. @returns Public provider options. */
			const ownOptions = (model: Model<Api>, options: ProviderRequestOptions = {}): Pick<ProviderRequestOptions, "headers" | "fetch"> => {
				if (!this.#testProviders && model.baseUrl !== expectedUrl) throw new Error("Unsupported SDK model endpoint.");
				if (sdkVendorEnvironmentError(provider.id)) throw new Error("Unsupported SDK vendor environment.");
				// openai-codex resolves OAuth into a composed bearer string; only the
				// plain openai provider takes literal sk- API keys.
				if (provider.id === "openai" && !options.apiKey?.startsWith("sk-")) throw new Error("OpenAI API key format is unsupported.");
				if (options.apiKey) captureCredential?.(options.apiKey);
				return { headers: { ...options.headers, "OpenAI-Organization": null, "OpenAI-Project": null, "api-key": null },
					fetch: sdkOwnFetch(provider.id, model.baseUrl, options.apiKey, options.fetch ?? globalThis.fetch, () => this.#credentials.assertRevision(provider.id)) };
			};
			const apiKey = provider.auth.apiKey;
			// Expose only OAuth logins whose stored credential shape Council admits;
			// e.g. the plain openai provider ships a ChatGPT flow we must not offer.
			const oauth = OAUTH_PROVIDERS.has(provider.id) ? provider.auth.oauth : undefined;
			models.setProvider({ ...provider, getModels: () => bundled,
				/** Guard resolved identity/transport; retain generic API-specific options. @param model Pin. @param context Transcript. @param streamOptions SDK options. @returns SDK stream. */
				stream: (model, context, streamOptions) => {
					this.#credentials.assertRevision(provider.id);
					return provider.stream(model, context, { ...streamOptions, ...ownOptions(model, streamOptions) } as unknown as typeof streamOptions);
				},
				/** Guard resolved identity/transport without changing thinking mapping. @param model Pin. @param context Transcript. @param streamOptions SDK options. @returns SDK stream. */
				streamSimple: (model, context, streamOptions) => {
					this.#credentials.assertRevision(provider.id);
					return provider.streamSimple(model, context, { ...streamOptions, ...ownOptions(model, streamOptions) });
				}, auth: {
				apiKey: apiKey && { ...apiKey, login: apiKey.login && ((interaction) => this.#barrier.track(() => apiKey.login!(interaction))) },
				oauth: oauth && { ...oauth, login: (interaction, loginOptions) => this.#barrier.track(() => oauth.login(interaction, loginOptions)) },
			} });
		}
		return models;
	}
	/** Inspect stored metadata only. @returns Safe DTOs. */
	inventory(): SdkProviderSummary[] {
		return this.#models.getProviders().map(provider => ({ id: provider.id, label: display(provider.name),
			methods: [
				...(provider.auth.apiKey?.login ? [{ id: "api_key" as const, label: display(provider.auth.apiKey.name) }] : []),
				...(provider.auth.oauth ? [{ id: "oauth" as const, label: display(provider.auth.oauth.name), subscription: provider.auth.oauth.isSubscription === true }] : []),
			], account: this.#credentials.summary(provider.id) }));
	}
	/** Return static bundled chat catalog; never available-model/auth lookup. @param provider ID. @returns Safe metadata. */
	catalog(provider: string): SdkModelSummary[] {
		if (!this.#models.getProvider(provider)) return [];
		return this.#models.getModels(provider).map(model => ({ id: model.id, label: display(model.name), thinkingLevels: [...getSupportedThinkingLevels(model)] }));
	}
	/** Validate exact pins, budgets and own account without refresh. @param route Direct route. @param bounds Output cap checked before batch calls. @returns Admission and identity. */
	preflight(route: SdkRoute, bounds: SdkPreflightBounds = {}): SdkPreflight {
		if (!route || typeof route !== "object" || !knownKeys(route, ROUTE_KEYS) || typeof route.provider !== "string"
			|| !this.#models.getProvider(route.provider)) return { ok: false, revision: "unsupported", error: "Unsupported SDK provider or route override." };
		const account = this.#credentials.summary(route.provider);
		const revision = account.revision;
		if (!route.model || typeof route.model !== "string") return { ok: false, revision, error: "Pin an exact SDK model." };
		const model = this.#models.getModel(route.provider, route.model);
		if (!model) return { ok: false, revision, error: "SDK model is not in the bundled chat catalog." };
		if (route.effort !== undefined && !getSupportedThinkingLevels(model).includes(route.effort as ModelThinkingLevel)) {
			return { ok: false, revision, error: "SDK thinking level is unsupported for this model." };
		}
		const environmentError = sdkVendorEnvironmentError(route.provider);
		if (environmentError) return { ok: false, revision, error: environmentError };
		if (!bounds || !knownKeys(bounds, new Set(["maxOutputTokens"]))) return { ok: false, revision, error: "Unsupported SDK preflight bounds." };
		const budgetError = sdkBudgetError(model, route.effort, bounds.maxOutputTokens);
		if (budgetError) return { ok: false, revision, error: budgetError };
		if (account.state !== "stored") return { ok: false, revision, error: account.error ?? "Store a Council account for this SDK provider first." };
		return { ok: true, revision };
	}
	/** Store literal key through SDK-owned API-key login. @param provider ID. @param key Literal key. @param signal Cancellation. @returns Commit receipt. */
	setApiKey(provider: string, key: string, signal: AbortSignal): Promise<SdkAccountResult> {
		return this.authenticate(provider, "api_key", { onEvent: () => undefined, prompt: async () => key }, signal);
	}
	/** Run public provider login with account CAS and awaited SDK/storage cleanup. @param provider ID. @param method Admitted method. @param interaction UI bridge. @param signal Cancellation. @returns Commit receipt. */
	authenticate(provider: string, method: SdkAuthMethod, interaction: SdkAuthInteraction, signal: AbortSignal): Promise<SdkAccountResult> {
		return this.#accountOperation(provider, signal, async (combined) => {
			const selected = this.#models.getProvider(provider);
			if (!selected || !(method === "api_key" ? selected.auth.apiKey?.login : method === "oauth" && selected.auth.oauth?.login)) throw new Error("Unsupported SDK login method.");
			await this.#operationModels().login(provider, method, authInteraction(interaction, combined, provider), { agentName: "bpx-council" });
		});
	}
	/** Remove own account iff captured revision still matches. @param provider ID. @param expectedRevision Captured identity. @param signal Cancellation. @returns Local receipt, not remote revocation. */
	logout(provider: string, expectedRevision: string, signal: AbortSignal): Promise<SdkAccountResult> {
		return this.#accountOperation(provider, signal, async combined => { await this.#operationModels().logout(provider, { signal: combined }); }, expectedRevision);
	}
	/** Keep login and logout receipt accurate even after abort/commit races. @param provider ID. @param signal Cancellation. @param action SDK action. @param expectedRevision Logout identity if supplied. @returns Safe receipt after leases. */
	#accountOperation(provider: string, signal: AbortSignal, action: (signal: AbortSignal) => Promise<void>, expectedRevision?: string): Promise<SdkAccountResult> {
		if (!this.#models.getProvider(provider)) return Promise.resolve({ ok: false, changed: false, error: "Unsupported SDK provider.", account: { state: "missing", revision: "unsupported" } });
		const initial = this.#credentials.summary(provider);
		const receipt = { changed: false };
		const deadline = new AbortController();
		const combined = AbortSignal.any([signal, deadline.signal]);
		const timer = setTimeout(() => deadline.abort(), DEFAULT_TIMEOUT_MS);
		return this.#barrier.scope(async () => {
			let error: unknown;
			try {
				combined.throwIfAborted();
				if (initial.state === "invalid") throw new SdkCredentialError("storage");
				await this.#credentials.accountAction({ provider, expectedRevision: expectedRevision ?? initial.revision, receipt }, () => action(combined));
			} catch (failure) { error = failure; }
			finally { clearTimeout(timer); }
			return { ok: !error && !combined.aborted, changed: receipt.changed, cancelled: combined.aborted || undefined,
				error: combined.aborted ? "Account action cancelled." : error ? accountError(error) : undefined,
				account: this.#credentials.summary(provider) };
		});
	}
	/** Execute bounded exact text-only request with no retries/tools/auth overrides. @param request Fixed transport DTO. @param caller Optional cancellation. @returns Safe text/status after terminal result and storage drain. */
	call(request: SdkCallRequest, caller?: AbortSignal): Promise<BackendResult> {
		// Capture identity and immutable primitive request fields before the first async boundary.
		if (request && typeof request === "object") request = Object.freeze({ ...request });
		const entryRevision = request && typeof request === "object" && knownKeys(request, CALL_KEYS)
			? request.expectedRevision ?? this.preflight({ provider: request.provider, model: request.model, effort: request.effort }, { maxOutputTokens: request.maxOutputTokens }).revision : undefined;
		return this.#barrier.scope(async () => {
			if (!request || typeof request !== "object" || !knownKeys(request, CALL_KEYS)
				|| typeof request.systemPrompt !== "string" || typeof request.userMessage !== "string"
				|| !budget(request.maxOutputBytes, MAX_OUTPUT_BYTES) || !budget(request.timeoutMs, MAX_TIMEOUT_MS)
				|| !budget(request.maxOutputTokens, 128_000)) return { ok: false, text: "", error: "Invalid SDK request or unsupported override." };
			const check = this.preflight({ provider: request.provider, model: request.model, effort: request.effort }, { maxOutputTokens: request.maxOutputTokens });
			if (!check.ok) return { ok: false, text: "", error: check.error };
			const revision = entryRevision;
			if (typeof revision !== "string" || revision !== check.revision) return { ok: false, text: "", error: "SDK account changed; confirm route again." };
			const wireCredentials = new Set<string>();
			return this.#credentials.inferenceAction(request.provider, revision, () => this.#barrier.scope(async () => {
			const models = this.#operationModels(credential => { wireCredentials.add(credential); });
			const model = models.getModel(request.provider, request.model)!;
			if (!budget(request.maxOutputTokens, model.maxTokens)) return { ok: false, text: "", error: "SDK output token budget exceeds model limit." };
			const controller = new AbortController();
			const signal = caller ? AbortSignal.any([caller, controller.signal]) : controller.signal;
			let timedOut = false;
			const timer = setTimeout(() => { timedOut = true; controller.abort(); }, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
			const cap = request.maxOutputBytes ?? MAX_OUTPUT_BYTES;
			let rawBytes = 0;
			let text = "";
			let capped = false;
			let tools = false;
			let failed = false;
			let changedPayload = false;
			const tokenBudget = request.maxOutputTokens ?? Math.min(8192, model.maxTokens);
			let usage: BackendResult["usage"];
			try {
				signal.throwIfAborted();
				const stream = models.streamSimple(model, { systemPrompt: request.systemPrompt,
					messages: [{ role: "user", content: request.userMessage, timestamp: Date.now() }], tools: [] },
					{ reasoning: request.effort === "off" ? undefined : request.effort as ThinkingLevel | undefined, maxTokens: tokenBudget, maxRetries: 0, signal, cacheRetention: "none",
					// Keep codex on SSE: its WebSocket transport would bypass the guarded fetch hook.
					...(request.provider === "openai-codex" ? { transport: "sse" as const } : {}),
						fetch: sdkBoundedFetch(globalThis.fetch, Math.max(64 * 1024, cap * 8 + 64 * 1024), () => { capped = true; controller.abort(); }),
						/** Restore total ceiling only for SDK legacy thinking's additive answer budget. @param payload SDK request. @returns Public payload overlay when needed. */
						onPayload: payload => {
							if (!payload || typeof payload !== "object") { changedPayload = true; throw new Error("Unsupported SDK request payload."); }
							const body = payload as Record<string, unknown>;
							const limit = request.provider === "openai" || request.provider === "openai-codex" ? body.max_output_tokens ?? body.max_completion_tokens ?? body.max_tokens : body.max_tokens;
							const legacyThinking = request.provider === "anthropic" && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking !== true && request.effort && request.effort !== "off";
							if (body.model === model.id && legacyThinking && typeof limit === "number" && limit >= tokenBudget
								&& (!Array.isArray(body.tools) || body.tools.length === 0)) return { ...body, max_tokens: tokenBudget };
							// The ChatGPT codex backend accepts no output-token budget; accept its
							// unpinned body, byte cap and stream events still bound the answer.
							const codexUnbudgeted = request.provider === "openai-codex" && limit === undefined;
							if (body.model !== model.id || (!codexUnbudgeted && limit !== tokenBudget) || (Array.isArray(body.tools) && body.tools.length > 0)) {
								changedPayload = true; throw new Error("SDK cannot honor exact request budget/model/tools.");
							}
						} });
				try {
					for await (const event of stream) {
						if (event.type === "text_delta" || event.type === "thinking_delta" || event.type === "toolcall_delta") {
							rawBytes += Buffer.byteLength(event.delta);
							if (event.type === "text_delta") text += prefix(event.delta, cap - Buffer.byteLength(text));
							if (rawBytes > cap) { capped = true; controller.abort(); }
						}
						if (event.type.startsWith("toolcall")) { tools = true; controller.abort(); }
						if (event.type === "error") failed = true;
					}
				} finally {
					const terminal = await stream.result();
					usage = usageSummary(terminal.usage);
					let finalBytes = 0;
					for (const block of terminal.content) {
						if (block.type === "text") finalBytes += Buffer.byteLength(block.text);
						else if (block.type === "thinking") finalBytes += Buffer.byteLength(block.thinking) + Buffer.byteLength(block.thinkingSignature ?? "");
						else { tools = true; finalBytes += Buffer.byteLength(JSON.stringify(block.arguments)); }
					}
					if (finalBytes > cap) { capped = true; controller.abort(); }
					if (terminal.stopReason !== "stop") failed = true;
				}
			} catch { failed = true; }
			finally { clearTimeout(timer); }
			const stale = this.#credentials.summary(request.provider).revision !== revision;
			const error = stale ? "SDK account changed; confirm route again." : changedPayload ? "SDK cannot honor exact request budget/model/tools." : capped ? "SDK output exceeded byte limit." : tools ? "SDK tool calls are not allowed."
				: timedOut ? "SDK request timed out." : signal.aborted ? "SDK request cancelled." : failed ? "SDK provider request failed." : undefined;
			// Failed text may end inside a credential; full-value scans cannot protect that prefix.
			return { ok: !error, text: error ? "" : text, error, usage };
			}).then(result => {
				if (this.#credentials.synchronizationFailed()) return { ok: false, text: "", error: "Council credential synchronization failed; reconnect account before trying again." };
				if (this.#credentials.summary(request.provider).revision !== revision) return { ok: false, text: "", error: "SDK account changed; confirm route again." };
				// Scan joined successful text only after terminal completion and child-lease drain.
				if (result.ok && [...wireCredentials].some(credential => result.text.includes(credential))) {
					return { ...result, ok: false, text: "", error: "SDK response contains credential values." };
				}
				if (result.ok && !result.text.trim()) return { ...result, ok: false, text: "", error: "SDK provider returned no usable text." };
				return result;
			}));
		});
	}
	/** Await all owned inference/login/storage work before process exit. @returns Shutdown barrier. */
	settle(): Promise<void> { return this.#barrier.settle(); }
}

let singleton: SdkProviderService | undefined;
/** Lazily construct production boundary; construction never reads credentials or calls network.
 * Honors the global sharePiAuth opt-in: share the pi agent's logins instead of Council storage.
 * @returns Process-local service. */
export function getSdkProviderService(): SdkProviderService {
	return singleton ??= createSdkProviderService({ shared: sharedPiAuthOptedIn() });
}

/** Read only the sharePiAuth boolean from the global config; never a project file.
 * Raw read on purpose: storage selection happens before trusted-config validation.
 * @returns Whether the user opted into sharing pi's auth.json. */
function sharedPiAuthOptedIn(): boolean {
	try {
		const file = JSON.parse(readFileSync(join(homedir(), ".bpx-council.json"), "utf8")) as { sharePiAuth?: unknown };
		return file.sharePiAuth === true;
	} catch { return false; }
}

/** Construct isolated service for explicit synthetic tests or production singleton. @param options Own directory/test seams. @returns Frozen Council interface implementation. */
export function createSdkProviderService(options: SdkProviderServiceOptions = {}): SdkProviderService { return new CouncilSdkProviderService(options); }
