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
import { mergeConfigs, type BpxCouncilConfig } from "../src/config.js";

/** Pickers stand-in: each method hands back scripted answers in order. */
function scriptedPickers(opts: {
	selects?: (string | null)[];
	filters?: (string | null)[];
	asks?: string[];
	confirms?: boolean[];
	models?: string[];
	efforts?: { levels: string[]; def?: string } | null;
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
		// Default: the backend has no effort control, so the step is skipped.
		listEfforts: async () => opts.efforts ?? null,
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

	it("carries a pinned reasoning effort onto the backend", () => {
		expect(backendConfigFromSpec("codex:gpt-5.6-sol@max")).toEqual({
			type: "cli",
			command: "codex",
			model: "gpt-5.6-sol",
			effort: "max",
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

	it("preserves independent seats when only the advisor or Council members change", () => {
		const existing: BpxCouncilConfig = {
			defaultMode: "debate", solo: { backend: { type: "cli", command: "codex" } },
			council: { backends: { critic: "claude" }, synthesizer: "codex:judge" },
			debate: { advocate: "claude:adv", critic: "codex:critic" },
		};
		const updated = buildConfig({ mode: "solo", soloSpec: "opencode:new", council: { architect: "codex:architect" } }, existing);
		expect(updated.council).toEqual({ backends: { architect: "codex:architect", critic: "claude" }, synthesizer: "codex:judge" });
		expect(updated.debate).toEqual({ advocate: "claude:adv", critic: "codex:critic" });
	});

	it("can reset saved seat routes to inherited Solo", () => {
		const existing: BpxCouncilConfig = {
			defaultMode: "debate", solo: {},
			council: { synthesizer: "claude:judge" }, debate: { advocate: "claude:adv", critic: "codex:critic" },
		};
		const cfg = buildConfig({ mode: "debate", soloSpec: "codex", councilSynthesizer: null,
			debate: { advocate: null, synthesizer: "codex:new-judge" } }, existing);
		expect(cfg.council?.synthesizer).toBeNull();
		expect(cfg.debate).toEqual({ advocate: null, critic: "codex:critic", synthesizer: "codex:new-judge" });
	});

	it("merges changed Council members without dropping saved assignments", () => {
		const existing: BpxCouncilConfig = {
			defaultMode: "solo",
			solo: { model: "auto" },
			council: { backends: { architect: "claude", critic: "claude", simplifier: "claude" } },
		};
		const cfg = buildConfig({ mode: "council", soloSpec: "codex", council: { architect: "codex" } }, existing);
		expect(cfg.council?.backends).toEqual({ architect: "codex", critic: "claude", simplifier: "claude" });
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

	it("records only Council members changed during setup", async () => {
		const answers = await gatherAnswers(
			scriptedPickers({
				selects: ["codex", "council"],
				asks: ["gpt-5-codex", "", "claude", "", ""], // model, then three members, synth
				confirms: [true],
				models: [],
			}),
			CODEX,
			undefined,
		);
		expect(answers.council).toEqual({ critic: "claude" });
	});

	it("offers a separate Council synthesizer spec", async () => {
		const answers = await gatherAnswers(scriptedPickers({
			selects: ["codex", "council"], confirms: [true],
			asks: ["", "", "", "", "claude:judge@high"],
		}), CODEX, undefined);
		expect(answers.councilSynthesizer).toBe("claude:judge@high");
	});

	it("keeps an inherited Council synthesizer unless explicitly reset", async () => {
		const answers = await gatherAnswers(scriptedPickers({
			selects: ["codex", "council"], confirms: [true], asks: ["", "", "", "", ""],
		}), CODEX, undefined);
		expect(answers.councilSynthesizer).toBeUndefined();
		const reset = await gatherAnswers(scriptedPickers({
			selects: ["codex", "council"], confirms: [true], asks: ["", "", "", "", "inherit"],
		}), CODEX, undefined);
		expect(reset.councilSynthesizer).toBeNull();
	});

	it("does not override global Council members when project wizard edits only synthesis", async () => {
		const global: BpxCouncilConfig = {
			defaultMode: "solo", solo: {},
			council: { backends: { architect: "claude:arch", critic: "codex:critic" } },
		};
		const answers = await gatherAnswers(scriptedPickers({
			selects: ["codex", "council"], confirms: [true],
			asks: ["", "", "", "", "opencode:judge"],
		}), CODEX, undefined);
		const project = buildConfig(answers);
		const merged = mergeConfigs(global, project);
		expect(merged.council).toEqual({
			backends: { architect: "claude:arch", critic: "codex:critic" }, synthesizer: "opencode:judge",
		});
	});

	it("offers each Debate role and lets an existing role return to Solo", async () => {
		const existing: BpxCouncilConfig = {
			defaultMode: "debate", solo: {}, debate: { advocate: "claude:old", critic: "codex:critic" },
		};
		const answers = await gatherAnswers(scriptedPickers({
			selects: ["codex", "debate"], confirms: [false, true],
			asks: ["", "inherit", "claude:new", "codex:judge"],
		}), CODEX, existing);
		expect(answers.debate).toEqual({ advocate: null, critic: "claude:new", synthesizer: "codex:judge" });
	});

	it("appends the chosen reasoning effort to the spec", async () => {
		const answers = await gatherAnswers(
			// selects: backend, effort, mode
			scriptedPickers({
				selects: ["codex", "xhigh", "solo"],
				asks: ["gpt-5.6-sol"],
				models: [],
				efforts: { levels: ["low", "medium", "high", "xhigh"], def: "medium" },
			}),
			CODEX,
			undefined,
		);
		expect(answers.soloSpec).toBe("codex:gpt-5.6-sol@xhigh");
	});

	it("skips the effort step for a backend with no such control", async () => {
		const answers = await gatherAnswers(
			scriptedPickers({ selects: ["codex", "council"], asks: ["gpt-5-codex"], models: [], efforts: null }),
			CODEX,
			undefined,
		);
		// No @level, and the second select fell through to the mode question.
		expect(answers.soloSpec).toBe("codex:gpt-5-codex");
		expect(answers.mode).toBe("council");
	});

	it("falls back to solo when the mode select is cancelled", async () => {
		const answers = await gatherAnswers(scriptedPickers({ selects: ["codex", null], models: [] }), CODEX, undefined);
		expect(answers.mode).toBe("solo");
	});
});
