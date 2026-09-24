/**
 * http-backend — direct API calls to model providers (no CLI subprocess needed).
 *
 * For when bpx-council runs inside a host that has API keys in the environment
 * (Claude Code sets ANTHROPIC_API_KEY, Cursor sets keys, etc.) but doesn't have
 * a CLI installed. Uses the same key the host uses — "the same model" without
 * requiring a separate CLI or subscription.
 *
 * Currently supports Anthropic (Claude Code's provider). OpenAI and Google
 * follow the same pattern — add them when needed.
 */

import { preparedImagesError, type PreparedImage } from "./attachments.js";
import type { BackendResult, ProviderUsage } from "./backend.js";

export interface HttpBackendConfig {
	/** Image paths, inlined as base64 content blocks (anthropic). */
	images?: string[];
	/** Immutable validated bytes prepared before any HTTP request. */
	imageData?: PreparedImage[];
	type: "http";
	provider: "anthropic" | "openai" | "google";
	model?: string;
	/** Optional per-call output-token ceiling (Anthropic HTTP). */
	maxOutputTokens?: number;
	/** Per-call deadline in milliseconds. */
	timeoutMs?: number;
	apiKeyEnv?: string;
	baseUrl?: string;
}

export interface HttpResult extends BackendResult {}

/** Accept only reported nonnegative integers; absent cache fields remain unknown. */
export function anthropicUsage(value: unknown): ProviderUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const raw = value as Record<string, unknown>;
	const valid = (token: unknown): token is number => Number.isSafeInteger(token) && (token as number) >= 0;
	if (!valid(raw.input_tokens) || !valid(raw.output_tokens)) return undefined;
	const usage: ProviderUsage = { inputTokens: raw.input_tokens, outputTokens: raw.output_tokens };
	if (valid(raw.cache_creation_input_tokens)) usage.cacheCreationInputTokens = raw.cache_creation_input_tokens;
	if (valid(raw.cache_read_input_tokens)) usage.cacheReadInputTokens = raw.cache_read_input_tokens;
	return usage;
}

const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; apiKeyEnv: string; model: string }> = {
	anthropic: {
		baseUrl: "https://api.anthropic.com",
		apiKeyEnv: "ANTHROPIC_API_KEY",
		model: "claude-opus-4-8",
	},
	openai: {
		baseUrl: "https://api.openai.com",
		apiKeyEnv: "OPENAI_API_KEY",
		model: "gpt-4o",
	},
};

/** Return model ID actually placed in HTTP request, including provider default. */
export function httpModel(backend: HttpBackendConfig): string | undefined {
	return backend.model || PROVIDER_DEFAULTS[backend.provider]?.model;
}

/**
 * Put validated image blocks before text in an Anthropic message.
 * @param userMessage - Text sent with the images.
 * @param images - Frozen image data prepared by attachment validation.
 * @returns A plain string or content blocks for Anthropic's API.
 */
function anthropicContent(userMessage: string, images?: PreparedImage[]): unknown {
	if (!images || images.length === 0) return userMessage;
	const blocks = images.map(({ mime, data }) => {
		return { type: "image", source: { type: "base64", media_type: mime, data } };
	});
	return [...blocks, { type: "text", text: userMessage }];
}

/**
 * Call a supported HTTP advisor with bounded time and checked image payloads.
 * Direct callers must prepare image bytes themselves; only the CLI validates file provenance.
 * @param systemPrompt - Advisor instructions.
 * @param userMessage - User question and context.
 * @param backend - Provider route and optional frozen images.
 * @param timeoutMs - Abort deadline in milliseconds.
 * @returns Advisor text or a failure result.
 */
export async function callHttpAdvisor(
	systemPrompt: string,
	userMessage: string,
	backend: HttpBackendConfig,
	timeoutMs = 120_000,
): Promise<HttpResult> {
	const defaults = PROVIDER_DEFAULTS[backend.provider];
	if (backend.provider === "openai" || backend.provider === "google") {
		return { ok: false, text: "", error: `HTTP backend for ${backend.provider} not yet implemented. Use a CLI backend.` };
	}
	if (!defaults) return { ok: false, text: "", error: `Unknown provider: ${backend.provider}` };
	const imageError = preparedImagesError(backend.images, backend.imageData);
	if (imageError) return { ok: false, text: "", error: imageError };

	const apiKey = process.env[backend.apiKeyEnv ?? defaults.apiKeyEnv];
	if (!apiKey) {
		return { ok: false, text: "", error: `No API key found in $${backend.apiKeyEnv ?? defaults.apiKeyEnv}. Set it or use a CLI backend.` };
	}

	const model = httpModel(backend) ?? defaults.model;
	const baseUrl = backend.baseUrl || defaults.baseUrl;
	let timer: ReturnType<typeof setTimeout> | undefined;

	try {
		const controller = new AbortController();
		timer = setTimeout(() => controller.abort(), timeoutMs);

		if (backend.provider === "anthropic") {
			const response = await fetch(`${baseUrl}/v1/messages`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"x-api-key": apiKey,
					"anthropic-version": "2023-06-01",
				},
				body: JSON.stringify({
					model,
					max_tokens: backend.maxOutputTokens ?? 4096,
					system: systemPrompt,
					messages: [{ role: "user", content: anthropicContent(userMessage, backend.imageData) }],
				}),
				signal: controller.signal,
			});

			if (!response.ok) {
				const body = await response.text();
				let usage: ProviderUsage | undefined;
				try { usage = anthropicUsage((JSON.parse(body) as { usage?: unknown }).usage); }
				catch { /* Error bodies aren't guaranteed to be JSON. */ }
				return { ok: false, text: "", error: `${backend.provider} API HTTP ${response.status}`, usage };
			}

			const data = await response.json() as { content?: Array<{ type: string; text?: string }>; usage?: unknown };
			const usage = anthropicUsage(data.usage);
			const text = (data.content ?? [])
				.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.trim();

			return text ? { ok: true, text, usage } : { ok: false, text: "", error: `${backend.provider} returned no text content`, usage };
		}

		// OpenAI (and OpenAI-compatible) — add more providers here.
		return { ok: false, text: "", error: `HTTP backend for ${backend.provider} not yet implemented` };
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") {
			return { ok: false, text: "", error: `${backend.provider} HTTP timed out after ${timeoutMs}ms` };
		}
		return { ok: false, text: "", error: `${backend.provider} HTTP request failed` };
	} finally {
		if (timer) clearTimeout(timer);
	}
}
