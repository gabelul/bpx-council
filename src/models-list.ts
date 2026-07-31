/**
 * models-list — enumerate a backend's models, where the backend lets us.
 *
 * Two sources: a CLI's own list command (codex `debug models`, opencode/crush/
 * cursor-agent `models`), or the Anthropic HTTP Models API. Which CLIs can list,
 * and how to parse each, lives in the cli-registry — this file just runs the
 * command and hands the output to the registry's parser. Backends with no list
 * (claude, gemini, qwen, amp) fall back to a free-text field in the wizard.
 *
 * Any failure returns an empty list; the caller then degrades to free-text
 * rather than erroring.
 */

import { execFileSync } from "node:child_process";
import { cliSpec, parseCodexModels, parseLineList } from "./cli-registry.js";

// Re-exported for tests and callers that want the pure parsers without the
// registry indirection.
export { parseCodexModels, parseLineList };
/** @deprecated name kept for existing imports — opencode/crush/cursor share this. */
export const parseOpencodeModels = parseLineList;

/** Can this backend enumerate its models? If not, the wizard asks for free text. */
export function backendListsModels(name: string): boolean {
	return Boolean(cliSpec(name)?.list) || name === "anthropic";
}

/** Pull model IDs out of the Anthropic Models API response. */
export function parseAnthropicModels(body: unknown): string[] {
	const data = (body as { data?: Array<{ id?: unknown }> })?.data ?? [];
	return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}

/**
 * List a backend's models, or `[]` if it can't or the attempt fails.
 *
 * CLI backends run their own list command (per the registry) and parse the
 * output; anthropic hits the HTTP Models API. Everything else returns `[]`.
 */
export async function listModels(name: string): Promise<string[]> {
	try {
		const spec = cliSpec(name);
		if (spec?.list) {
			const out = execFileSync(spec.command, spec.list.args, { encoding: "utf-8", timeout: 15_000 });
			return spec.list.parse(out);
		}
		if (name === "anthropic") {
			return await listAnthropicModels();
		}
	} catch {
		// Subprocess failed, bad JSON, network down, whatever — degrade to free text.
	}
	return [];
}

async function listAnthropicModels(): Promise<string[]> {
	const key = process.env.ANTHROPIC_API_KEY;
	if (!key) return [];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
			signal: controller.signal,
		});
		if (!res.ok) return [];
		return parseAnthropicModels(await res.json());
	} finally {
		clearTimeout(timer);
	}
}
