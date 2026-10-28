import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { advisorTransportError, callAdvisor, type BackendConfig, type AdvisorCallContext } from "./backend.js";
import { CLI_BACKENDS } from "./cli-registry.js";
import type { BpxCouncilConfig } from "./config.js";
import { routeSpec, type RouteTarget } from "./config-editor.js";
import { detectBackend, resolveSeatBackend } from "./detect.js";
import { httpModel } from "./http-backend.js";
import { preflightSdkBackend } from "./sdk-backend.js";
import { serializeSdkRoute } from "./sdk-route.js";

export type PersonaCandidate = { name: string; stance: "for" | "against" | "neutral"; systemPrompt: string };
export type ActionPreflight = { route: string; error?: string; warning?: string; /** Opaque SDK account generation, never display. */ revision?: string };
export type RouteTestResult = { ok: boolean; route: string; elapsedMs: number; text: string; error?: string; cancelled?: boolean };
export interface PersonaGenerationResult extends RouteTestResult { candidate?: PersonaCandidate }
export type ConfigActions = {
	preflight(draft: BpxCouncilConfig, target: RouteTarget, purpose?: "test" | "generate"): ActionPreflight;
	test(draft: BpxCouncilConfig, target: RouteTarget, signal: AbortSignal, context?: AdvisorCallContext): Promise<RouteTestResult>;
	generate(draft: BpxCouncilConfig, target: RouteTarget, focus: string, signal: AbortSignal, context?: AdvisorCallContext): Promise<PersonaGenerationResult>;
};

const AMBIENT_MODEL_ERROR = "Clear BPX_COUNCIL_MODEL/ANTHROPIC_MODEL before testing or generating with the selected draft model; ambient override selects a different model.";
const PROBE_SYSTEM = "You are a connection probe. No tools or workspace context. Reply with OK only, at most 8 tokens.";
const CODEX_PROBE_SYSTEM = "You are a basic connection probe. Do not use tools. Reply with OK only, at most 8 tokens.";
const CODEX_PROBE_WARNING = "Basic connection test only. Codex uses a read-only sandbox; tools may remain available. This call uses your Codex quota.";
const GENERATOR_SYSTEM = 'Create one Council persona from the supplied description. Return only JSON matching this schema: {"type":"object","additionalProperties":false,"required":["name","stance","systemPrompt"],"properties":{"name":{"type":"string","pattern":"^[a-z][a-z0-9-]{0,31}$","maxLength":32},"stance":{"enum":["for","against","neutral"]},"systemPrompt":{"type":"string","minLength":1,"maxLength":8000}}}. Name synthesizer is reserved. Do not use tools. Limit reply to 2400 tokens.';

/** Resolve a clone using runtime Solo defaults, then the independent seat override.
 * @param draft Unsaved settings. @param target Seat identity. @returns Exact effective route without touching source settings.
 */
export function resolveActionBackend(draft: BpxCouncilConfig, target: RouteTarget): BackendConfig {
	const clone = structuredClone(draft);
	const shared = (clone.solo?.backend ?? detectBackend()) as BackendConfig;
	const legacy = clone.solo?.thinkingLevel;
	if (legacy && !(shared as { effort?: string }).effort) (shared as { effort?: string }).effort = legacy;
	const spec = target.section === "advisor" ? undefined : routeSpec(clone, target);
	const model = process.env.BPX_COUNCIL_MODEL ?? process.env.ANTHROPIC_MODEL;
	if (model && shared.type !== "sdk" && spec == null && clone.solo?.backend?.model && model !== clone.solo.backend.model) throw new Error(AMBIENT_MODEL_ERROR);
	if (model && shared.type !== "sdk") shared.model = model;
	const backend = target.section === "advisor" ? shared : resolveSeatBackend(spec, shared);
	if (backend.type === "sdk" && target.section === "gut-check" && clone.gutCheck?.maxOutputTokens !== undefined) backend.maxOutputTokens = clone.gutCheck.maxOutputTokens;
	return backend;
}

/** Label actual dispatched model without exposing argv, endpoints or auth.
 * @param backend Resolved route. @returns Backend/model/effort attribution; literal @ remains intact.
 */
export function actionRouteLabel(backend: BackendConfig): string {
	if (backend.type === "sdk") return cleanText(serializeSdkRoute(backend), 512);
	if (backend.type === "http") return cleanText(`${backend.provider}:${httpModel(backend) ?? "default"}`, 512);
	const effort = backend.type === "cli" ? backend.effort : undefined;
	const label = `${backend.type === "tmux" ? "tmux/" : ""}${backend.command}${backend.model ? `:${backend.model}` : ""}${effort ? `@${effort}` : ""}`;
	return cleanText(label, 512);
}

/** Remove terminal controls and known credential values from provider text.
 * @param value Untrusted output. @param limit Character ceiling. @returns Safe bounded display text.
 */
function cleanText(value: string, limit: number): string {
	let clean = value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
	for (const [name, secret] of Object.entries(process.env)) {
		if (secret && secret.length >= 4 && /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name)) clean = clean.split(secret).join("[redacted]");
	}
	return clean.slice(0, limit);
}

/** Keep generation tool-disabled; allow Codex's normal read-only preset for basic probes.
 * @param backend Exact effective route. @param purpose Probe or persona generation. @returns Actionable blocker, or undefined for eligible transport.
 */
function eligibilityError(backend: BackendConfig, purpose: "test" | "generate"): string | undefined {
	if (backend.type === "sdk") {
		const checked = preflightSdkBackend(backend);
		return checked.ok ? undefined : checked.error ?? "SDK route is not ready";
	}
	if (!["cli", "http", "tmux"].includes(backend.type)) return "Workbench action transport is unsupported. Select Claude, Pi or Anthropic HTTP.";
	if (backend.type === "tmux") return "Route tests cannot isolate or cancel tmux safely. Select Claude, Pi or Anthropic HTTP.";
	if (backend.type === "cli") {
		if (backend.args !== undefined) return "Custom CLI args cannot be tested safely. Remove args to use a guarded preset.";
		if (process.platform === "win32") return "Workbench CLI actions require descendant-safe cancellation, unavailable on Windows. Choose Anthropic HTTP.";
		const preset = CLI_BACKENDS[backend.command];
		if (!preset || preset.unusable) return "CLI preset is unknown or unusable. Select Claude, Pi or Anthropic HTTP.";
		if (backend.command === "codex" && purpose === "generate") return "Codex AI persona generation is not supported here. Choose Pi, Claude or stock Anthropic HTTP; Codex basic connection tests and normal advisor calls remain available.";
		if (!["claude", "pi", "codex"].includes(backend.command)) return "Connection tests and AI drafts aren't supported for this CLI. Installation checks still work; choose Pi, Claude or Anthropic for model calls here.";
		// Catalog may offer ultra beyond the static fallback; never discover or clamp a selected pin here.
		const effortLevels = backend.command === "codex" ? ["low", "medium", "high", "xhigh", "ultra"] : preset.effort?.levels;
		if (backend.effort !== undefined && !effortLevels?.includes(backend.effort)) return "Selected effort is unsupported by this guarded CLI preset.";
	}
	if (backend.type === "http" && (backend.baseUrl !== undefined || backend.apiKeyEnv !== undefined)) return "Workbench HTTP actions use stock Anthropic endpoint and ANTHROPIC_API_KEY only. Custom endpoint/key routes remain valid for normal advisor calls, but cannot be tested or used for generation here.";
	if (backend.images?.length || (backend.type === "http" && backend.imageData?.length)) return "Route tests do not send images or workspace files. Remove image inputs from this route.";
	if (backend.timeoutMs !== undefined && (!Number.isSafeInteger(backend.timeoutMs) || backend.timeoutMs < 1)) return "Route timeout must be a positive integer.";
	const error = advisorTransportError(backend);
	return error ? cleanText(error, 512) : undefined;
}

/** Preflight runs no discovery CLI, provider request or scratch write.
 * @param draft Unsaved settings. @param target Route identity. @param purpose Action type, defaulting to a connection test. @returns Attempted route, safety blocker and basic-mode warning.
 */
function preflight(draft: BpxCouncilConfig, target: RouteTarget, purpose: "test" | "generate" = "test"): ActionPreflight {
	try {
		const backend = resolveActionBackend(draft, target);
		const error = eligibilityError(backend, purpose);
		const sdk = backend.type === "sdk" ? preflightSdkBackend(backend) : undefined;
		const warning = !error && backend.type === "sdk"
			? `SDK call retains selected thinking and output ceiling (${backend.maxOutputTokens ?? "default, up to 8192"} tokens). Provider quota/billing applies.`
			: !error && backend.type === "cli" && backend.command === "codex" ? CODEX_PROBE_WARNING : undefined;
		return { route: actionRouteLabel(backend), error, ...(sdk ? { revision: sdk.revision } : {}), ...(warning ? { warning } : {}) };
	} catch (error) { return { route: "Unresolved route", error: error instanceof Error && error.message === AMBIENT_MODEL_ERROR ? AMBIENT_MODEL_ERROR : "Could not resolve route. Choose an explicit guarded backend and valid seat spec." }; }
}

/** Parse literal JSON, optionally enclosed by one Markdown fence; never evaluate output.
 * @param text Provider response. @returns Strict candidate or throws a safe schema error.
 */
export function parsePersonaCandidate(text: string): PersonaCandidate {
	if (text.length > 32_768) throw new Error("Generated persona response is too large.");
	const literal = text.trim().replace(/^```(?:json)?\s*\n([\s\S]*?)\n```$/i, "$1");
	let parsed: unknown;
	try { parsed = JSON.parse(literal); } catch { throw new Error("Generated persona must be literal JSON."); }
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Generated persona must be an object.");
	const value = parsed as Record<string, unknown>;
	if (Object.keys(value).length !== 3 || Object.keys(value).some((key) => !["name", "stance", "systemPrompt"].includes(key))) throw new Error("Generated persona contains missing or unknown fields.");
	if (typeof value.name !== "string" || !/^[a-z][a-z0-9-]{0,31}$/.test(value.name) || value.name === "synthesizer") throw new Error("Generated persona name must be a lowercase slug, max 32 characters, not synthesizer.");
	if (!["for", "against", "neutral"].includes(value.stance as string)) throw new Error("Generated persona stance must be for, against or neutral.");
	if (typeof value.systemPrompt !== "string" || !value.systemPrompt.trim() || value.systemPrompt.length > 8000) throw new Error("Generated persona prompt must contain 1–8000 characters.");
	if (cleanText(value.systemPrompt, 8000) !== value.systemPrompt) throw new Error("Generated persona prompt contains terminal controls or credential values.");
	return { name: value.name, stance: value.stance as PersonaCandidate["stance"], systemPrompt: value.systemPrompt };
}

/** Dispatch a tiny probe or explicit persona description on the chosen draft route.
 * @param draft Unsaved settings. @param target Seat identity. @param signal Transport cancellation. @param focus Generator description, absent for probes.
 * @returns Bounded, private result after transport and scratch cleanup finish.
 */
async function run(draft: BpxCouncilConfig, target: RouteTarget, signal: AbortSignal, focus?: string, context?: AdvisorCallContext): Promise<PersonaGenerationResult> {
	const started = performance.now();
	let route = "Unresolved route";
	let cwd: string | undefined;
	const result = (fields: Omit<PersonaGenerationResult, "route" | "elapsedMs">): PersonaGenerationResult => ({ ...fields, route, elapsedMs: Math.round(performance.now() - started) });
	if (signal.aborted) return result({ ok: false, text: "", cancelled: true, error: "Action cancelled." });
	try {
		const backend = resolveActionBackend(draft, target);
		route = actionRouteLabel(backend);
		const error = eligibilityError(backend, focus === undefined ? "test" : "generate");
		if (error) return result({ ok: false, text: "", error });
		if (focus !== undefined && (!focus.trim() || focus.length > 8000 || cleanText(focus, 8000) !== focus)) return result({ ok: false, text: "", error: "Persona description must contain 1–8000 characters, without terminal controls or credential values." });
		if (signal.aborted) return result({ ok: false, text: "", cancelled: true, error: "Action cancelled." });
		backend.timeoutMs = Math.min(backend.timeoutMs ?? 120_000, focus === undefined ? 15_000 : 45_000);
		if (backend.type === "cli") {
			backend.isolate = true;
			backend.maxStdoutBytes = focus === undefined ? 4096 : 32_768;
			// Pi owns its private cwd; other CLIs receive this transient path, never config.cwd.
			if (backend.command !== "pi") cwd = mkdtempSync(join(tmpdir(), "bpx-council-action-"));
		} else if (backend.type === "sdk") {
			// Keep the exact ceiling admitted before consent; tiny probe caps break SDK thinking/minimums.
			backend.maxOutputBytes = focus === undefined ? 4096 : 32_768;
		} else if (backend.type === "http") {
			backend.maxOutputTokens = focus === undefined ? 8 : 2400;
			backend.maxResponseBytes = focus === undefined ? 16_384 : 65_536;
		}
		const probeSystem = backend.type === "cli" && backend.command === "codex" ? CODEX_PROBE_SYSTEM : PROBE_SYSTEM;
		const response = await callAdvisor(focus === undefined ? probeSystem : GENERATOR_SYSTEM, focus === undefined ? "Reply OK." : `Description: ${JSON.stringify(focus)}`, backend, signal, backend.type === "sdk" ? context : cwd);
		if (signal.aborted) return result({ ok: false, text: "", cancelled: true, error: response.error?.includes("cleanup could not be confirmed") ? "Action cancelled; subprocess cleanup could not be confirmed." : "Action cancelled." });
		if (!response.ok) return result({ ok: false, text: "", error: cleanText(response.error ?? "Route call failed.", 512) });
		// Do not expose arbitrary smoke-test stdout: a response is not proof of model identity.
		if (focus === undefined) return result({ ok: true, text: "Route responded." });
		const key = backend.type === "http" ? process.env[backend.apiKeyEnv ?? "ANTHROPIC_API_KEY"] : undefined;
		if (key && response.text.includes(key)) return result({ ok: false, text: "", error: "Generated persona response contains credential values." });
		const candidate = parsePersonaCandidate(response.text);
		return result({ ok: true, text: JSON.stringify(candidate), candidate });
	} catch (error) {
		return result({ ok: false, text: "", cancelled: signal.aborted || undefined, error: signal.aborted ? "Action cancelled." : error instanceof Error && (error.message.startsWith("Generated persona") || error.message === AMBIENT_MODEL_ERROR) ? error.message : "Route action failed. Check backend configuration and compatibility." });
	} finally { if (cwd) rmSync(cwd, { recursive: true, force: true }); }
}

export const defaultConfigActions: ConfigActions = {
	preflight,
	test: (draft, target, signal, context) => run(draft, target, signal, undefined, context),
	generate: (draft, target, focus, signal, context) => run(draft, target, signal, focus, context),
};
