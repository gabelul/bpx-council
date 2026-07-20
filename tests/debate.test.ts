/**
 * Debate mode tests, focused on what happens to work already done.
 *
 * A debate is five sequential model calls, so a timeout on the last one isn't
 * an edge case — it's a Tuesday. These pin the two behaviours that make that
 * survivable: the transcript comes back on success, and completed rounds come
 * back on failure. `callAdvisor` is mocked; real subprocess calls are proven
 * by the live smoke tests.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const callAdvisor = vi.fn();
vi.mock("../src/backend.js", () => ({
	callAdvisor: (...args: unknown[]) => callAdvisor(...args),
}));

const { runDebate } = await import("../src/debate.js");

/** Minimal config — debate only reads `solo.backend`. */
const config = {
	solo: { backend: { type: "cli", command: "codex", timeoutMs: 1000 } },
} as never;

const ok = (text: string) => ({ ok: true, text });
const fail = (error: string) => ({ ok: false, error });

beforeEach(() => {
	callAdvisor.mockReset();
	// Progress writes to stderr; keep the test output readable.
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("runDebate", () => {
	it("returns the whole debate, not just the verdict", async () => {
		// 1 round = advocate, critic, synthesizer.
		callAdvisor
			.mockResolvedValueOnce(ok("We should rewrite it."))
			.mockResolvedValueOnce(ok("Rewriting will take three months."))
			.mockResolvedValueOnce(ok("Patch now, plan the rewrite."));

		const result = await runDebate({ question: "Rewrite or patch?", config, rounds: 1 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// The reason to pay for debate over solo is seeing the argument itself.
		expect(result.text).toContain("We should rewrite it.");
		expect(result.text).toContain("Rewriting will take three months.");
		expect(result.text).toContain("### Verdict");
		expect(result.text).toContain("Patch now, plan the rewrite.");
	});

	it("does not echo the user's own question back in the output", async () => {
		callAdvisor
			.mockResolvedValueOnce(ok("Advocate says yes."))
			.mockResolvedValueOnce(ok("Critic says no."))
			.mockResolvedValueOnce(ok("Verdict text."));

		const result = await runDebate({ question: "UNIQUE_QUESTION_MARKER", config, rounds: 1 });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).not.toContain("UNIQUE_QUESTION_MARKER");
	});

	it("hands back completed rounds when a later call fails", async () => {
		// This is the live failure that prompted the fix: four good rounds, then
		// the critic times out, and everything was discarded.
		callAdvisor
			.mockResolvedValueOnce(ok("Round 1 advocate."))
			.mockResolvedValueOnce(ok("Round 1 critic."))
			.mockResolvedValueOnce(ok("Round 2 advocate."))
			.mockResolvedValueOnce(fail('"codex" timed out after 120000ms'));

		const result = await runDebate({ question: "Rewrite or patch?", config, rounds: 2 });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("timed out");
		expect(result.partial).toContain("Round 1 advocate.");
		expect(result.partial).toContain("Round 1 critic.");
		expect(result.partial).toContain("Round 2 advocate.");
		expect(result.partial).toContain("Incomplete");
	});

	it("salvages the rounds when only the synthesizer fails", async () => {
		callAdvisor
			.mockResolvedValueOnce(ok("Advocate opening."))
			.mockResolvedValueOnce(ok("Critic rebuttal."))
			.mockResolvedValueOnce(fail("synth exploded"));

		const result = await runDebate({ question: "Rewrite or patch?", config, rounds: 1 });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.partial).toContain("Advocate opening.");
		expect(result.partial).toContain("Critic rebuttal.");
	});

	it("stays ok:false so a calling agent sees the failure", async () => {
		// Partial output is still a failed run. Returning ok:true would make the
		// CLI exit 0 and tell an orchestrating agent everything went fine.
		callAdvisor
			.mockResolvedValueOnce(ok("Some work."))
			.mockResolvedValueOnce(fail("boom"));

		const result = await runDebate({ question: "Q", config, rounds: 1 });
		expect(result.ok).toBe(false);
	});

	it("omits partial when the very first call fails", async () => {
		callAdvisor.mockResolvedValueOnce(fail("backend unreachable"));

		const result = await runDebate({ question: "Q", config, rounds: 1 });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.partial).toBeUndefined();
	});

	it("caps rounds at 4 so a typo can't launch a 20-call run", async () => {
		callAdvisor.mockResolvedValue(ok("turn"));

		await runDebate({ question: "Q", config, rounds: 99 });

		// 4 rounds x (advocate + critic) + 1 synthesizer.
		expect(callAdvisor).toHaveBeenCalledTimes(9);
	});

	it("fails cleanly when no backend is configured", async () => {
		const result = await runDebate({ question: "Q", config: { solo: {} } as never });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("No backend");
		expect(callAdvisor).not.toHaveBeenCalled();
	});
});
