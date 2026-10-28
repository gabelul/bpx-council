/**
 * solo — one advisor model, one response. The default council mode.
 */

import { admitAdvisorRoutes, callAdvisor, type BackendConfig } from "./backend.js";
import type { BpxCouncilConfig } from "./config.js";
import { seatAttempt, type PlannedSeat, type SeatAttempt } from "./receipt.js";

export interface SoloInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
	onAttempt?: (attempt: SeatAttempt) => void;
	onPlan?: (seats: PlannedSeat[]) => void;
	/** Invocation cancellation; caller waits for transport cleanup. */
	signal?: AbortSignal;
	/** Resolved gut-check route, independent of the Solo default. */
	backend?: BackendConfig;
	seat?: string;
}

export type SoloResult = { ok: true; text: string } | { ok: false; error: string };

const ADVISOR_SYSTEM_PROMPT =
	"You are an advisor model consulted by a coding agent. The user message contains " +
	"a question (and optionally conversation context). Return a concrete, actionable " +
	"recommendation — a PLAN, a CORRECTION, or a STOP signal. Be direct, cite specifics.";

export async function runSolo(input: SoloInput): Promise<SoloResult> {
	const { question, context, config } = input;
	const backend = input.backend ?? (config.solo.backend as BackendConfig | undefined);

	if (!backend) {
		return { ok: false, error: "No backend configured for the solo advisor." };
	}

	input.onPlan?.([{ seat: input.seat ?? "advisor", round: null }]);
	if (input.signal?.aborted) return { ok: false, error: "Advisor call cancelled" };

	const authority = admitAdvisorRoutes([backend]).get(backend);
	const userMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	// PTY has no abort contract; invocation gate waits its bounded normal completion.
	const callSignal = backend.type === "tmux" ? undefined : input.signal;
	const result = authority ? await callAdvisor(ADVISOR_SYSTEM_PROMPT, userMessage, backend, callSignal, authority) : callSignal === undefined
		? await callAdvisor(ADVISOR_SYSTEM_PROMPT, userMessage, backend)
		: await callAdvisor(ADVISOR_SYSTEM_PROMPT, userMessage, backend, callSignal);
	input.onAttempt?.(seatAttempt(input.seat ?? "advisor", null, backend, result));
	if (input.signal?.aborted) return { ok: false, error: "Advisor call cancelled" };
	return result.ok
		? { ok: true, text: result.text }
		: { ok: false, error: result.error ?? "unknown error" };
}
