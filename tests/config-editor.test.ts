import { describe, expect, it, vi } from "vitest";
import { editConfig, type EditorPickers, type EditorOptions } from "../src/config-editor.js";
import type { BpxCouncilConfig } from "../src/config.js";
import type { AvailableBackend } from "../src/detect.js";

const available: AvailableBackend[] = [{ name: "codex", kind: "cli", detail: "on PATH, login unknown" }, { name: "anthropic", kind: "http", detail: "key present, account unknown" }];
const target: EditorOptions = { path: "/test/settings.json", scope: "global" };
const existing: BpxCouncilConfig = {
	defaultMode: "solo",
	solo: { backend: { type: "cli", command: "unavailable-advisor", args: ["--private"], timeoutMs: 8123, model: "retired-model", effort: "high" }, model: "legacy", thinkingLevel: "low" },
	council: { members: ["reviewer", "tokens", "back"], backends: { reviewer: "missing:old@high", tokens: "codex", back: "anthropic" }, synthesizer: "codex" },
	debate: { advocate: "codex", critic: "anthropic:old", synthesizer: "missing" },
	gutCheck: { backend: "codex:tiny", maxOutputTokens: 96 },
	personas: { reviewer: { stance: "against", systemPrompt: "Private prompt preserved." } },
	contextWindow: 123456,
};

/** Build strict scripted pickers and retain calls for preselection assertions. */
function script(selects: (string | null)[], opts: { asks?: (string | null)[]; models?: string[]; filters?: (string | null)[]; efforts?: { levels: string[]; def?: string } | null; failDiscovery?: boolean } = {}) {
	const queue = [...selects];
	const asks = [...(opts.asks ?? [])];
	const filters = [...(opts.filters ?? [])];
	const pickers: EditorPickers = {
		select: vi.fn(async (_header, options, _initial) => {
			if (!queue.length) throw new Error(`Script exhausted: ${_header}`);
			const selected = queue.shift()!;
			if (selected !== null) expect(options.map((o) => o.value)).toContain(selected);
			return selected;
		}),
		ask: vi.fn(async () => { if (!asks.length) throw new Error("Input script exhausted"); return asks.shift()!; }),
		filterSelect: vi.fn(async () => { if (!filters.length) throw new Error("Filter script exhausted"); return filters.shift()!; }),
		status: vi.fn(),
		listModels: vi.fn(async () => { if (opts.failDiscovery) throw new Error("offline"); return opts.models ?? []; }),
		listEfforts: vi.fn(async () => { if (opts.failDiscovery) throw new Error("offline"); return opts.efforts ?? null; }),
	};
	return pickers;
}

/** Read recorded picker calls without exposing them to production interfaces. */
function calls(pickers: EditorPickers) { return vi.mocked(pickers.select).mock.calls; }

describe("settings draft", () => {
	it("opening and saving clones exact config without normalization or discovery", async () => {
		const p = script(["review", "save"]);
		const saved = await editConfig(p, available, existing, target);
		expect(saved).toEqual(existing);
		expect(saved).not.toBe(existing);
		expect(saved?.solo.backend).not.toBe(existing.solo.backend);
		expect(p.listModels).not.toHaveBeenCalled();
		expect(p.listEfforts).not.toHaveBeenCalled();
		expect(calls(p)[0][0]).toContain("Unchanged");
	});

	it("mode-only edits preserve every route and unmanaged field; review Back retains draft", async () => {
		const p = script(["mode", "debate", "review", "back", "review", "save"]);
		const saved = await editConfig(p, available, existing, target);
		expect(saved).toEqual({ ...existing, defaultMode: "debate" });
		expect(calls(p).filter(([header]) => header.startsWith("Settings")).every(([header], i) => i === 0 || header.toLowerCase().includes("unsaved changes"))).toBe(true);
		expect(existing.defaultMode).toBe("solo");
	});

	it("edits then discard leave original untouched; dirty Esc requires confirmation", async () => {
		const before = structuredClone(existing);
		const p = script(["advisor", "model", "manual", "back", null, "keep", "discard", "discard"], { asks: ["new-model"] });
		expect(await editConfig(p, available, existing, target)).toBeNull();
		expect(existing).toEqual(before);
		expect(calls(p).some(([header]) => header === "Discard unsaved changes?")).toBe(true);
	});

	it("backend model default clears pinned model/effort, not args or timeout", async () => {
		const p = script(["advisor", "model", "default", "back", "review", "save"]);
		const saved = await editConfig(p, available, existing, target);
		const expected = structuredClone(existing);
		delete expected.solo.backend!.model;
		delete expected.solo.backend!.effort;
		delete expected.solo.thinkingLevel;
		expect(saved).toEqual(expected);
	});

	it.each(["model", "effort"])("explicit %s default clears legacy fallback even without a backend pin", async (field) => {
		const source = structuredClone(existing);
		delete source.solo.backend!.model;
		delete source.solo.backend!.effort;
		const p = script(["advisor", field, "default", "back", "review", "save"]);
		const saved = await editConfig(p, available, source, target);
		const expected = structuredClone(source);
		delete expected.solo.thinkingLevel;
		expect(saved).toEqual(expected);
		expect(calls(p).some(([, options]) => options.some((option) => option.hint?.includes("legacy fallback")))).toBe(true);
		expect(source.solo.thinkingLevel).toBe("low");
	});

	it("Esc from backend, model, effort and manual input never resets stored choices", async () => {
		const p = script(["advisor", "backend", null, "model", null, "model", "manual", "effort", null, null, "mode", null, "review", "save"], { asks: [null] });
		expect(await editConfig(p, available, existing, target)).toEqual(existing);
	});

	it("preselects unavailable backend/model/effort and current catalog model", async () => {
		const p = script(["advisor", "backend", "current", "model", "catalog", "effort", "current", "back", "review", "save"], { models: ["other"], filters: [null] });
		expect(await editConfig(p, [], existing, target)).toEqual(existing);
		for (const [header, options, initial] of calls(p).filter(([header]) => /^(Backend ·|Model ·|Reasoning effort ·)/.test(header))) {
			expect(options[initial].value, header).toBe("current");
		}
		expect(p.filterSelect).toHaveBeenCalledWith(expect.any(String), ["retired-model", "other"], 0);
		expect(p.status).toHaveBeenCalledWith(expect.stringContaining("Loading models"));
	});

	it("same backend preserves exact object; different backend replaces backend shape", async () => {
		const source = structuredClone(existing);
		source.solo.backend!.command = "codex";
		const same = script(["advisor", "backend", "choice:0", "back", "review", "save"]);
		expect(await editConfig(same, available, source, target)).toEqual(source);
		const changed = script(["advisor", "backend", "choice:1", "back", "review", "save"]);
		expect((await editConfig(changed, available, source, target))?.solo.backend).toEqual({ type: "http", provider: "anthropic" });
	});

	it("model change clears incompatible effort; only discovered explicit levels offered", async () => {
		const p = script(["advisor", "model", "manual", "effort", "level:low", "back", "review", "save"], { asks: ["new"], efforts: { levels: ["low", "medium"], def: "medium" } });
		const saved = await editConfig(p, available, existing, target);
		expect(saved?.solo.backend).toMatchObject({ model: "new", effort: "low", args: ["--private"] });
		expect(saved?.solo.thinkingLevel).toBeUndefined();
		expect(p.listEfforts).toHaveBeenCalledWith("unavailable-advisor", "new");
		const effort = calls(p).find(([header]) => header.startsWith("Reasoning effort ·"))!;
		expect(effort[1].map((o) => o.value)).toEqual(["default", "level:low", "level:medium"]);
	});

	it("discovery failure falls back to manual/current and preserves draft", async () => {
		const p = script(["advisor", "model", "catalog", "effort", "current", "back", "review", "save"], { filters: [null], failDiscovery: true });
		expect(await editConfig(p, available, existing, target)).toEqual(existing);
	});

	it("custom council member names tokens/back don't collide with actions", async () => {
		const p = script(["council", "seat:tokens", "backend", "default", "back", "seat:back", "backend", "default", "back", "seat:reviewer", "backend", "default", "back", "seat:synthesizer", "backend", "default", "back", "back", "review", "save"]);
		const saved = await editConfig(p, available, existing, target);
		expect(saved?.council).toEqual({ members: ["reviewer", "tokens", "back"], backends: { reviewer: null, tokens: null, back: null }, synthesizer: null });
		expect(saved?.gutCheck).toEqual(existing.gutCheck);
	});

	it("gut-check and every Debate role can be edited while default mode is Solo", async () => {
		const p = script(["gut-check", "seat:backend", "backend", "default", "back", "tokens", "manual", "back", "debate", "seat:advocate", "backend", "default", "back", "seat:critic", "backend", "default", "back", "seat:synthesizer", "backend", "default", "back", "back", "review", "save"], { asks: ["200"] });
		const saved = await editConfig(p, available, existing, target);
		expect(saved?.gutCheck).toEqual({ backend: null, maxOutputTokens: 200 });
		expect(saved?.debate).toEqual({ advocate: null, critic: null, synthesizer: null });
		expect(saved?.defaultMode).toBe("solo");
		expect(saved?.council).toEqual(existing.council);
	});

	it("explicit inherit on an unassigned seat writes null, rather than cancelling", async () => {
		const p = script(["council", "seat:architect", "backend", "default", "back", "back", "review", "save"]);
		const saved = await editConfig(p, available, undefined, target);
		expect(saved).toEqual({ council: { backends: { architect: null } } });
	});

	it("empty draft keeps absent fields absent until edited", async () => {
		expect(await editConfig(script(["review", "save"]), [], undefined, target)).toEqual({});
	});

	it("project route choices restrict ALL sections even with no detected backends", async () => {
		const p = script(["advisor", "backend", null, "back", "gut-check", "seat:backend", "backend", null, "back", "back", "council", "seat:architect", "backend", null, "back", "back", "debate", "seat:critic", "backend", null, "back", "back", "review", "save"]);
		expect(await editConfig(p, available, undefined, { ...target, scope: "project", project: true })).toEqual({});
		for (const [header, options] of calls(p).filter(([header]) => header.startsWith("Backend ·"))) {
			expect(options.map((o) => o.label), header).not.toContain("codex");
			expect(options.map((o) => o.value)).not.toContain("manual");
			expect(options.map((o) => o.label)).toContain("anthropic");
		}
	});

	it.each(["advisor", "gut-check", "council", "debate"])("invalid project %s route blocks save and retains draft", async (section) => {
		const source = { defaultMode: "solo", solo: {} } as BpxCouncilConfig;
		if (section === "advisor") source.solo.backend = { type: "cli", command: "codex" };
		if (section === "gut-check") source.gutCheck = { backend: "codex" };
		if (section === "council") source.council = { backends: { critic: "codex" } };
		if (section === "debate") source.debate = { critic: "codex" };
		const p = script(["review", "back", "review", "back", "discard"]);
		expect(await editConfig(p, available, source, { ...target, scope: "project", project: true })).toBeNull();
		const reviews = calls(p).filter(([header]) => header.includes("Cannot save:"));
		expect(reviews).toHaveLength(2);
		for (const [, options] of reviews) expect(options.map((o) => o.value)).toEqual(["back"]);
	});
});
