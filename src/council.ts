/**
 * council — parallel multi-model consensus mode.
 *
 * N personas run in parallel (Promise.allSettled), each with a stance-injected
 * system prompt. A synthesizer merges their verdicts into one recommendation.
 * One member failing doesn't crash the council — the synthesizer works with
 * whoever replied.
 */

import { advisorTransportError, callAdvisor, type BackendConfig, type BackendResult } from "./backend.js";
import { DEFAULT_PERSONAS, SYNTHESIZER_PROMPT, type Persona } from "./personas.js";
import { backendLabel, resolveSeatBackend, textOnlyImageWarning, type SeatOptions } from "./detect.js";
import type { BpxCouncilConfig } from "./config.js";
import { seatAttempt, type PlannedSeat, type SeatAttempt } from "./receipt.js";

export interface CouncilInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
	/**
	 * Backend specs assigned to personas in order, from `--backends`. Overrides
	 * config. Fewer specs than personas is fine — the rest use the default.
	 */
	backends?: string[];
	/** Verdict backend override; otherwise uses config, then the shared Solo backend. */
	synthesizer?: string;
	/** Run-wide controls for explicitly selected seat backends. */
	seatOptions?: SeatOptions;
	onAttempt?: (attempt: SeatAttempt) => void;
	onPlan?: (seats: PlannedSeat[]) => void;
}

export interface CouncilMember {
	persona: string;
	stance: string;
	/** Which backend answered, e.g. "codex" or "claude-sonnet-4". */
	model: string;
	ok: boolean;
	text: string;
}

export type CouncilResult =
	| { ok: true; text: string; members: CouncilMember[] }
	/** A failed synthesis keeps completed member verdicts as partial output. */
	| { ok: false; error: string; partial?: string; members?: CouncilMember[] };

/** Progress to stderr — see the same note in debate.ts. */
function note(line: string): void {
	process.stderr.write(`${line}\n`);
}

const ADVISOR_BASE_PROMPT =
	"You are an advisor model consulted by a coding agent. Be direct, cite specifics, " +
	"give a concrete recommendation — a PLAN, a CORRECTION, or a STOP signal.";

export async function runCouncil(input: CouncilInput): Promise<CouncilResult> {
	const { question, context, config } = input;
	const backend = (config.solo.backend ?? undefined) as BackendConfig | undefined;
	if (!backend) {
		return { ok: false, error: "No backend configured." };
	}

	const definitions = new Map(DEFAULT_PERSONAS.map((persona) => [persona.name, persona]));
	for (const [name, definition] of Object.entries(config.personas ?? {})) {
		definitions.set(name, { name, ...definition });
	}
	const names = config.council?.members ?? DEFAULT_PERSONAS.map((persona) => persona.name);
	if (input.backends && input.backends.length > names.length) {
		throw new Error(`--backends has ${input.backends.length} specs for ${names.length} council members`);
	}
	const personas = names.map((name) => {
		const persona = definitions.get(name);
		if (!persona) throw new Error(`Unknown council persona: ${name}`);
		return persona;
	});
	const userMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	// Resolve a backend per persona. Precedence: --backends (positional) >
	// config.council.backends (by persona name) > the shared default.
	//
	// This is what makes "multi-model" true rather than aspirational: without
	// it, every persona was the same model wearing a different stance.
	const assigned = personas.map((persona, i) => {
		const spec = input.backends?.[i] ?? config.council?.backends?.[persona.name];
		const resolved = resolveSeatBackend(spec, backend, input.seatOptions);
		return { persona, backend: resolved, label: backendLabel(resolved) };
	});
	const synthBackend = resolveSeatBackend(input.synthesizer ?? config.council?.synthesizer, backend, input.seatOptions);
	// A later seat must not invalidate an image request after parallel calls start.
	const routes = [...assigned.map((a) => a.backend), synthBackend];
	for (const route of routes) {
		const error = advisorTransportError(route);
		if (error) throw new Error(error);
	}
	for (const route of new Map(routes.map((item) => [backendLabel(item), item])).values()) {
		const warning = textOnlyImageWarning(route);
		if (warning) note(warning);
	}
	input.onPlan?.([...assigned.map(({ persona }) => ({ seat: persona.name, round: null })),
		{ seat: "synthesizer", round: null }]);

	const distinct = new Set(assigned.map((a) => a.label));
	note(
		distinct.size > 1
			? `── council: ${assigned.map((a) => `${a.persona.name}→${a.label}`).join(", ")}`
			: `── council: ${personas.length} personas on ${[...distinct][0]}`,
	);

	// Fan out — each persona gets its own call in parallel, on its own backend.
	const memberResults = await Promise.allSettled(
		assigned.map(async (a) => {
			let result: BackendResult;
			try { result = await callCouncilMember(a.persona, userMessage, a.backend); }
			catch { result = { ok: false, text: "", error: "Advisor call failed unexpectedly" }; }
			note(`── ${a.persona.name} (${a.label}) ${result.ok ? "answered" : "failed"}`);
			return result;
		}),
	);

	const members: CouncilMember[] = assigned.map((a, i) => {
		const r = memberResults[i];
		const base = { persona: a.persona.name, stance: a.persona.stance, model: a.label };
		const result: BackendResult = r.status === "fulfilled" ? r.value : { ok: false, text: "", error: "Advisor call failed unexpectedly" };
		input.onAttempt?.(seatAttempt(a.persona.name, null, a.backend, result));
		return { ...base, ok: result.ok, text: result.text };
	});

	for (const m of members) {
		if (!m.ok) note(`⚠ ${m.persona} (${m.model}) did not answer — continuing without it.`);
	}

	const successful = members.filter((m) => m.ok);
	if (successful.length === 0) {
		return { ok: false, error: "All council members failed." };
	}

	// Header carries the model, so a reader can see which one argued what —
	// the entire reason to run members on different backends.
	const header = (m: CouncilMember) => `### ${m.persona} [${m.stance}] · ${m.model}`;

	const transcript = members
		.filter((m) => m.ok)
		.map((m) => `${header(m)}\n${m.text}`)
		.join("\n\n");

	const synthesisInput = members
		.map((m) => `${header(m)}\n${m.ok ? m.text : "(failed: no response)"}`)
		.join("\n\n");

	const synthMessage = `${synthesisInput}\n\n=== Original Question ===\n${question}`;

	// Synthesize — one more call that merges the verdicts.
	note(`── synthesizing verdict · ${backendLabel(synthBackend)} …`);
	const synthResult = await callAdvisor(SYNTHESIZER_PROMPT, synthMessage, synthBackend);
	input.onAttempt?.(seatAttempt("synthesizer", null, synthBackend, synthResult));
	note("");

	if (!synthResult.ok) {
		// Preserve paid-for member answers, but don't claim a verdict was produced.
		return { ok: false, error: `Synthesis failed (${backendLabel(synthBackend)}): ${synthResult.error}`,
			partial: transcript, members };
	}

	// Return the members *and* the verdict. Collapsing to the synthesis hides
	// the disagreement, which is the thing worth paying several models for.
	return { ok: true, text: `${transcript}\n\n### Verdict · ${backendLabel(synthBackend)}\n${synthResult.text}`, members };
}

async function callCouncilMember(
	persona: Persona,
	userMessage: string,
	backend: BackendConfig,
): Promise<BackendResult> {
	return callAdvisor(persona.systemPrompt, userMessage, backend);
}
