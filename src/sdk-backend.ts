import type { AdvisorCallContext, BackendResult } from "./backend.js";
import { getSdkProviderService } from "./sdk-provider-service.js";
import { isSdkProviderId, sdkAmbientModelError } from "./sdk-route.js";
import type { SdkPreflight } from "./sdk-types.js";

/** Direct, tool-free provider route. No credential, endpoint or CLI settings. */
export interface SdkBackendConfig {
	type: "sdk";
	provider: string;
	model?: string;
	effort?: string;
	timeoutMs?: number;
	maxOutputTokens?: number;
	maxOutputBytes?: number;
	/** Unsupported inputs retained only so preflight can reject rather than discard. */
	images?: string[];
}

/** Validate SDK route locally before any member starts; never refreshes or calls provider.
 * @param backend Exact provider route. @returns Safe blocker and opaque account generation.
 */
export function preflightSdkBackend(backend: SdkBackendConfig): SdkPreflight {
	/** Build a local refusal without reading account storage. @param error Safe reason. @returns Blocked preflight. */
	const fail = (error: string): SdkPreflight => ({ ok: false, error, revision: "" });
	if (!isSdkProviderId(backend.provider)) return fail("SDK provider ID is invalid");
	if (backend.images?.length || (backend as { imageData?: unknown[] }).imageData?.length) return fail("SDK advisor image transport is not supported; use codex or anthropic HTTP");
	for (const field of ["args", "command", "apiKeyEnv", "baseUrl", "startupMs", "sessionPrefix", "isolate"]) {
		if ((backend as unknown as Record<string, unknown>)[field] !== undefined) return fail("SDK routes cannot carry CLI or HTTP settings");
	}
	if (!backend.model) return fail("SDK routes require an explicit bundled catalog model");
	if (backend.effort === "ultra") return fail("SDK thinking level ultra is unsupported");
	const bounds: [number | undefined, number][] = [[backend.timeoutMs, 600_000], [backend.maxOutputTokens, 128_000], [backend.maxOutputBytes, 4 * 1024 * 1024]];
	for (const [value, max] of bounds) {
		if (value !== undefined && (!Number.isSafeInteger(value) || value < 1 || value > max)) return fail("SDK call bounds exceed supported limits or are not positive integers");
	}
	const ambientError = sdkAmbientModelError(backend);
	if (ambientError) return fail(ambientError);
	try { return getSdkProviderService().preflight({ provider: backend.provider, model: backend.model, effort: backend.effort }, { maxOutputTokens: backend.maxOutputTokens }); }
	catch { return fail("SDK route preflight failed; check provider, model and local account"); }
}

/** Dispatch exact SDK model and effort; service owns timeout, abort and cleanup barrier.
 * @param systemPrompt Advisor instructions. @param userMessage Supplied context.
 * @param backend Exact route and bounds. @param signal Optional cancellation. @param context Original confirmed account generation.
 * @returns Safe result after owned SDK work settles.
 */
export async function callSdkAdvisor(systemPrompt: string, userMessage: string, backend: SdkBackendConfig, signal?: AbortSignal, context?: AdvisorCallContext): Promise<BackendResult> {
	if (signal?.aborted) return { ok: false, text: "", error: "Advisor call cancelled" };
	const checked = preflightSdkBackend(backend);
	if (!checked.ok) return { ok: false, text: "", error: checked.error ?? "SDK route is not ready" };
	const original = context?.sdkAccountRevision ?? checked.revision;
	if (original !== checked.revision) return { ok: false, text: "", error: "SDK account changed; reconfirm before calling" };
	try {
		return await getSdkProviderService().call({
			provider: backend.provider, model: backend.model!, effort: backend.effort, expectedRevision: original,
			systemPrompt, userMessage, timeoutMs: backend.timeoutMs ?? 120_000,
			maxOutputTokens: backend.maxOutputTokens, maxOutputBytes: backend.maxOutputBytes,
		}, signal);
	} catch { return { ok: false, text: "", error: signal?.aborted ? "Advisor call cancelled" : "SDK advisor call failed" }; }
}
