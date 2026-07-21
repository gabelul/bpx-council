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
import { backendLabel, detectBackend, parseBackendArg } from "./detect.js";
import type { BpxCouncilConfig } from "./config.js";

export interface CouncilInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
	/**
	 * Backend specs assigned to personas in order, from `--backends`. Overrides
	 * config. Fewer specs than personas is fine — the rest use the default.
	 */
	backends?: string[];
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
	| { ok: false; error: string };

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

	const personas = DEFAULT_PERSONAS;
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
		if (!spec) return { persona, backend, label: backendLabel(backend as never) };
		const resolved = detectBackend(parseBackendArg(spec));
		return { persona, backend: resolved as unknown as BackendConfig, label: backendLabel(resolved) };
	});

	const distinct = new Set(assigned.map((a) => a.label));
	note(
		distinct.size > 1
			? `── council: ${assigned.map((a) => `${a.persona.name}→${a.label}`).join(", ")}`
			: `── council: ${personas.length} personas on ${[...distinct][0]}`,
	);

	// Fan out — each persona gets its own call in parallel, on its own backend.
	const memberResults = await Promise.allSettled(
		assigned.map((a) => callCouncilMember(a.persona, userMessage, a.backend)),
	);

	const members: CouncilMember[] = assigned.map((a, i) => {
		const r = memberResults[i];
		const base = { persona: a.persona.name, stance: a.persona.stance, model: a.label };
		if (r.status === "fulfilled") return { ...base, ok: r.value.ok, text: r.value.text };
		return { ...base, ok: false, text: "" };
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
	note("── synthesizing verdict …");
	const synthResult = await callAdvisor(SYNTHESIZER_PROMPT, synthMessage, backend);
	note("");

	if (!synthResult.ok) {
		// Synthesis failed — hand back the raw member verdicts so minutes of
		// parallel work don't evaporate over the last call.
		return { ok: true, text: transcript || "No usable output.", members };
	}

	// Return the members *and* the verdict. Collapsing to the synthesis hides
	// the disagreement, which is the thing worth paying several models for.
	return { ok: true, text: `${transcript}\n\n### Verdict\n${synthResult.text}`, members };
}

async function callCouncilMember(
	persona: Persona,
	userMessage: string,
	backend: BackendConfig,
): Promise<BackendResult> {
	return callAdvisor(persona.systemPrompt, userMessage, backend);
}
