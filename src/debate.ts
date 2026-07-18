/**
 * debate — advocate vs critic, sequential rounds, then a synthesizer verdict.
 *
 * The advocate proposes, the critic attacks, the advocate rebuts. After N
 * rounds, the synthesizer issues a closing verdict. More expensive than
 * council (sequential, N+synth calls) but surfaces the strongest case on both
 * sides for genuinely contentious calls.
 */

import { callCliAdvisor, type CliBackendConfig } from "./backend.js";
import { SYNTHESIZER_PROMPT } from "./personas.js";
import type { BpxCouncilConfig } from "./config.js";

export interface DebateInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
	rounds?: number;
}

export type DebateResult = { ok: true; text: string } | { ok: false; error: string };

const ADVOCATE_PROMPT =
	"You are the advocate in a debate. Argue FOR the proposal. Be persuasive, cite specifics. " +
	"You will be challenged by a critic — defend your position if the critique is wrong, " +
	"concede if it's right.";

const CRITIC_PROMPT =
	"You critically reassess a position. Do NOT reflexively agree. Find the strongest case " +
	"AGAINST the position you're given. If the position is sound, acknowledge it — but stress-test " +
	"every assumption first.";

export async function runDebate(input: DebateInput): Promise<DebateResult> {
	const { question, context, config } = input;
	const rounds = Math.min(input.rounds ?? 2, 4);
	const backend = config.solo.backend as CliBackendConfig | undefined;

	if (!backend) {
		return { ok: false, error: "No backend configured." };
	}

	const baseMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	let transcript = baseMessage;

	for (let round = 0; round < rounds; round++) {
		// Advocate proposes (round 0) or rebuts (round > 0).
		const advocateMsg = round === 0
			? transcript
			: `${transcript}\n\n=== Critic's Attack ===\n(see above)\n\nDefend your position or concede. Be specific.`;
		const advocateResult = await callCliAdvisor(ADVOCATE_PROMPT, advocateMsg, backend);
		if (!advocateResult.ok) return { ok: false, error: `Advocate failed (round ${round + 1}): ${advocateResult.error}` };
		transcript += `\n\n### Advocate (round ${round + 1})\n${advocateResult.text}`;

		// Critic attacks.
		const criticMsg = `${transcript}\n\nCritically reassess the advocate's position. Do not reflexively agree.`;
		const criticResult = await callCliAdvisor(CRITIC_PROMPT, criticMsg, backend);
		if (!criticResult.ok) return { ok: false, error: `Critic failed (round ${round + 1}): ${criticResult.error}` };
		transcript += `\n\n### Critic (round ${round + 1})\n${criticResult.text}`;
	}

	// Synthesize.
	const synthMessage = `${transcript}\n\n=== Original Question ===\n${question}`;
	const synthResult = await callCliAdvisor(SYNTHESIZER_PROMPT, synthMessage, backend);

	return synthResult.ok
		? { ok: true, text: synthResult.text }
		: { ok: false, error: `Synthesis failed: ${synthResult.error}` };
}
