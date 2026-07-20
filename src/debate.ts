/**
 * debate — advocate vs critic, sequential rounds, then a synthesizer verdict.
 *
 * The advocate proposes, the critic attacks, the advocate rebuts. After N
 * rounds, the synthesizer issues a closing verdict. More expensive than
 * council (sequential, N+synth calls) but surfaces the strongest case on both
 * sides for genuinely contentious calls.
 */

import { callAdvisor, type BackendConfig } from "./backend.js";
import { SYNTHESIZER_PROMPT } from "./personas.js";
import type { BpxCouncilConfig } from "./config.js";

export interface DebateInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
	rounds?: number;
}

export type DebateResult =
	| { ok: true; text: string }
	/** `partial` carries any rounds that completed before the failure. */
	| { ok: false; error: string; partial?: string };

/**
 * Progress goes to stderr, never stdout.
 *
 * A debate is five sequential model calls — several minutes of nothing if we
 * stay quiet, which reads as "hung" and gets ctrl-C'd before it ever finishes.
 * stderr keeps `bpx-council ... > out.md` clean while the human still sees
 * that something is happening.
 */
function note(line: string): void {
	process.stderr.write(`${line}\n`);
}

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
	const backend = (config.solo.backend ?? undefined) as BackendConfig | undefined;

	if (!backend) {
		return { ok: false, error: "No backend configured." };
	}

	const baseMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	// `transcript` is what the models see (question + context + every turn so
	// far). `roundLog` is what the *user* sees — the same turns without their
	// own question echoed back at them. Two audiences, two strings.
	let transcript = baseMessage;
	const roundLog: string[] = [];

	/** Rounds so far, formatted for display. Empty until the advocate opens. */
	const partial = () => roundLog.join("\n\n");

	/**
	 * Bail out, but hand back everything already earned.
	 *
	 * A five-call debate will eventually lose a call to a timeout — that's
	 * normal, not exceptional. Throwing away four good rounds because the
	 * fifth timed out wastes minutes of real work. Same instinct as
	 * council.ts, which returns raw member verdicts when synthesis fails.
	 */
	const bail = (error: string): DebateResult => {
		const done = partial();
		if (!done) return { ok: false, error };
		note(`\n⚠ ${error}`);
		note("Returning the rounds that did complete.\n");
		// Still `ok: false` — the caller is often another coding agent, and a
		// zero exit code would tell it everything went fine. The work rides
		// along in `partial` so nothing is lost either way.
		return { ok: false, error, partial: `${done}\n\n### Verdict\n_Incomplete — ${error}_` };
	};

	for (let round = 0; round < rounds; round++) {
		// Advocate proposes (round 0) or rebuts (round > 0). The critic's
		// attack is already the tail of `transcript`, so the rebuttal prompt
		// only has to point at it.
		const advocateMsg = round === 0
			? transcript
			: `${transcript}\n\nDefend your position against the critique above, or concede it. Be specific.`;

		note(`── round ${round + 1}/${rounds}: advocate …`);
		const advocateResult = await callAdvisor(ADVOCATE_PROMPT, advocateMsg, backend);
		if (!advocateResult.ok) return bail(`Advocate failed (round ${round + 1}): ${advocateResult.error}`);
		const advocateTurn = `### Advocate (round ${round + 1})\n${advocateResult.text}`;
		transcript += `\n\n${advocateTurn}`;
		roundLog.push(advocateTurn);

		// Critic attacks.
		const criticMsg = `${transcript}\n\nCritically reassess the advocate's position. Do not reflexively agree.`;

		note(`── round ${round + 1}/${rounds}: critic …`);
		const criticResult = await callAdvisor(CRITIC_PROMPT, criticMsg, backend);
		if (!criticResult.ok) return bail(`Critic failed (round ${round + 1}): ${criticResult.error}`);
		const criticTurn = `### Critic (round ${round + 1})\n${criticResult.text}`;
		transcript += `\n\n${criticTurn}`;
		roundLog.push(criticTurn);
	}

	// Synthesize.
	note("── synthesizing verdict …");
	const synthMessage = `${transcript}\n\n=== Original Question ===\n${question}`;
	const synthResult = await callAdvisor(SYNTHESIZER_PROMPT, synthMessage, backend);
	if (!synthResult.ok) return bail(`Synthesis failed: ${synthResult.error}`);

	note("");

	// Return the debate, not just the ruling. Watching the advocate and critic
	// actually go at each other is the reason to pay for this mode instead of
	// solo — collapsing it to the verdict makes an expensive call look cheap.
	return { ok: true, text: `${partial()}\n\n### Verdict\n${synthResult.text}` };
}
