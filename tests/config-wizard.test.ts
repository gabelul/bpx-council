/**
 * config-wizard tests.
 *
 * The interactive flow is thin readline glue; what's worth pinning is the pure
 * build/merge — it decides what lands in ~/.bpx-council.json, and getting the
 * merge wrong would drop a user's hand-set keys or their existing council.
 */

import { describe, expect, it } from "vitest";
import { backendConfigFromSpec, buildConfig, gatherAnswers, prettyPath, type Pickers } from "../src/config-wizard.js";
import type { AvailableBackend } from "../src/detect.js";
import type { BpxCouncilConfig } from "../src/config.js";

/** Pickers stand-in: each method hands back scripted answers in order. */
function scriptedPickers(opts: {
	selects?: (string | null)[];
	filters?: (string | null)[];
	asks?: string[];
	confirms?: boolean[];
	models?: string[];
}): Pickers {
	let s = 0;
	let f = 0;
	let a = 0;
	let c = 0;
	return {
		select: async () => opts.selects?.[s++] ?? null,
		filterSelect: async () => opts.filters?.[f++] ?? null,
		// mirror production `ask`: a blank answer takes the default
		ask: async (_q, def) => {
			const answer = opts.asks?.[a++];
			return answer && answer.trim() ? answer.trim() : def;
		},
		confirm: async () => opts.confirms?.[c++] ?? false,
		listModels: async () => opts.models ?? [],
	};
}

const CODEX: AvailableBackend[] = [{ name: "codex", kind: "cli", detail: "CLI on PATH" }];
const OPENCODE: AvailableBackend[] = [{ name: "opencode", kind: "cli", detail: "CLI on PATH" }];

describe("prettyPath", () => {
	it("shows a path inside the working directory as ./relative", () => {
		expect(prettyPath(`${process.cwd()}/.bpx-council.json`)).toBe("./.bpx-council.json");
	});

	it("shortens home to ~", () => {
		const home = process.env.HOME;
		// Only meaningful when HOME is set and isn't itself the cwd prefix.
		if (home && !process.cwd().startsWith(home)) {
			expect(prettyPath(`${home}/.bpx-council.json`)).toBe("~/.bpx-council.json");
		}
	});

	it("leaves an unrelated absolute path alone", () => {
		expect(prettyPath("/etc/bpx-council.json")).toBe("/etc/bpx-council.json");
	});
});

describe("backendConfigFromSpec", () => {
	it("builds a CLI backend, with and without a pinned model", () => {
		expect(backendConfigFromSpec("codex")).toEqual({ type: "cli", command: "codex" });
		expect(backendConfigFromSpec("codex:gpt-5-codex")).toEqual({ type: "cli", command: "codex", model: "gpt-5-codex" });
	});

	it("builds an HTTP backend from a provider name", () => {
		expect(backendConfigFromSpec("anthropic:claude-opus-4-8")).toEqual({
			type: "http",
			provider: "anthropic",
			model: "claude-opus-4-8",
		});
	});

	it("treats an unknown name as a custom CLI command", () => {
		expect(backendConfigFromSpec("my-advisor")).toEqual({ type: "cli", command: "my-advisor" });
	});
});

describe("buildConfig", () => {
	it("writes mode and advisor backend from the answers", () => {
		const cfg = buildConfig({ mode: "council", soloSpec: "codex:gpt-5-codex" });
		expect(cfg.defaultMode).toBe("council");
		expect(cfg.solo.backend).toEqual({ type: "cli", command: "codex", model: "gpt-5-codex" });
	});

	it("writes a council when personas were assigned", () => {
		const cfg = buildConfig({
			mode: "solo",
			soloSpec: "codex",
			council: { architect: "codex:gpt-5-codex", critic: "anthropic:claude-opus-4-8" },
		});
		expect(cfg.council?.backends).toEqual({
			architect: "codex:gpt-5-codex",
			critic: "anthropic:claude-opus-4-8",
		});
	});

	it("preserves unmanaged keys and an existing council when none was set", () => {
		const existing: BpxCouncilConfig = {
			defaultMode: "solo",
			solo: { model: "auto", thinkingLevel: "high" },
			council: { backends: { architect: "claude" } },
			contextWindow: 300_000,
		};
		const cfg = buildConfig({ mode: "gut-check", soloSpec: "codex" }, existing);
		// unmanaged keys survive
		expect(cfg.contextWindow).toBe(300_000);
		expect(cfg.solo.thinkingLevel).toBe("high");
		// council kept because the wizard didn't set a new one
		expect(cfg.council?.backends).toEqual({ architect: "claude" });
		// managed keys updated
		expect(cfg.defaultMode).toBe("gut-check");
		expect(cfg.solo.backend).toEqual({ type: "cli", command: "codex" });
	});

	it("replaces an existing council when a new one is set", () => {
		const existing: BpxCouncilConfig = {
			defaultMode: "solo",
			solo: { model: "auto" },
			council: { backends: { architect: "claude", critic: "claude", simplifier: "claude" } },
		};
		const cfg = buildConfig({ mode: "council", soloSpec: "codex", council: { architect: "codex" } }, existing);
		expect(cfg.council?.backends).toEqual({ architect: "codex" });
	});
});

describe("gatherAnswers (scripted pickers)", () => {
	it("takes defaults when selects cancel and no model is typed", async () => {
		// backend select → null (falls to default codex); listModels [] → ask → default (blank);
		// mode select → null → solo; council confirm → false
		const answers = await gatherAnswers(scriptedPickers({}), CODEX, undefined);
		expect(answers).toEqual({ mode: "solo", soloSpec: "codex", council: undefined });
	});

	it("pins a free-text model on a backend that can't list (codex), and picks a mode", async () => {
		const answers = await gatherAnswers(
			scriptedPickers({ selects: ["codex", "council"], asks: ["gpt-5-codex"], models: [] }),
			CODEX,
			undefined,
		);
		expect(answers.soloSpec).toBe("codex:gpt-5-codex");
		expect(answers.mode).toBe("council");
	});

	it("picks a model from the filterable list when the backend can enumerate (opencode)", async () => {
		const answers = await gatherAnswers(
			scriptedPickers({
				selects: ["opencode", "solo"],
				models: ["google/gemini-3-pro", "openai/gpt-5"],
				filters: ["openai/gpt-5"],
			}),
			OPENCODE,
			undefined,
		);
		expect(answers.soloSpec).toBe("opencode:openai/gpt-5");
	});

	it("assembles a council, each persona defaulting to the advisor spec", async () => {
		const answers = await gatherAnswers(
			scriptedPickers({
				selects: ["codex", "council"],
				asks: ["gpt-5-codex", "", "claude", ""], // model, then architect/critic/simplifier
				confirms: [true],
				models: [],
			}),
			CODEX,
			undefined,
		);
		expect(answers.council).toEqual({
			architect: "codex:gpt-5-codex",
			critic: "claude",
			simplifier: "codex:gpt-5-codex",
		});
	});

	it("falls back to solo when the mode select is cancelled", async () => {
		const answers = await gatherAnswers(scriptedPickers({ selects: ["codex", null], models: [] }), CODEX, undefined);
		expect(answers.mode).toBe("solo");
	});
});
