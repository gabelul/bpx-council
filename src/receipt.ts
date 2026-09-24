import { randomUUID } from "node:crypto";
import type { Mode } from "./args.js";
import type { BackendConfig, BackendResult, ProviderUsage } from "./backend.js";
import { backendLabel } from "./detect.js";
import { httpModel } from "./http-backend.js";

export interface PlannedSeat {
	seat: string;
	round: number | null;
}

export interface SeatAttempt extends PlannedSeat {
	route: { type: BackendConfig["type"]; command: string | null; provider: string | null;
		label: string; model: string | null; effort: string | null };
	status: "complete" | "failed";
	error: string | null;
	usage: ProviderUsage | null;
}

export interface Receipt {
	schemaVersion: 1;
	invocationId: string;
	mode: Mode | null;
	status: "complete" | "partial" | "failed";
	advice: string | null;
	error: string | null;
	attempts: SeatAttempt[];
	/** Planned calls and skipped calls are metadata, never usage attempts. */
	planned: PlannedSeat[];
	notRun: PlannedSeat[];
	usage: { attempted: number; reported: number; unknown: number; inputTokens: number | null; outputTokens: number | null;
		cacheCreationInputTokens: number | null; cacheReadInputTokens: number | null;
		cacheCreationReported: number; cacheReadReported: number };
}

/** Create one invocation receipt before parsing or doing I/O. */
export function newReceipt(): Receipt {
	return { schemaVersion: 1, invocationId: randomUUID(), mode: null, status: "failed", advice: null, error: null,
		attempts: [], planned: [], notRun: [], usage: { attempted: 0, reported: 0, unknown: 0, inputTokens: null, outputTokens: null,
			cacheCreationInputTokens: null, cacheReadInputTokens: null, cacheCreationReported: 0, cacheReadReported: 0 } };
}

/** Describe selected route without inferring unpinned CLI model names. */
export function seatAttempt(seat: string, round: number | null, backend: BackendConfig, result: BackendResult): SeatAttempt {
	return { seat, round, route: { type: backend.type,
		command: "command" in backend ? backend.command : null,
		provider: backend.type === "http" ? backend.provider : null,
		label: backendLabel(backend), model: backend.type === "http" ? httpModel(backend) ?? null : backend.type === "cli" && backend.args?.length ? null : backend.model ?? null,
		effort: backend.type === "cli" && backend.args?.length ? null : "effort" in backend ? backend.effort ?? null : null }, status: result.ok ? "complete" : "failed",
		error: result.ok ? null : result.error ?? "unknown error", usage: result.usage ?? null };
}

/** Append attempt and sum only provider-reported tokens. Never estimate CLI usage. */
export function addAttempt(receipt: Receipt, attempt: SeatAttempt): void {
	receipt.attempts.push(attempt);
	receipt.usage.attempted++;
	if (attempt.usage) {
		receipt.usage.reported++;
		receipt.usage.inputTokens = (receipt.usage.inputTokens ?? 0) + attempt.usage.inputTokens;
		receipt.usage.outputTokens = (receipt.usage.outputTokens ?? 0) + attempt.usage.outputTokens;
		if (attempt.usage.cacheCreationInputTokens !== undefined) {
			receipt.usage.cacheCreationReported++;
			receipt.usage.cacheCreationInputTokens = (receipt.usage.cacheCreationInputTokens ?? 0) + attempt.usage.cacheCreationInputTokens;
		}
		if (attempt.usage.cacheReadInputTokens !== undefined) {
			receipt.usage.cacheReadReported++;
			receipt.usage.cacheReadInputTokens = (receipt.usage.cacheReadInputTokens ?? 0) + attempt.usage.cacheReadInputTokens;
		}
	} else receipt.usage.unknown++;
}

/** Decide completion from returned advice and actual seat outcomes, not exit code alone. */
export function settleReceipt(receipt: Receipt, result: { ok: boolean; text?: string; error?: string; partial?: string }): Receipt {
	receipt.advice = result.ok ? result.text ?? null : result.partial ?? null;
	receipt.error = result.ok ? null : result.error ?? "unknown error";
	receipt.notRun = receipt.planned.filter((plan) => !receipt.attempts.some((attempt) =>
		attempt.seat === plan.seat && attempt.round === plan.round));
	receipt.status = result.ok
		? receipt.attempts.some((attempt) => attempt.status === "failed") ? "partial" : "complete"
		: receipt.advice ? "partial" : "failed";
	return receipt;
}
