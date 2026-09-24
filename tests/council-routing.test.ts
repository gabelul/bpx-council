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
vi.mock("../src/backend.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../src/backend.js")>()),
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

	it("routes synthesis independently and labels its model", async () => {
		const config = {
			solo: { backend: { type: "cli", command: "codex", model: "shared" } },
			council: { synthesizer: "claude:opus@high" },
		} as never;
		const result = await runCouncil({ question: "Q", config });
		expect(commandsUsed()).toEqual(["codex", "codex", "codex", "claude"]);
		expect(callAdvisor.mock.calls[3]?.[2]).toMatchObject({ command: "claude", model: "opus", effort: "high" });
		expect(result.ok && result.text).toContain("### Verdict · claude:opus@high");
	});

	it("lets a CLI synthesis spec override config, with run-wide controls", async () => {
		const config = {
			...baseConfig, council: { synthesizer: "claude:opus" },
		} as never;
		await runCouncil({ question: "Q", config, synthesizer: "codex:judge", seatOptions: { timeoutMs: 4000, isolate: true } });
		expect(callAdvisor.mock.calls[3]?.[2]).toMatchObject({
			command: "codex", model: "judge", timeoutMs: 4000, isolate: true,
		});
	});

	it("attaches images to explicit image-capable member and synthesis routes", async () => {
		const original = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "test-only";
		try {
			await runCouncil({ question: "Q", config: baseConfig,
				backends: ["codex:architect", "anthropic:critic", "codex:simplifier"],
				synthesizer: "anthropic:judge", seatOptions: {
					images: ["/tmp/layout.png"],
					imageData: [{ path: "/tmp/layout.png", mime: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==" }],
				} });
			expect(callAdvisor.mock.calls[0]?.[2]).toMatchObject({ images: ["/tmp/layout.png"] });
			expect(callAdvisor.mock.calls[1]?.[2]).toMatchObject({ images: ["/tmp/layout.png"] });
			expect(callAdvisor.mock.calls[2]?.[2]).toMatchObject({ images: ["/tmp/layout.png"] });
			expect(callAdvisor.mock.calls[3]?.[2]).toMatchObject({ images: ["/tmp/layout.png"] });
		} finally {
			if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = original;
		}
	});

	it("does not require image support from an unused shared backend", async () => {
		const config = { solo: { backend: { type: "cli", command: "opencode" } } } as never;
		await runCouncil({ question: "Q", config,
			backends: ["codex", "codex", "codex"], synthesizer: "codex",
			seatOptions: { images: ["/tmp/layout.png"] } });
		expect(callAdvisor.mock.calls.map((call) => (call[2] as { command?: string }).command))
			.toEqual(["codex", "codex", "codex", "codex"]);
	});

	it("rejects an image-blind member before calling any advisor", async () => {
		await expect(runCouncil({ question: "Q", config: baseConfig,
			backends: ["codex", "opencode", "codex"], seatOptions: { images: ["/tmp/layout.png"] } }))
			.rejects.toThrow("can't take images");
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it.each([
		{ backends: ["codex", "codex"], synthesizer: "codex", seat: "member" },
		{ backends: ["codex", "codex", "codex"], seat: "synthesizer" },
	])("rejects image/custom-argv in a late $seat before any call", async ({ backends, synthesizer }) => {
		const config = { solo: { backend: {
			type: "cli", command: "codex", args: ["exec", "--json", "-"],
		} } } as never;
		await expect(runCouncil({ question: "Q", config, backends, synthesizer,
			seatOptions: { images: ["/tmp/layout.png"] } }))
			.rejects.toThrow("custom CLI args cannot safely attach images");
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it("rejects missing frozen HTTP images before any member call", async () => {
		await expect(runCouncil({ question: "Q", config: baseConfig,
			backends: ["codex", "codex", "codex"], synthesizer: "anthropic",
			seatOptions: { images: ["/tmp/layout.png"] } }))
			.rejects.toThrow("Images must be validated and frozen");
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it.each(["openai", "google"])("rejects unsupported HTTP %s in late seat before calls", async (provider) => {
		await expect(runCouncil({ question: "Q", config: baseConfig, synthesizer: provider }))
			.rejects.toThrow(`HTTP backend for ${provider} not yet implemented`);
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it("rejects an unkeyed Anthropic synthesizer before asking any member", async () => {
		const original = process.env.ANTHROPIC_API_KEY;
		delete process.env.ANTHROPIC_API_KEY;
		try {
			await expect(runCouncil({ question: "Q", config: baseConfig, synthesizer: "anthropic" }))
				.rejects.toThrow("No API key found in $ANTHROPIC_API_KEY");
			expect(callAdvisor).not.toHaveBeenCalled();
		} finally {
			if (original === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = original;
		}
	});

	it("rejects mispaired HTTP payload in late seat before member calls", async () => {
		await expect(runCouncil({ question: "Q", config: baseConfig,
			backends: ["codex", "codex", "codex"], synthesizer: "anthropic",
			seatOptions: { images: ["/tmp/layout.png"], imageData: [{ path: "/tmp/other.png", mime: "image/png", data: "iVBORw0KGgo=" }] } }))
			.rejects.toThrow("Images must be validated and frozen");
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it("rejects an unusable synthesizer before asking any member", async () => {
		await expect(runCouncil({ question: "Q", config: baseConfig, synthesizer: "amp" }))
			.rejects.toThrow("can't be used as an advisor");
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it("rejects a malformed synthesis spec before asking any member", async () => {
		await expect(runCouncil({ question: "Q", config: baseConfig, synthesizer: ":broken" }))
			.rejects.toThrow("Invalid backend spec");
		expect(callAdvisor).not.toHaveBeenCalled();
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

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("Synthesis failed");
		expect(result.partial).toContain("Ship it.");
		expect(result.partial).toContain("Absolutely not.");
		expect(result.partial).not.toContain("### Verdict");
	});

	it("fails only when every member fails", async () => {
		callAdvisor.mockResolvedValue({ ok: false, error: "down" });

		const result = await runCouncil({ question: "Q", config: baseConfig });

		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("All council members failed");
	});
});
