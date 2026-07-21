/**
 * Council backend routing.
 *
 * Council mode shipped describing itself as "multi-model" while handing every
 * persona the same backend — one model wearing three hats. These pin the
 * routing that makes the claim true, and the reporting that makes it visible.
 *
 * `callAdvisor` is mocked so we can assert which backend each persona got.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const callAdvisor = vi.fn();
vi.mock("../src/backend.js", () => ({
	callAdvisor: (...args: unknown[]) => callAdvisor(...args),
}));

const { runCouncil } = await import("../src/council.js");

/** The backend each call was handed, in call order. */
function commandsUsed(): string[] {
	return callAdvisor.mock.calls.map((c) => (c[2] as { command?: string })?.command ?? "?");
}

const baseConfig = {
	solo: { backend: { type: "cli", command: "codex", timeoutMs: 1000 } },
} as never;

beforeEach(() => {
	callAdvisor.mockReset();
	callAdvisor.mockResolvedValue({ ok: true, text: "a verdict" });
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

describe("runCouncil backend routing", () => {
	it("puts every persona on the shared backend when nothing overrides it", async () => {
		await runCouncil({ question: "Q", config: baseConfig });

		// 3 personas + 1 synthesizer.
		expect(callAdvisor).toHaveBeenCalledTimes(4);
		expect(commandsUsed()).toEqual(["codex", "codex", "codex", "codex"]);
	});

	it("assigns --backends to personas in order", async () => {
		await runCouncil({
			question: "Q",
			config: baseConfig,
			backends: ["codex", "claude", "opencode"],
		});

		// architect, critic, simplifier — then the synthesizer on the default.
		expect(commandsUsed().slice(0, 3)).toEqual(["codex", "claude", "opencode"]);
	});

	it("falls back to the default for personas beyond the supplied list", async () => {
		await runCouncil({ question: "Q", config: baseConfig, backends: ["claude"] });

		const used = commandsUsed();
		expect(used[0]).toBe("claude");
		// critic and simplifier keep the shared default.
		expect(used[1]).toBe("codex");
		expect(used[2]).toBe("codex");
	});

	it("reads per-persona backends from config by name", async () => {
		const config = {
			solo: { backend: { type: "cli", command: "codex", timeoutMs: 1000 } },
			council: { backends: { critic: "claude" } },
		} as never;

		await runCouncil({ question: "Q", config });

		const used = commandsUsed();
		expect(used[0]).toBe("codex");
		expect(used[1]).toBe("claude"); // critic, by name
		expect(used[2]).toBe("codex");
	});

	it("lets --backends win over config", async () => {
		const config = {
			solo: { backend: { type: "cli", command: "codex", timeoutMs: 1000 } },
			council: { backends: { architect: "claude" } },
		} as never;

		await runCouncil({ question: "Q", config, backends: ["opencode"] });

		expect(commandsUsed()[0]).toBe("opencode");
	});

	it("labels each member with the model that answered", async () => {
		const result = await runCouncil({
			question: "Q",
			config: baseConfig,
			backends: ["codex", "claude", "opencode"],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.members.map((m) => m.model)).toEqual(["codex", "claude", "opencode"]);
	});

	it("shows the model in the output so disagreement is attributable", async () => {
		callAdvisor
			.mockResolvedValueOnce({ ok: true, text: "Ship it." })
			.mockResolvedValueOnce({ ok: true, text: "Absolutely not." })
			.mockResolvedValueOnce({ ok: true, text: "Do less." })
			.mockResolvedValueOnce({ ok: true, text: "Split the difference." });

		const result = await runCouncil({
			question: "Q",
			config: baseConfig,
			backends: ["codex", "claude", "opencode"],
		});

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		// Reading "who argued what" is the reason to pay for several models.
		expect(result.text).toContain("architect [for] · codex");
		expect(result.text).toContain("critic [against] · claude");
		expect(result.text).toContain("Absolutely not.");
		expect(result.text).toContain("### Verdict");
		expect(result.text).toContain("Split the difference.");
	});

	it("carries on when one member fails", async () => {
		callAdvisor
			.mockResolvedValueOnce({ ok: true, text: "Ship it." })
			.mockResolvedValueOnce({ ok: false, error: "timed out" })
			.mockResolvedValueOnce({ ok: true, text: "Do less." })
			.mockResolvedValueOnce({ ok: true, text: "Verdict." });

		const result = await runCouncil({ question: "Q", config: baseConfig });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.members.filter((m) => m.ok)).toHaveLength(2);
		// The dead member is left out of the transcript, not rendered blank.
		expect(result.text).not.toContain("critic [against]");
		expect(result.text).toContain("Ship it.");
	});

	it("keeps member verdicts when synthesis fails", async () => {
		callAdvisor
			.mockResolvedValueOnce({ ok: true, text: "Ship it." })
			.mockResolvedValueOnce({ ok: true, text: "Absolutely not." })
			.mockResolvedValueOnce({ ok: true, text: "Do less." })
			.mockResolvedValueOnce({ ok: false, error: "synth died" });

		const result = await runCouncil({ question: "Q", config: baseConfig });

		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toContain("Ship it.");
		expect(result.text).toContain("Absolutely not.");
		expect(result.text).not.toContain("### Verdict");
	});

	it("fails only when every member fails", async () => {
		callAdvisor.mockResolvedValue({ ok: false, error: "down" });

		const result = await runCouncil({ question: "Q", config: baseConfig });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("All council members failed");
	});
});
