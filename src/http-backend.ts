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

import { readImageBase64 } from "./attachments.js";

export interface HttpBackendConfig {
	/** Image paths, inlined as base64 content blocks (anthropic). */
	images?: string[];
	type: "http";
	provider: "anthropic" | "openai" | "google";
	model: string;
	apiKeyEnv?: string;
	baseUrl?: string;
}

export interface HttpResult {
	ok: boolean;
	text: string;
	error?: string;
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

/**
 * Call an advisor model via HTTP. Uses the provider's chat/messages API.
 * Auth comes from the env var (ANTHROPIC_API_KEY etc.) — the same key the host
 * (Claude Code, Cursor, etc.) uses, so bpx-council runs as the same account.
 */
/**
 * Build Anthropic's message content: a plain string when there are no images,
 * otherwise content blocks with each image inlined as base64.
 *
 * Images come first — the API wants them ahead of the text that refers to them,
 * and it reads better to the model that way too.
 */
function anthropicContent(userMessage: string, images?: string[]): unknown {
	if (!images || images.length === 0) return userMessage;
	const blocks = images.map((path) => {
		const { mime, data } = readImageBase64(path);
		return { type: "image", source: { type: "base64", media_type: mime, data } };
	});
	return [...blocks, { type: "text", text: userMessage }];
}

export async function callHttpAdvisor(
	systemPrompt: string,
	userMessage: string,
	backend: HttpBackendConfig,
	timeoutMs = 120_000,
): Promise<HttpResult> {
	const defaults = PROVIDER_DEFAULTS[backend.provider];
	if (!defaults) return { ok: false, text: "", error: `Unknown provider: ${backend.provider}` };

	const apiKey = process.env[backend.apiKeyEnv ?? defaults.apiKeyEnv];
	if (!apiKey) {
		return { ok: false, text: "", error: `No API key found in $${backend.apiKeyEnv ?? defaults.apiKeyEnv}. Set it or use a CLI backend.` };
	}

	const model = backend.model || defaults.model;
	const baseUrl = backend.baseUrl || defaults.baseUrl;

	try {
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeoutMs);

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
					max_tokens: 4096,
					system: systemPrompt,
					messages: [{ role: "user", content: anthropicContent(userMessage, backend.images) }],
				}),
				signal: controller.signal,
			});

			clearTimeout(timer);

			if (!response.ok) {
				const body = await response.text();
				return { ok: false, text: "", error: `${backend.provider} API ${response.status}: ${body.slice(0, 200)}` };
			}

			const data = await response.json() as { content?: Array<{ type: string; text?: string }> };
			const text = (data.content ?? [])
				.filter((b): b is { type: "text"; text: string } => b.type === "text" && typeof b.text === "string")
				.map((b) => b.text)
				.join("\n")
				.trim();

			return text ? { ok: true, text } : { ok: false, text: "", error: `${backend.provider} returned no text content` };
		}

		// OpenAI (and OpenAI-compatible) — add more providers here.
		return { ok: false, text: "", error: `HTTP backend for ${backend.provider} not yet implemented` };
	} catch (e) {
		if (e instanceof Error && e.name === "AbortError") {
			return { ok: false, text: "", error: `${backend.provider} HTTP timed out after ${timeoutMs}ms` };
		}
		return { ok: false, text: "", error: `${backend.provider} HTTP failed: ${e instanceof Error ? e.message : String(e)}` };
	}
}
