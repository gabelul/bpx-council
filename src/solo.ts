/**
 * solo — one advisor model, one response. The default council mode.
 */

import { callAdvisor, type BackendConfig } from "./backend.js";
import type { BpxCouncilConfig } from "./config.js";

export interface SoloInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
}

export type SoloResult = { ok: true; text: string } | { ok: false; error: string };

const ADVISOR_SYSTEM_PROMPT =
	"You are an advisor model consulted by a coding agent. The user message contains " +
	"a question (and optionally conversation context). Return a concrete, actionable " +
	"recommendation — a PLAN, a CORRECTION, or a STOP signal. Be direct, cite specifics.";

export async function runSolo(input: SoloInput): Promise<SoloResult> {
	const { question, context, config } = input;
	const backend = (config.solo.backend ?? undefined) as BackendConfig | undefined;

	if (!backend) {
		return { ok: false, error: "No backend configured for the solo advisor." };
	}

	const userMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	const result = await callAdvisor(ADVISOR_SYSTEM_PROMPT, userMessage, backend);
	return result.ok
		? { ok: true, text: result.text }
		: { ok: false, error: result.error ?? "unknown error" };
}
