import { describe, expect, it } from "vitest";
import type { BpxCouncilConfig } from "../src/config.js";
import { acceptPersona, personaError, personaLibrary, resetBuiltinPersona, seatedPersonas, togglePersonaSeat } from "../src/config-personas.js";
import { DEFAULT_PERSONAS, type Persona } from "../src/personas.js";

const empty = {} as BpxCouncilConfig;
const candidate: Persona = { name: "back", stance: "against", systemPrompt: "Check evidence.\nDo not force verdict." };

describe("pure persona mutations", () => {
	it("lists defaults without storing them; custom overrides keep stable order", () => {
		expect(personaLibrary(empty)).toEqual(DEFAULT_PERSONAS);
		expect(empty).toEqual({});
		const draft = { personas: { critic: { stance: "neutral", systemPrompt: "Custom critic" }, tokens: { stance: "for", systemPrompt: "Token budget" } } } as BpxCouncilConfig;
		expect(personaLibrary(draft).map(p => p.name)).toEqual(["architect", "critic", "simplifier", "tokens"]);
		expect(personaLibrary(draft)[1]).toEqual({ name: "critic", stance: "neutral", systemPrompt: "Custom critic" });
	});
	it.each(["back", "tokens", "review", "constructor"])("accepts legal custom name %s independently of action IDs", name => {
		const next = acceptPersona(empty, { ...candidate, name }, false);
		expect(next.personas?.[name]).toEqual({ stance: candidate.stance, systemPrompt: candidate.systemPrompt });
		expect(seatedPersonas(next)).toContain(name);
		expect(empty).toEqual({});
	});
	it.each(["synthesizer", "Verdict", "with space", "9bad", "a".repeat(33)])("rejects unsafe/reserved %s", name => {
		expect(() => acceptPersona(empty, { ...candidate, name }, false)).toThrow();
		expect(empty).toEqual({});
	});
	it("rejects collisions; explicit bundled edit creates override but cannot rename", () => {
		expect(() => acceptPersona(empty, { ...candidate, name: "critic" }, false)).toThrow("already exists");
		const overridden = acceptPersona(empty, { ...candidate, name: "critic" }, false, "critic");
		expect(overridden.council).toBeUndefined();
		expect(overridden.personas?.critic.systemPrompt).toBe(candidate.systemPrompt);
		expect(() => acceptPersona(overridden, { ...candidate, name: "critic" }, false)).toThrow("already exists");
		expect(() => acceptPersona(overridden, candidate, false, "critic")).toThrow("cannot change");
	});
	it("seat/unseat retains routes, definitions and unrelated legacy fields", () => {
		const draft = { solo: { model: "legacy", thinkingLevel: "high" }, council: { members: ["architect", "back"], backends: { back: "pi:vendor/model@rev@" }, synthesizer: null }, personas: { back: { stance: candidate.stance, systemPrompt: candidate.systemPrompt } }, contextWindow: 23 } as BpxCouncilConfig;
		const bytes = JSON.stringify(draft);
		const unseated = togglePersonaSeat(draft, "back", false);
		expect(unseated).toEqual({ ...draft, council: { ...draft.council, members: ["architect"] } });
		expect(togglePersonaSeat(unseated, "back", false)).toEqual(draft);
		expect(JSON.stringify(draft)).toBe(bytes);
	});
	it("guards one-to-eight roster, unknown definitions and full-library acceptance", () => {
		const one = { council: { members: ["critic"] } } as BpxCouncilConfig;
		expect(() => togglePersonaSeat(one, "critic", false)).toThrow("at least one");
		expect(() => togglePersonaSeat(one, "unknown", false)).toThrow("Unknown");
		const full = { council: { members: Array.from({ length: 8 }, (_, i) => `seat-${i}`) } } as BpxCouncilConfig;
		const next = acceptPersona(full, candidate, false);
		expect(next.council).toEqual(full.council); expect(next.personas?.back).toBeDefined();
		expect(() => togglePersonaSeat(next, "back", false)).toThrow("eight");
	});
	it("allows library-only creation, caps 16 definitions incl builtin overrides", () => {
		const libraryOnly = acceptPersona(empty, candidate, false, undefined, false);
		expect(libraryOnly.council).toBeUndefined();
		const full = { personas: Object.fromEntries(Array.from({ length: 16 }, (_, i) => [`custom-${i}`, { stance: "neutral", systemPrompt: "Prompt" }])) } as BpxCouncilConfig;
		expect(() => acceptPersona(full, candidate, false)).toThrow("16");
		expect(() => acceptPersona(full, { ...candidate, name: "critic" }, false, "critic")).toThrow("16");
		expect(acceptPersona(full, { ...candidate, name: "custom-1" }, false, "custom-1").personas?.["custom-1"].stance).toBe("against");
	});
	it("project cannot create/edit/reset prompts or seat custom definitions", () => {
		for (const editing of [undefined, "critic"]) expect(() => acceptPersona(empty, candidate, true, editing)).toThrow("Project");
		expect(() => resetBuiltinPersona(empty, "critic", true)).toThrow("Project");
		expect(togglePersonaSeat(empty, "critic", true).council?.members).toEqual(["architect", "simplifier"]);
		const trusted = acceptPersona(empty, candidate, false);
		expect(() => togglePersonaSeat(trusted, "back", true)).toThrow("bundled");
	});
	it("reset removes only builtin override; never silently resets custom definition", () => {
		const draft = { council: { members: ["critic"], backends: { critic: "claude:model" } }, personas: { critic: { stance: "for", systemPrompt: "Override" }, back: { stance: candidate.stance, systemPrompt: candidate.systemPrompt } } } as BpxCouncilConfig;
		const next = resetBuiltinPersona(draft, "critic", false);
		expect(next.council).toEqual(draft.council); expect(next.personas).toEqual({ back: draft.personas!.back });
		expect(personaLibrary(next).find(p => p.name === "critic")).toEqual(DEFAULT_PERSONAS[1]);
		expect(draft.personas?.critic).toBeDefined();
		expect(() => resetBuiltinPersona(draft, "back", false)).toThrow("bundled");
	});
	it("validates prompt size and stance without trimming accepted multiline text", () => {
		for (const prompt of ["", " \n ", "x".repeat(8001)]) expect(personaError(empty, { ...candidate, systemPrompt: prompt }, false)).toContain("Prompt");
		expect(personaError(empty, { ...candidate, stance: "bad" as Persona["stance"] }, false)).toContain("Stance");
		const prompt = "  Leading\n\tIndented\n";
		expect(acceptPersona(empty, { ...candidate, systemPrompt: prompt }, false).personas?.back.systemPrompt).toBe(prompt);
	});
});
