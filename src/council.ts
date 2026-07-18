/**
 * council — parallel multi-model consensus mode.
 *
 * N personas run in parallel (Promise.allSettled), each with a stance-injected
 * system prompt. A synthesizer merges their verdicts into one recommendation.
 * One member failing doesn't crash the council — the synthesizer works with
 * whoever replied.
 */

import { callAdvisor, type BackendConfig, type BackendResult } from "./backend.js";
import { DEFAULT_PERSONAS, SYNTHESIZER_PROMPT, type Persona } from "./personas.js";
import type { BpxCouncilConfig } from "./config.js";

export interface CouncilInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
}

export type CouncilResult =
	| { ok: true; text: string; members: Array<{ persona: string; stance: string; ok: boolean; text: string }> }
	| { ok: false; error: string };

const ADVISOR_BASE_PROMPT =
	"You are an advisor model consulted by a coding agent. Be direct, cite specifics, " +
	"give a concrete recommendation — a PLAN, a CORRECTION, or a STOP signal.";

export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
	const { question, context, config } = input;
	const backend = (config.solo.backend ?? undefined) as BackendConfig | undefined;
	if (!backend) {
		return { ok: false, error: "No backend configured." };
	}

	const personas = DEFAULT_PERSONAS;
	const userMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	// Fan out — each persona gets its own CLI call in parallel.
	const memberResults = await Promise.allSettled(
		personas.map((persona) => callCouncilMember(persona, userMessage, backend)),
	);

	const members = personas.map((persona, i) => {
		const r = memberResults[i];
		if (r.status === "fulfilled") {
			return { persona: persona.name, stance: persona.stance, ok: r.value.ok, text: r.value.text };
		}
		return { persona: persona.name, stance: persona.stance, ok: false, text: "" };
	});

	const successful = members.filter((m) => m.ok);
	if (successful.length === 0) {
		return { ok: false, error: "All council members failed." };
	}

	// Build the synthesis input — each member's verdict under a header.
	const synthesisInput = members
		.map((m) => `### ${m.persona} [${m.stance}]\n${m.ok ? m.text : `(failed: no response)`}`)
		.join("\n\n");

	const synthMessage = `${synthesisInput}\n\n=== Original Question ===\n${question}`;

	// Synthesize — one more CLI call that merges the verdicts.
	const synthResult = await callAdvisor(SYNTHESIZER_PROMPT, synthMessage, backend);

	if (!synthResult.ok) {
		// Synthesis failed — return the raw member verdicts so the caller gets something.
		const fallback = members
			.filter((m) => m.ok)
			.map((m) => `### ${m.persona} [${m.stance}]\n${m.text}`)
			.join("\n\n");
		return { ok: true, text: fallback || "No usable output.", members };
	}

	return { ok: true, text: synthResult.text, members };
}

async function callCouncilMember(
	persona: Persona,
	userMessage: string,
	backend: BackendConfig,
): Promise<BackendResult> {
	return callAdvisor(persona.systemPrompt, userMessage, backend);
}
