import type { BpxCouncilConfig } from "./config.js";
import { DEFAULT_PERSONAS } from "./personas.js";

const bundled = new Set(DEFAULT_PERSONAS.map((persona) => persona.name));
const safeName = /^[a-z][a-z0-9-]{0,31}$/;

/**
 * Check config shapes before merging; repo-discovered routes get a narrower allowlist.
 * @param value - Parsed JSON, still untrusted.
 * @param path - File path included in validation errors.
 * @param project - True only for auto-discovered project config.
 */
export function validateConfig(value: unknown, path: string, project: boolean): asserts value is Partial<BpxCouncilConfig> {
	/** Throw a source-labelled validation error. */
	const fail = (key: string, reason: string): never => { throw new Error(`${path}: ${key} ${reason}`); };
	/** Narrow JSON objects without treating arrays or null as config sections. */
	const object = (v: unknown, key: string): Record<string, unknown> => {
		if (v === null || typeof v !== "object" || Array.isArray(v)) return fail(key, "must be an object");
		return v as Record<string, unknown>;
	};
	/** Reject unknown keys without printing untrusted property names, which may hold secrets. */
	const keys = (v: Record<string, unknown>, key: string, allowed: string[]) => {
		for (const name of Object.keys(v)) if (!allowed.includes(name)) fail(key, `has an unknown property (allowed: ${allowed.join(", ")})`);
	};
	/** Require nonempty string values. */
	const string = (v: unknown, key: string) => {
		if (typeof v !== "string" || !v.trim()) fail(key, "must be a nonempty string");
	};
	/** Check seat spec; null resets inherited route to Solo. */
	const route = (v: unknown, key: string) => {
		if (v === null) return;
		string(v, key);
		if (project && !/^anthropic(?::[A-Za-z0-9][A-Za-z0-9._/+-]{0,127})?(?:@(low|medium|high|xhigh|max|ultra))?$/.test(v as string)) {
			fail(key, "must use anthropic with a safe model/effort; use global config or explicit --config for CLI routes");
		}
	};
	const root = object(value, "config");
	keys(root, "config", ["defaultMode", "solo", "council", "debate", "contextWindow", "personas", "gutCheck"]);
	if (root.personas !== undefined) {
		if (project) fail("personas", "cannot define prompts in project config; use global config or explicit --config");
		const personas = object(root.personas, "personas");
		if (Object.keys(personas).length > 16) fail("personas", "must contain at most 16 definitions");
		for (const [name, definition] of Object.entries(personas)) {
			if (name === "synthesizer") fail("personas.synthesizer", "is reserved for the closing Council seat");
			if (!safeName.test(name)) fail("personas", "contains an unsafe name (lowercase letters, digits, hyphens; max 32)");
			const persona = object(definition, "personas entry");
			keys(persona, "personas entry", ["stance", "systemPrompt"]);
			if (!["for", "against", "neutral"].includes(persona.stance as string)) fail("personas entry.stance", "is invalid");
			if (typeof persona.systemPrompt !== "string" || !persona.systemPrompt.trim() || persona.systemPrompt.length > 8000) fail("personas entry.systemPrompt", "must be nonempty and at most 8000 characters");
		}
	}
	if (root.gutCheck !== undefined) {
		const gut = object(root.gutCheck, "gutCheck");
		keys(gut, "gutCheck", ["backend", "maxOutputTokens"]);
		if (gut.backend !== undefined) route(gut.backend, "gutCheck.backend");
		if (gut.maxOutputTokens !== undefined && (!Number.isSafeInteger(gut.maxOutputTokens) || (gut.maxOutputTokens as number) < 1 || (gut.maxOutputTokens as number) > 4096)) fail("gutCheck.maxOutputTokens", "must be an integer from 1 to 4096");
	}
	if (root.defaultMode !== undefined && !["solo", "council", "debate", "gut-check"].includes(root.defaultMode as string)) fail("defaultMode", "is invalid");
	if (root.contextWindow !== undefined && (!Number.isSafeInteger(root.contextWindow) || (root.contextWindow as number) < 1)) fail("contextWindow", "must be a positive integer");
	if (root.solo !== undefined) {
		const solo = object(root.solo, "solo");
		keys(solo, "solo", ["backend", "model", "thinkingLevel"]);
		if (solo.model !== undefined) string(solo.model, "solo.model");
		if (solo.thinkingLevel !== undefined && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(solo.thinkingLevel as string)) fail("solo.thinkingLevel", "is invalid");
		if (solo.backend !== undefined) {
			const backend = object(solo.backend, "solo.backend");
			keys(backend, "solo.backend", ["type", "command", "args", "timeoutMs", "startupMs", "sessionPrefix", "isolate", "images", "provider", "model", "effort", "apiKeyEnv", "baseUrl"]);
			if (!["cli", "http", "tmux"].includes(backend.type as string)) fail("solo.backend.type", "is invalid");
			if (project && backend.command !== undefined) fail("solo.backend.command", "cannot select a CLI in project config; use global config or explicit --config");
			if (project && backend.type !== "http") fail("solo.backend.type", "project config accepts only Anthropic HTTP; use global config or explicit --config for CLI routes");
			if (backend.command !== undefined) string(backend.command, "solo.backend.command");
			if (backend.provider !== undefined && !["anthropic", "openai", "google"].includes(backend.provider as string)) fail("solo.backend.provider", "is invalid");
			if ((backend.type === "cli" || backend.type === "tmux") && !backend.command) fail("solo.backend.command", "is required");
			if (backend.type === "http" && !backend.provider) fail("solo.backend.provider", "is required");
			if (backend.type !== "http" && backend.provider !== undefined) fail("solo.backend.provider", "requires an HTTP backend");
			if (backend.type === "http" && backend.command !== undefined) fail("solo.backend.command", "requires a CLI or tmux backend");
			if (backend.type !== "http" && (backend.baseUrl !== undefined || backend.apiKeyEnv !== undefined)) fail("solo.backend.baseUrl/apiKeyEnv", "requires an HTTP backend");
			if (backend.type !== "cli" && backend.args !== undefined) fail("solo.backend.args", "requires a CLI backend");
			if (backend.args !== undefined && (!Array.isArray(backend.args) || !backend.args.every((arg: unknown) => typeof arg === "string"))) fail("solo.backend.args", "must be a string array");
			for (const key of ["timeoutMs", "startupMs"]) if (backend[key] !== undefined && (!Number.isSafeInteger(backend[key]) || (backend[key] as number) < 1 || (backend[key] as number) > 1_800_000)) fail(`solo.backend.${key}`, "must be an integer from 1 to 1800000");
			if (backend.isolate !== undefined && typeof backend.isolate !== "boolean") fail("solo.backend.isolate", "must be boolean");
			if (backend.images !== undefined) fail("solo.backend.images", "cannot be configured; pass validated paths with --image");
			for (const key of ["model", "effort", "apiKeyEnv", "baseUrl", "sessionPrefix"]) if (backend[key] !== undefined) string(backend[key], `solo.backend.${key}`);
			if (project) {
				if (backend.type === "http" && backend.provider !== "anthropic") fail("solo.backend.provider", "must be anthropic in project config");
				for (const key of ["args", "apiKeyEnv", "baseUrl", "startupMs", "sessionPrefix", "isolate", "images"]) if (backend[key] !== undefined) fail(`solo.backend.${key}`, "cannot be set in project config; use global config or explicit --config");
				if (backend.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._/+-]{0,127}$/.test(backend.model as string)) fail("solo.backend.model", "contains unsafe characters");
				if (backend.effort !== undefined && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(backend.effort as string)) fail("solo.backend.effort", "is invalid");
			}
		}
	}
	if (root.council !== undefined) {
		const council = object(root.council, "council");
		keys(council, "council", ["backends", "synthesizer", "members"]);
		if (council.members !== undefined) {
			if (!Array.isArray(council.members) || council.members.length < 1 || council.members.length > 8) fail("council.members", "must contain 1 to 8 names");
			const seen = new Set<string>();
			for (const value of council.members as unknown[]) {
				if (typeof value !== "string") fail("council.members", "contains an unsafe name");
				const name = value as string;
				if (name === "synthesizer") fail("council.members", "reserves synthesizer for the closing seat");
				if (!safeName.test(name)) fail("council.members", "contains an unsafe name");
				if (seen.has(name)) fail("council.members", "contains a duplicate name");
				if (project && !bundled.has(name)) fail("council.members", "project config may select bundled personas only");
				seen.add(name);
			}
		}

		if (council.backends !== undefined) {
			const backends = object(council.backends, "council.backends");
			for (const [seat, spec] of Object.entries(backends)) {
				if (seat === "synthesizer") fail("council.backends.synthesizer", "is reserved; use council.synthesizer");
				if (!safeName.test(seat)) fail("council.backends", "contains an unsafe persona name");
				if (project && !bundled.has(seat)) fail("council.backends", "contains a non-bundled council seat");
				// Bundled project seats have fixed names; trusted custom names stay private.
				route(spec, project ? `council.backends.${seat}` : "council.backends entry");
			}
		}
		if (council.synthesizer !== undefined) route(council.synthesizer, "council.synthesizer");
	}
	if (root.debate !== undefined) {
		const debate = object(root.debate, "debate");
		keys(debate, "debate", ["advocate", "critic", "synthesizer"]);
		for (const [seat, spec] of Object.entries(debate)) if (spec !== undefined) route(spec, `debate.${seat}`);
	}
}
