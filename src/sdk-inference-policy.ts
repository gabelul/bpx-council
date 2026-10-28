import { MIN_ANSWER_TOKENS, thinkingBudgetForLevel } from "@earendil-works/pi-ai/api/simple-options";
import type { Api, Model, ThinkingLevel } from "@earendil-works/pi-ai";

/** Refuse budgets SDK cannot honor without changing requested thinking or output cap.
 * @param model Bundled model. @param effort Validated thinking pin. @param requested Total output cap.
 * @returns Local blocker or undefined. No authentication or network.
 */
export function sdkBudgetError(model: Model<Api>, effort?: string, requested?: number): string | undefined {
	const ceiling = requested ?? Math.min(8192, model.maxTokens);
	if (!Number.isSafeInteger(ceiling) || ceiling < 1 || ceiling > Math.min(128_000, model.maxTokens)) return "SDK output token budget exceeds model limit or is invalid.";
	if (model.provider === "openai" && (model.api !== "openai-responses" || (model as Model<"openai-responses">).compat?.supportsMaxOutputTokens === false)) return "SDK model cannot honor an exact output token ceiling.";
	if (model.provider === "openai" && ceiling < 16) return "OpenAI Responses requires an output token ceiling of at least 16.";
	if (model.provider === "anthropic" && model.api !== "anthropic-messages") return "SDK model transport is unsupported.";
	if (model.provider === "anthropic" && (model as Model<"anthropic-messages">).compat?.forceAdaptiveThinking !== true && effort && effort !== "off") {
		const thinking = thinkingBudgetForLevel(effort as ThinkingLevel);
		if (!Number.isSafeInteger(thinking) || ceiling < thinking + MIN_ANSWER_TOKENS) return "Legacy Anthropic thinking level requires its full SDK thinking budget plus 1024 answer tokens; increase output ceiling or choose a lower level.";
	}
	return undefined;
}

/** Reject vendor switches that public model options cannot privately suppress.
 * @param provider Admitted ID. @returns Fixed local refusal, never environment values.
 */
export function sdkVendorEnvironmentError(provider: string): string | undefined {
	const prefix = provider === "openai" ? "OPENAI" : "ANTHROPIC";
	const logging = process.env[`${prefix}_LOG`];
	if (logging && !["off", "warn", "error"].includes(logging)) return "SDK vendor debug logging is unsupported; unset provider LOG before calling.";
	if (process.env[`${prefix}_CUSTOM_HEADERS`]) return "SDK vendor ambient custom headers are unsupported; unset provider CUSTOM_HEADERS before calling.";
	return undefined;
}

/** Bind SDK HTTP dispatch to frozen model endpoint and own resolved credential.
 * @param provider Admitted ID. @param baseUrl Frozen model endpoint. @param key SDK-resolved own credential.
 * @param transport Public SDK fetch hook. @param beforeSend Authoritative revision fence before HTTP starts. @returns Guarded transport; no global mutation.
 */
export function sdkOwnFetch(provider: string, baseUrl: string, key: string | undefined, transport: typeof fetch, beforeSend: () => void): typeof fetch {
	const base = new URL(baseUrl);
	return async (input, init) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		const expectedPath = `${base.pathname.replace(/\/$/, "")}/${provider === "openai" ? "responses" : "v1/messages"}`;
		if (!key || url.origin !== base.origin || url.pathname !== expectedPath || url.username || url.password || url.hash) throw new Error("Unsupported SDK endpoint or authentication.");
		const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
		headers.delete("openai-organization"); headers.delete("openai-project"); headers.delete("api-key");
		if (provider === "openai" || key.includes("sk-ant-oat")) { headers.set("authorization", `Bearer ${key}`); headers.delete("x-api-key"); }
		else { headers.set("x-api-key", key); headers.delete("authorization"); }
		beforeSend();
		return transport(input, { ...init, headers, redirect: "error" });
	};
}

/** Limit decoded HTTP response bytes delivered to SDK parser without interpreting provider protocol.
 * @param transport Captured fetch. @param limit Raw response ceiling. @param onLimit Abort/classify owned operation.
 * @returns Public SDK fetch hook. Upstream single-chunk/RSS allocation is not bounded here.
 */
export function sdkBoundedFetch(transport: typeof fetch, limit: number, onLimit: () => void): typeof fetch {
	return async (input, init) => {
		const response = await transport(input, init);
		if (!response.body) return response;
		const reader = response.body.getReader(); let bytes = 0;
		const body = new ReadableStream<Uint8Array>({
			/** Read one upstream chunk, rejecting excess before SDK receives it. @param controller Stream controller. @returns Completion. */
			async pull(controller) {
				try {
					const next = await reader.read();
					if (next.done) { controller.close(); reader.releaseLock(); return; }
					bytes += next.value.byteLength;
					if (bytes > limit) { onLimit(); await reader.cancel().catch(() => undefined); controller.error(new Error("SDK HTTP response exceeded byte limit.")); return; }
					controller.enqueue(next.value);
				} catch { controller.error(new Error("SDK HTTP response interrupted.")); }
			},
			/** Cancel upstream body when SDK consumer stops. @returns Cleanup. */
			async cancel() { await reader.cancel().catch(() => undefined); },
		}, { highWaterMark: 0 });
		return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
	};
}
