import React from "react";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { renderToString, type Key } from "ink";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { ConfigDraft, confirmationChoices, draftFields, modalChoices, type DraftDiscovery } from "../src/config-draft.js";
import { WorkbenchView, backendAccent, fitWorkbenchSegments, fitWorkbenchText, reviewRows, workbenchColor, workbenchGeometry, workbenchKey, type WorkbenchSegment } from "../src/config-workbench.js";
import { editWorkbenchInput } from "../src/workbench-input.js";
import type { BpxCouncilConfig } from "../src/config.js";
import { backendLabel, configRoute, type RouteTarget } from "../src/config-editor.js";
import type { ConfigActions, PersonaGenerationResult, RouteTestResult } from "../src/config-actions.js";
import type { BackendDiagnostic, BackendDiagnostics } from "../src/backend-diagnostics.js";
import { listModels } from "../src/models-list.js";

/** Presence fixture avoids host PATH/key dependencies. @returns Local-only injected service. */
function installedDiagnostics(): BackendDiagnostics {
	const rows: BackendDiagnostic[] = ["codex", "claude", "pi", "opencode"].map(name => ({ name, label: name, kind: "cli", status: "installed", path: `/mock/${name}`, check: "not-checked" }));
	rows.push({ name: "anthropic", label: "Anthropic API", kind: "http", status: "key-present", check: "not-applicable" });
	return { inventory: () => structuredClone(rows), check: vi.fn(async () => structuredClone(rows)) };
}

const existing: BpxCouncilConfig = {
	defaultMode: "solo",
	solo: { backend: { type: "cli", command: "codex", model: "retired", effort: "high", args: ["--private"], timeoutMs: 9123 }, model: "legacy", thinkingLevel: "low" },
	council: { members: ["back", "tokens", "reviewer"], backends: { back: "codex:old", tokens: "pi:unknown", reviewer: "claude" }, synthesizer: "anthropic:judge" },
	debate: { advocate: "claude", critic: "codex:critic", synthesizer: "pi:judge" },
	personas: { back: { stance: "against", systemPrompt: "Do not expose this prompt." } },
	contextWindow: 12345,
};

/** Create isolated controller with no live discovery. @param config Exact starting config. @param discovery Test catalogs. @param project Apply trust restrictions. @returns Controller. */
function make(config: BpxCouncilConfig | undefined = existing, discovery: DraftDiscovery = { listModels: async () => ["new"], listEfforts: async () => ({ levels: ["low", "high"] }) }, project = false): ConfigDraft {
	return new ConfigDraft(config, { path: "/tmp/test.json", scope: project ? "project" : "explicit", project }, [{ name: "codex", kind: "cli", detail: "PATH only" }], discovery, undefined, installedDiagnostics());
}
/** Pick dropdown by exact value. @param controller Controller. @param value Value or undefined for keep current. */
function choose(controller: ConfigDraft, value: string | null | undefined): void {
	const index = modalChoices(controller.modal!).findIndex(choice => choice.value === value && !choice.manual);
	expect(index).toBeGreaterThanOrEqual(0);
	controller.modal!.index = index;
	controller.choose();
}
/** Open specific direct field. @param controller Controller. @param kind Field kind. @param role Optional role identity. */
function edit(controller: ConfigDraft, kind: string, role?: string): void {
	if ((controller.section === "Council" || controller.section === "Debate") && (!controller.fields.some(field => field.kind === kind && (!role || field.target?.role === role)))) {
		while (controller.screen.type !== "root") controller.horizontal("left");
		controller.pane = "detail";
		const index = controller.fields.findIndex(field => field.action === "route" && (!role || field.target?.role === role));
		controller.move("first"); controller.move(index); controller.horizontal("right");
	}
	controller.edit(controller.fields.find(field => field.kind === kind && (!role || field.target?.role === role)));
}
/** Explicit Review then Save via controller keyboard protocol. @param controller Controller. */
function save(controller: ConfigDraft): void {
	controller.selectSection("Review"); controller.pane = "sidebar"; controller.enter(); controller.move(1); controller.enter();
	expect(controller.confirmation?.type).toBe("save"); controller.move(1); controller.enter();
}

describe("workbench draft controller", () => {
	it("shortens single-route labels without losing route targets or Council/Debate roles", () => {
		for (const section of ["Advisor", "Gut-check"] as const) {
			const fields = draftFields(existing, section).slice(0, 3);
			expect(fields.map(field => field.label)).toEqual(["Backend", "Model", "Effort"]);
			expect(fields.map(field => field.target?.role)).toEqual([section, section, section]);
		}
		expect(draftFields(existing, "Council").slice(0, 3).map(field => field.label)).toEqual(["back / Backend", "back / Model", "back / Effort"]);
		expect(draftFields(existing, "Debate")[0].label).toBe("advocate / Backend");
	});
	it("review names every route independently of detail labels, including custom members", () => {
		const c = make();
		const rows = reviewRows(c).map(parts => parts.map(part => part.text).join(""));
		expect(rows.slice(0, -2)).toEqual([
			"Advisor: codex:retired@high", "Gut-check: Inherit Advisor → codex:retired@high",
			"Council / back: codex:old", "Council / tokens: pi:unknown", "Council / reviewer: claude", "Council / Verdict: anthropic:judge",
			"Debate / advocate: claude", "Debate / critic: codex:critic", "Debate / Verdict: pi:judge",
		]);
		c.draft.council = { members: ["synthesizer", "Verdict"], backends: { synthesizer: "pi", Verdict: "codex" }, synthesizer: "claude" };
		const custom = reviewRows(c).map(parts => parts.map(part => part.text).join(""));
		expect(draftFields(c.draft, "Council")[0].label).toBe("synthesizer / Backend");
		expect(custom).toContain("Council / synthesizer: pi");
		expect(custom).toContain("Council / Verdict (member): codex");
		expect(custom).toContain("Council / Verdict: claude");
	});
	it("opens and saves exact clone without normalizing missing keys or discovering", () => {
		const discovery = { listModels: vi.fn(async () => []), listEfforts: vi.fn(async () => null) };
		const c = make(existing, discovery);
		save(c);
		expect(c.result).toEqual({ config: existing, code: 0 });
		expect(c.result?.config).not.toBe(existing);
		expect(discovery.listModels).not.toHaveBeenCalled();
		const empty = make({} as BpxCouncilConfig); save(empty); expect(empty.result?.config).toEqual({});
	});
	it("mode-only edit preserves every route and legacy saved field", () => {
		const c = make(); c.selectSection("Preferences"); edit(c, "mode"); choose(c, "debate");
		c.selectSection("Review"); c.enter(); c.enter();
		expect(c.draft).toEqual({ ...existing, defaultMode: "debate" });
		expect(c.result).toBeUndefined();
		save(c); expect(c.result?.config).toEqual(c.draft);
	});
	it("default clears model/effort/Advisor legacy, same backend preserves args and timeout", () => {
		const c = make(); edit(c, "backend"); choose(c, "codex"); expect(c.dirty).toBe(false);
		edit(c, "model"); choose(c, null);
		expect(c.draft.solo.backend).toEqual({ type: "cli", command: "codex", args: ["--private"], timeoutMs: 9123 });
		expect(c.draft.solo.thinkingLevel).toBeUndefined();
		expect(existing.solo.thinkingLevel).toBe("low");
	});
	it("effort default clears legacy fallback even without pinned effort; Esc never resets", () => {
		const source = structuredClone(existing); delete source.solo.backend!.effort;
		const c = make(source); edit(c, "effort"); c.escape(); expect(c.draft).toEqual(source);
		edit(c, "effort"); choose(c, null); expect(c.draft.solo.thinkingLevel).toBeUndefined();
	});
	it("manual model edit is transactional; cancel retains retired choice", () => {
		const c = make(); edit(c, "model");
		c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.manual); c.choose();
		c.text("pasted:model/id"); c.escape(); expect(c.draft).toEqual(existing);
		edit(c, "model"); c.modal!.index = 2; c.choose(); c.submit("pasted:model/id");
		expect(c.draft.solo.backend).toMatchObject({ model: "pasted:model/id", args: ["--private"] });
		expect(c.draft.solo.backend!.effort).toBeUndefined();
	});
	it("Council actual member identities never collide with back/tokens/verdict", () => {
		const c = make(); c.selectSection("Council");
		expect(c.fields.filter(field => field.action === "route").map(field => field.target?.role)).toEqual(["back", "tokens", "reviewer", "Verdict"]);
		for (const role of ["back", "tokens", "reviewer", "Verdict"]) { edit(c, "backend", role); choose(c, null); }
		expect(c.draft.council).toEqual({ members: ["back", "tokens", "reviewer"], backends: { back: null, tokens: null, reviewer: null }, synthesizer: null });
		expect(c.draft.solo).toEqual(existing.solo);
		expect(c.fields[0].value).toContain("Inherit Advisor → codex:retired@high");
	});
	it("inherited seats write explicit null; inherited model edit cannot silently pin Advisor", () => {
		const c = make({} as BpxCouncilConfig); c.selectSection("Gut-check"); edit(c, "model");
		expect(c.modal).toBeUndefined(); expect(c.dirty).toBe(false);
		edit(c, "backend"); choose(c, null); expect(c.draft).toEqual({ gutCheck: { backend: null } });
	});
	it("seat model IDs containing @ round-trip without becoming an effort pin", async () => {
		const c = make(); c.selectSection("Council"); edit(c, "model", "tokens"); await Promise.resolve();
		c.text("vendor/model@revision"); c.choose(); c.submit(c.modal!.text);
		const target = { section: "council" as const, role: "tokens", member: true };
		expect(c.draft.council?.backends?.tokens).toBe("pi:vendor/model@revision@");
		expect(configRoute(c.draft, target)).toMatchObject({ command: "pi", model: "vendor/model@revision", effort: undefined });
		edit(c, "effort", "tokens"); await Promise.resolve(); choose(c, "high");
		expect(configRoute(c.draft, target)).toMatchObject({ model: "vendor/model@revision", effort: "high" });
	});
	it("Gut-check and Debate remain independent of mode; token validation stays editable", () => {
		const c = make(); c.selectSection("Debate");
		for (const role of ["advocate", "critic", "synthesizer"]) { edit(c, "backend", role); choose(c, null); }
		c.selectSection("Gut-check"); edit(c, "backend"); choose(c, null);
		edit(c, "tokens"); c.modal!.index = 1; c.choose(); c.submit("4097");
		expect(c.modal?.type).toBe("text"); expect(c.error).toContain("1 to 4096");
		c.submit("200"); expect(c.draft.gutCheck).toEqual({ backend: null, maxOutputTokens: 200 });
		expect(c.draft.defaultMode).toBe("solo"); expect(c.draft.debate).toEqual({ advocate: null, critic: null, synthesizer: null });
	});
	it("project choices exclude CLI/manual everywhere; invalid review cannot save", () => {
		const c = make(existing, undefined, true);
		for (const section of ["Advisor", "Gut-check", "Council", "Debate"] as const) {
			c.selectSection(section); edit(c, "backend");
			expect(c.modal!.choices.some(choice => choice.manual)).toBe(false);
			expect(c.modal!.choices.some(choice => choice.value === "codex")).toBe(false);
			expect(c.modal!.choices.some(choice => choice.value === "anthropic")).toBe(true);
		}
		c.selectSection("Review"); expect(c.error).toContain("project"); c.enter(); c.move("last"); c.enter();
		expect(c.result).toBeUndefined(); expect(c.draft).toEqual(existing);
	});
	it("remembers per-section/role row, handles panefocus and Home/End/Page offsets", () => {
		const c = make(); c.selectSection("Council"); c.tab(); c.move(4); expect(c.index).toBe(4);
		c.escape(); c.selectSection("Debate"); c.tab(); c.move("last"); expect(c.index).toBe(2);
		c.escape(); c.selectSection("Council"); c.tab(); expect(c.index).toBe(4);
		c.move(-3); expect(c.index).toBe(1); c.move("first"); expect(c.index).toBe(0);
		edit(c, "model", "back"); c.escape(); expect(c.pane).toBe("detail"); expect(c.index).toBe(0);
	});
	it.each(["claude", "claude:custom/model@revision@high", "claude:sonnet@high"])("Claude %s lists presets before utilities, retains highlighted object and saved pin", async route => {
		const source = structuredClone(existing); source.council!.backends!.reviewer = route;
		const bytes = JSON.stringify(source);
		const c = make(source, { listModels, listEfforts: async () => null });
		c.jump("Council"); edit(c, "model", "reviewer");
		const highlighted = modalChoices(c.modal!)[c.modal!.index];
		const utilities = [...c.modal!.choices];
		await Promise.resolve(); await Promise.resolve();
		const choices = modalChoices(c.modal!);
		expect(choices.slice(0, 3).map(choice => choice.value)).toEqual(["sonnet", "opus", "haiku"]);
		expect(choices.slice(3)).toEqual(utilities);
		for (const [index, utility] of utilities.entries()) expect(choices[index + 3]).toBe(utility);
		expect(choices.at(-1)?.manual).toBe(true);
		expect(choices[c.modal!.index]).toBe(highlighted);
		expect(c.modal!.index).toBe(utilities.indexOf(highlighted) + 3);
		expect(JSON.stringify(c.draft)).toBe(bytes); expect(c.dirty).toBe(false);
		c.enter(); expect(JSON.stringify(c.draft)).toBe(bytes); expect(c.dirty).toBe(false);
		expect(JSON.stringify(source)).toBe(bytes);
	});
	it.each([["codex", "model"], ["claude", "effort"]])("%s %s retains utilities-first ordering", async (backend, kind) => {
		const source = structuredClone(existing); source.council!.backends!.reviewer = `${backend}:saved-model@high`;
		const c = make(source, { listModels: async () => ["listed-model"], listEfforts: async () => ({ levels: ["low", "high"] }) });
		c.jump("Council"); edit(c, kind, "reviewer");
		const utilities = [...c.modal!.choices];
		const highlighted = modalChoices(c.modal!)[c.modal!.index];
		await Promise.resolve(); await Promise.resolve();
		const choices = modalChoices(c.modal!);
		for (const [index, utility] of utilities.entries()) expect(choices[index]).toBe(utility);
		expect(choices.slice(utilities.length).map(choice => choice.value)).toEqual(kind === "model" ? ["listed-model"] : ["low", "high"]);
		expect(choices[c.modal!.index]).toBe(highlighted); expect(c.draft).toEqual(source);
	});
	it("Claude picker retains exact custom model and opens without draft mutation", async () => {
		const source = structuredClone(existing);
		source.council!.backends!.reviewer = "claude:custom/model@revision@high";
		const bytes = JSON.stringify(source);
		const c = make(source, { listModels, listEfforts: async () => null });
		c.jump("Council"); edit(c, "model", "reviewer");
		await Promise.resolve(); await Promise.resolve();
		expect(c.modal?.notice).toBe("Claude aliases; resolved by Claude when run.");
		expect(c.modal?.loading).toBe(false);
		expect(c.modal!.choices.filter(choice => choice.value === null)).toHaveLength(1);
		expect(c.modal!.choices.filter(choice => choice.value !== undefined && choice.value !== null).map(choice => choice.value)).toEqual(["sonnet", "opus", "haiku"]);
		expect(modalChoices(c.modal!)[c.modal!.index].label).toBe("custom/model@revision (current; keep unchanged)");
		expect(c.dirty).toBe(false); expect(JSON.stringify(c.draft)).toBe(bytes);
		c.enter(); expect(c.modal).toBeUndefined(); expect(JSON.stringify(c.draft)).toBe(bytes);
		expect(JSON.stringify(source)).toBe(bytes);
	});
	it.each(["sonnet", "opus", "haiku"])("arrows and Enter stage Claude %s only for chosen Council seat; discard returns no config", async alias => {
		const source = structuredClone(existing);
		source.council!.backends!.reviewer = "claude:custom-model@high";
		const bytes = JSON.stringify(source);
		const c = make(source, { listModels, listEfforts: async () => null });
		c.jump("Council"); edit(c, "model", "reviewer");
		await Promise.resolve(); await Promise.resolve();
		key(c, { home: true });
		const index = modalChoices(c.modal!).findIndex(choice => choice.value === alias);
		expect(index).toBeGreaterThanOrEqual(0);
		for (let i = 0; i <= index; i++) key(c, { downArrow: true });
		key(c, { upArrow: true });
		expect(modalChoices(c.modal!)[c.modal!.index].value).toBe(alias);
		// The field input owns Enter; controller.enter exercises its selection intent.
		c.enter();
		const expected = structuredClone(source); expected.council!.backends!.reviewer = `claude:${alias}`;
		expect(c.draft).toEqual(expected); expect(c.result).toBeUndefined(); expect(c.dirty).toBe(true);
		c.jump("Discard"); c.move(1); c.enter();
		expect(c.confirmation?.index).toBe(0);
		c.move("last"); c.enter();
		expect(c.result).toEqual({ config: null, code: 0 }); expect(c.draft).toEqual(expected);
		expect(JSON.stringify(source)).toBe(bytes);
	});
	it("Escape cancels Claude alias selection without changing saved route", async () => {
		const c = make(existing, { listModels, listEfforts: async () => null });
		c.jump("Council"); edit(c, "model", "reviewer");
		await Promise.resolve(); await Promise.resolve();
		key(c, { home: true }); key(c, { downArrow: true }); key(c, { downArrow: true });
		expect(modalChoices(c.modal!)[c.modal!.index].value).toBe("haiku");
		key(c, { escape: true });
		expect(c.modal).toBeUndefined(); expect(c.draft).toEqual(existing); expect(c.dirty).toBe(false);
		edit(c, "model", "reviewer"); key(c, { escape: true });
		await Promise.resolve(); await Promise.resolve();
		expect(c.modal).toBeUndefined(); expect(c.draft).toEqual(existing);
	});
	it("cancels async lookup on Escape/view switch; ignores late results", async () => {
		let resolve!: (items: string[]) => void; let signal: AbortSignal | undefined;
		const c = make(existing, { listModels: vi.fn((_name, nextSignal) => { signal = nextSignal; return new Promise(done => { resolve = done; }); }), listEfforts: async () => null });
		edit(c, "model"); expect(c.modal?.loading).toBe(true);
		c.escape(); expect(signal?.aborted).toBe(true); resolve(["late"]); await Promise.resolve();
		expect(c.modal).toBeUndefined(); expect(c.draft).toEqual(existing);
		edit(c, "model"); c.selectSection("Debate"); expect(signal?.aborted).toBe(true); resolve(["late"]); await Promise.resolve();
		expect(c.section).toBe("Debate"); expect(c.modal).toBeUndefined();
	});
	it("awaits cancelled lookup cleanup before exposing CLI teardown completion", async () => {
		let resolve!: (items: string[]) => void; let signal: AbortSignal | undefined;
		const c = make(existing, { listModels: (_name, next) => { signal = next; return new Promise(done => { resolve = done; }); }, listEfforts: async () => null });
		edit(c, "model"); c.finish(null, 130);
		let settled = false; const draining = c.settle().then(() => { settled = true; });
		await Promise.resolve(); expect(signal?.aborted).toBe(true); expect(settled).toBe(false);
		resolve([]); await draining; expect(settled).toBe(true);
		expect(c.result).toEqual({ config: null, code: 130 }); expect(c.draft).toEqual(existing);
	});
	it("shows discovery errors/empty fallback, retaining unavailable current model", async () => {
		const c = make(existing, { listModels: async () => { throw new Error("offline"); }, listEfforts: async () => null });
		edit(c, "model"); await Promise.resolve();
		expect(c.modal?.notice).toContain("failed"); expect(c.modal?.loading).toBe(false);
		expect(c.modal!.choices.some(choice => choice.label.includes("retired"))).toBe(true);
		c.text("no match"); expect(modalChoices(c.modal!).some(choice => choice.manual)).toBe(true);
		choose(c, undefined); expect(c.draft).toEqual(existing);
	});
	it("clears legacy Advisor effort without pinning Auto-detect", () => {
		const source = { solo: { thinkingLevel: "ultra", model: "decoration" } } as BpxCouncilConfig;
		const c = make(source); edit(c, "effort");
		expect(c.modal).toBeDefined(); expect(c.modal!.choices.some(choice => choice.manual)).toBe(false);
		c.escape(); expect(c.draft).toEqual(source);
		edit(c, "effort"); choose(c, null);
		expect(c.draft).toEqual({ solo: { model: "decoration" } });
		expect(c.draft.solo.backend).toBeUndefined(); expect(source.solo.thinkingLevel).toBe("ultra");
	});
	it("same-backend manual pins apply while plain backend choice preserves exact route", () => {
		const c = make(); edit(c, "backend"); choose(c, "codex"); expect(c.draft).toEqual(existing);
		edit(c, "backend"); c.text("codex:new@low"); c.choose(); c.submit(c.modal!.text);
		expect(c.draft.solo.backend).toEqual({ ...existing.solo.backend, model: "new", effort: "low" });
		expect(c.draft.solo.thinkingLevel).toBeUndefined();
		edit(c, "backend"); c.text("codex:newer"); c.choose(); c.submit(c.modal!.text);
		expect(c.draft.solo.backend).toEqual({ type: "cli", command: "codex", args: ["--private"], timeoutMs: 9123, model: "newer" });
	});
	it("search Enter selects matching model rather than backend default", async () => {
		const c = make(); edit(c, "model"); await Promise.resolve();
		c.text("new"); expect(modalChoices(c.modal!)[0].value).toBe("new"); c.choose();
		expect(c.draft.solo.backend?.model).toBe("new");
		const source = structuredClone(existing); source.solo.backend!.command = "claude";
		const backend = make(source); edit(backend, "backend"); backend.text("codex"); backend.choose();
		expect(backend.draft.solo.backend?.command).toBe("codex");
	});
	it("unmatched search offers manual entry first and keeps typed ID", async () => {
		const c = make(); edit(c, "model"); await Promise.resolve();
		c.text("provider/unlisted-model"); expect(modalChoices(c.modal!)[0].manual).toBe(true); c.choose();
		expect(c.modal?.type).toBe("text"); expect(c.modal?.text).toBe("provider/unlisted-model");
		expect(c.draft).toEqual(existing); c.submit(c.modal!.text);
		expect(c.draft.solo.backend?.model).toBe("provider/unlisted-model");
	});
	it("late catalog preserves highlighted choice instead of moving Enter target", async () => {
		let resolve!: (items: string[]) => void;
		const c = make(existing, { listModels: () => new Promise(done => { resolve = done; }), listEfforts: async () => null });
		edit(c, "model"); c.text("new"); const before = modalChoices(c.modal!)[0];
		resolve(["new"]); await Promise.resolve();
		expect(modalChoices(c.modal!)[c.modal!.index]).toBe(before);
		c.choose(); expect(c.modal?.type).toBe("text"); expect(c.draft).toEqual(existing);
	});
	it("direct section shortcuts retain focus and never imply Save or Discard", () => {
		const c = make(); c.jump("Council"); c.move(4); c.jump("Debate"); c.jump("Council");
		expect(c.pane).toBe("detail"); expect(c.index).toBe(4);
		c.jump("Review"); c.enter(); expect(c.section).toBe("Council"); expect(c.result).toBeUndefined();
	});
	it("fresh exit confirmation defaults to keep editing without jumping sections", () => {
		const c = make(); c.jump("Discard"); c.move(1); c.escape(); c.escape();
		expect(c.confirmation?.index).toBe(0); c.enter(); expect(c.result).toBeUndefined();
		expect(c.section).toBe("Discard"); expect(c.pane).toBe("sidebar"); expect(c.focus.Discard).toBe(1);
	});
	it("discard and Ctrl-C never return draft or mutate source", () => {
		const c = make(); c.selectSection("Preferences"); edit(c, "mode"); choose(c, "council");
		c.selectSection("Discard"); c.enter(); c.move(1); c.enter();
		expect(c.confirmation?.type).toBe("exit"); c.move("last"); c.enter(); expect(c.result).toEqual({ config: null, code: 0 });
		const interrupted = make(); interrupted.finish(null, 130); expect(interrupted.result).toEqual({ config: null, code: 130 });
		expect(existing.defaultMode).toBe("solo");
	});
});

/** Send an Ink key without attaching to a real terminal. @param controller Draft. @param flags Key flags. @param input Optional shortcut text. */
function key(controller: ConfigDraft, flags: Partial<Key>, input = ""): void {
	workbenchKey(controller, input, flags as Key, { columns: 100, rows: 28 });
}

/** Snapshot workspace independently of confirmation. @param controller Draft. @returns Exact focus and serialized draft. */
function workspace(controller: ConfigDraft): unknown {
	return { section: controller.section, pane: controller.pane, focus: structuredClone(controller.focus), draft: JSON.stringify(controller.draft), error: controller.error };
}

describe("workbench horizontal navigation", () => {
	it("Right enters detail, then edits; Left detail returns sidebar and Left sidebar does nothing", () => {
		const c = make(); const before = workspace(c);
		key(c, { leftArrow: true }); expect(workspace(c)).toEqual(before);
		key(c, { rightArrow: true }); expect(c.pane).toBe("detail"); expect(c.modal).toBeUndefined();
		c.move(1); key(c, { leftArrow: true }); expect(c.pane).toBe("sidebar"); expect(c.index).toBe(1);
		key(c, { rightArrow: true }); expect(c.pane).toBe("detail"); expect(c.index).toBe(1);
		key(c, { rightArrow: true }); expect(c.modal?.field.kind).toBe("model"); expect(c.draft).toEqual(existing);
		c.cancel();
	});
	it.each(["Review", "Discard"] as const)("Right only enters %s; neither action row executes without Enter", section => {
		const c = make(); c.selectSection(section);
		key(c, { rightArrow: true }); expect(c.pane).toBe("detail");
		for (const index of [0, 1]) {
			c.focus[section] = index; const before = workspace(c);
			key(c, { rightArrow: true });
			expect(workspace(c)).toEqual(before); expect(c.confirmation).toBeUndefined(); expect(c.result).toBeUndefined();
		}
		key(c, { return: true }); expect(c.confirmation?.type).toBe(section === "Review" ? "save" : "exit");
		key(c, { rightArrow: true }); expect(c.confirmation?.index).toBe(1); expect(c.result).toBeUndefined();
		key(c, { return: true }); expect(c.result?.code).toBe(0);
	});
	it.each(["choices", "text"])("%s modal owns Left/Right caret and traps pane/section shortcuts", type => {
		const c = make(); c.jump("Advisor"); edit(c, "model");
		if (type === "text") { c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.manual); c.choose(); }
		c.text("abc"); c.modal!.index = type === "choices" ? 1 : 0;
		const modal = c.modal; const before = workspace(c); const index = modal!.index;
		let cursor = 1;
		for (const flag of ["rightArrow", "leftArrow"] as const) {
			const edited = editWorkbenchInput(modal!.text, cursor, "", { [flag]: true }); cursor = edited.cursor;
			expect(cursor).toBe(flag === "rightArrow" ? 2 : 1);
			key(c, { [flag]: true });
			expect(c.modal).toBe(modal); expect(modal!.text).toBe("abc"); expect(modal!.index).toBe(index); expect(workspace(c)).toEqual(before);
		}
		key(c, {}, "6"); key(c, { tab: true }); key(c, { tab: true, shift: true });
		expect(workspace(c)).toEqual(before); expect(c.confirmation).toBeUndefined();
		if (type === "text") { key(c, { home: true }); key(c, { downArrow: true }); expect(modal!.index).toBe(index); }
		c.cancel();
	});
	it("ignores released horizontal keys", () => {
		const c = make(); key(c, { rightArrow: true, eventType: "release" }); expect(c.pane).toBe("sidebar");
	});
});

describe("workbench confirmations", () => {
	it.each([false, true])("Esc follows field/detail/sidebar/exit stack, dirty=%s", dirty => {
		const c = make();
		if (dirty) { c.jump("Preferences"); edit(c, "mode"); choose(c, "council"); }
		c.jump("Council"); c.move(1); c.enter(); c.move(1); c.enter();
		const draft = c.draft; const bytes = JSON.stringify(draft);
		expect(c.modal).toBeDefined(); c.escape();
		expect(c.modal).toBeUndefined(); expect(c.pane).toBe("detail"); expect(c.index).toBe(1);
		c.escape(); expect(c.screen.type).toBe("root"); expect(c.index).toBe(1);
		c.escape(); expect(c.pane).toBe("sidebar"); expect(c.confirmation).toBeUndefined();
		const before = workspace(c); c.escape();
		expect(c.confirmation).toEqual({ type: "exit", dirty, index: 0 });
		expect(confirmationChoices(c.confirmation!).map(choice => choice.label)).toEqual(dirty ? ["Keep editing", "Save & exit", "Discard & exit"] : ["Keep editing", "Exit"]);
		expect(workspace(c)).toEqual(before); expect(c.draft).toBe(draft); expect(JSON.stringify(c.draft)).toBe(bytes);
		c.move("last"); c.escape(); expect(c.confirmation).toBeUndefined(); expect(workspace(c)).toEqual(before);
		expect(c.result).toBeUndefined(); c.tab(); expect(c.index).toBe(1);
	});
	it("Review Save opens Cancel by default; cancel restores exact row and repeated Enter remains safe", () => {
		const c = make(); c.jump("Council"); c.move(7); c.jump("Review"); c.move(1);
		const before = workspace(c); const draft = c.draft;
		c.enter(); expect(c.confirmation).toEqual({ type: "save", dirty: false, index: 0 });
		expect(workspace(c)).toEqual(before); expect(c.result).toBeUndefined();
		c.move(1); c.escape(); expect(workspace(c)).toEqual(before); expect(c.draft).toBe(draft);
		c.enter(); c.enter(); c.enter(); expect(c.result).toBeUndefined();
		expect(c.confirmation?.index).toBe(0); expect(workspace(c)).toEqual(before);
	});
	it("Discard explicit exit opens same dialog, cancel preserves dirty draft and Discard row", () => {
		const c = make(); c.jump("Preferences"); edit(c, "mode"); choose(c, "debate");
		c.jump("Discard"); c.move(1); const before = workspace(c); const draft = c.draft;
		c.enter(); expect(c.confirmation).toEqual({ type: "exit", dirty: true, index: 0 });
		c.enter(); expect(workspace(c)).toEqual(before); expect(c.draft).toBe(draft);
		c.enter(); expect(c.confirmation?.index).toBe(0); expect(c.result).toBeUndefined();
	});
	it("traps root shortcuts, arrows, Tab, Home/End and ignores other keys", () => {
		const c = make(); c.jump("Preferences"); edit(c, "mode"); choose(c, "debate"); c.jump("Council"); c.move(5); c.escape(); c.escape();
		const before = workspace(c);
		for (const input of ["1", "6", "7", "x"]) key(c, {}, input);
		c.jump("Review"); c.selectSection("Discard"); c.edit(c.fields[0]);
		expect(workspace(c)).toEqual(before); expect(c.modal).toBeUndefined();
		key(c, { rightArrow: true }); expect(c.confirmation?.index).toBe(1);
		key(c, { downArrow: true }); expect(c.confirmation?.index).toBe(2);
		key(c, { tab: true }); expect(c.confirmation?.index).toBe(0);
		key(c, { tab: true, shift: true }); expect(c.confirmation?.index).toBe(2);
		key(c, { leftArrow: true }); expect(c.confirmation?.index).toBe(1);
		key(c, { upArrow: true }); expect(c.confirmation?.index).toBe(0);
		key(c, { end: true }); expect(c.confirmation?.index).toBe(2);
		key(c, { home: true }); expect(c.confirmation?.index).toBe(0);
		key(c, { pageDown: true }); expect(c.confirmation?.index).toBe(0);
		key(c, { return: true, eventType: "release" }); expect(c.confirmation).toBeDefined();
		expect(workspace(c)).toEqual(before); expect(c.result).toBeUndefined();
	});
	it.each(["review", "exit"])("%s Save returns byte-equivalent immutable clone once", source => {
		const config = structuredClone(existing); const sourceBytes = JSON.stringify(config); const c = make(config);
		if (source === "review") { c.jump("Review"); c.move(1); c.enter(); }
		else { c.jump("Preferences"); edit(c, "mode"); choose(c, "debate"); c.escape(); c.escape(); }
		const draftBytes = JSON.stringify(c.draft); c.move(1); key(c, { return: true });
		expect(c.confirmation).toBeUndefined(); expect(c.result?.code).toBe(0); expect(JSON.stringify(c.result?.config)).toBe(draftBytes);
		expect(c.result?.config).not.toBe(c.draft); expect(JSON.stringify(config)).toBe(sourceBytes);
		const result = c.result; key(c, { return: true }); c.finish(null, 130); expect(c.result).toBe(result);
		if (c.result?.config?.solo?.backend) c.result.config.solo.backend.model = "result-only";
		expect(JSON.stringify(c.draft)).toBe(draftBytes);
	});
	it.each([false, true])("exit/discard returns no config without mutating source or draft, dirty=%s", dirty => {
		const c = make(); const sourceBytes = JSON.stringify(existing);
		if (dirty) { c.jump("Preferences"); edit(c, "mode"); choose(c, "debate"); c.escape(); }
		const draft = c.draft; const draftBytes = JSON.stringify(draft); c.escape(); c.move("last"); c.enter();
		expect(c.result).toEqual({ config: null, code: 0 }); expect(c.draft).toBe(draft); expect(JSON.stringify(c.draft)).toBe(draftBytes); expect(JSON.stringify(existing)).toBe(sourceBytes);
	});
	it("invalid Save refuses opening and stays editable with error", () => {
		const c = make(); c.jump("Review"); c.move(1); c.draft.gutCheck = { maxOutputTokens: 4097 };
		const bytes = JSON.stringify(c.draft); c.enter();
		expect(c.confirmation).toBeUndefined(); expect(c.result).toBeUndefined(); expect(c.error).toContain("1 to 4096");
		expect(c.section).toBe("Review"); expect(c.pane).toBe("detail"); expect(JSON.stringify(c.draft)).toBe(bytes);
		c.jump("Gut-check"); edit(c, "tokens"); expect(c.modal).toBeDefined(); c.cancel();
	});
	it.each(["save", "exit"])("%s Save revalidates on confirmation, closes dialog without a result on failure", type => {
		const c = make();
		if (type === "save") { c.jump("Review"); c.move(1); c.enter(); }
		else { c.draft.defaultMode = "debate"; c.escape(); }
		// Simulate a draft invalidated after opening, independent of UI key trapping.
		c.draft.gutCheck = { maxOutputTokens: 4097 };
		const bytes = JSON.stringify(c.draft); c.move(1); c.enter();
		expect(c.confirmation).toBeUndefined(); expect(c.result).toBeUndefined(); expect(c.error).toContain("1 to 4096"); expect(JSON.stringify(c.draft)).toBe(bytes);
		c.jump("Gut-check"); edit(c, "tokens"); expect(c.modal).toBeDefined(); c.cancel();
	});
	it.each(["choices", "text"])("root Enter does not redispatch after %s field input applies and unmounts", type => {
		const c = make(); c.jump(type === "choices" ? "Preferences" : "Advisor"); edit(c, type === "choices" ? "mode" : "model");
		if (type === "text") { c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.manual); c.choose(); }
		const editing = c.modal;
		// Child WorkbenchInput handles this same Enter before the root input callback.
		if (type === "choices") choose(c, "debate"); else c.submit("manual-model");
		workbenchKey(c, "", { return: true } as Key, { columns: 100, rows: 28 }, editing);
		expect(c.modal).toBeUndefined(); expect(c.confirmation).toBeUndefined(); expect(c.dirty).toBe(true);
		key(c, {}, "7"); expect(c.section).toBe("Review"); expect(c.modal).toBeUndefined();
	});
	it("Ctrl-C aborts immediately from confirmation and cannot be replaced by Save", () => {
		const c = make(); c.jump("Review"); c.move(1); c.enter(); c.move(1);
		key(c, { ctrl: true }, "c"); expect(c.result).toEqual({ config: null, code: 130 }); expect(c.confirmation).toBeUndefined();
		c.enter(); expect(c.result).toEqual({ config: null, code: 130 }); expect(c.draft).toEqual(existing);
	});
});

/** Presentation rows exposed by the view before Ink mounts them. */
interface PresentationRow { text?: string; segments?: WorkbenchSegment[]; width: number; active?: boolean; children?: React.ReactNode }
/** Collect row elements without mounting input hooks. @param controller Draft. @returns View's plain and segmented rows. */
function presentationRows(controller: ConfigDraft): React.ReactElement<PresentationRow>[] {
	const rows: React.ReactElement<PresentationRow>[] = [];
	/** Walk already-created layout children. @param node Layout subtree. */
	const visit = (node: React.ReactNode): void => {
		React.Children.forEach(node, child => {
			if (!React.isValidElement<PresentationRow>(child)) return;
			if (child.props.text !== undefined || child.props.segments) rows.push(child);
			visit(child.props.children);
		});
	};
	visit(WorkbenchView({ controller, size: { columns: 120, rows: 28 } }));
	return rows;
}
/** Join presentation fragments for row matching. @param row View row. @returns Plain row text. */
function rowText(row: React.ReactElement<PresentationRow>): string { return row.props.segments?.map(part => part.text).join("") ?? row.props.text ?? ""; }

describe("workbench identity accents", () => {
	it("maps four backend groups exactly; defaults, unknowns and lookalike IDs remain neutral", () => {
		const colors = [backendAccent("codex"), backendAccent("claude"), backendAccent("pi"), backendAccent("opencode")];
		expect(new Set(colors).size).toBe(4); expect(colors.every(Boolean)).toBe(true);
		expect(backendAccent("openai")).toBe(colors[0]); expect(backendAccent("anthropic")).toBe(colors[1]);
		for (const name of [undefined, "Auto-detect", "Backend default", "unknown", "provider/pi-model", "claude-persona", "custom-codex"]) expect(backendAccent(name)).toBeUndefined();
	});
	it("clips combined cell budget across segments, strips ANSI/controls and leaves ellipsis neutral", () => {
		const segments = [{ text: "x " }, { text: "\x1b[31m界界\n", color: backendAccent("pi") }, { text: " suffix" }];
		expect(fitWorkbenchSegments(segments, 5)).toEqual([{ text: "x " }, { text: "界", color: backendAccent("pi") }, { text: "…" }]);
		for (let width = 0; width <= 20; width++) {
			const parts = fitWorkbenchSegments(segments, width); const text = parts.map(part => part.text).join("");
			expect(stringWidth(text)).toBeLessThanOrEqual(width); expect(text).toBe(stripAnsi(text)); expect(text).not.toContain("\n");
		}
		expect(fitWorkbenchSegments([{ text: "ab" }, { text: "c", color: "red" }], 2)).toEqual([{ text: "a" }, { text: "…" }]);
		expect(fitWorkbenchSegments([{ text: "界", color: "red" }], 1)).toEqual([{ text: "…" }]);
	});
	it("accents backend/model values from route identity, not model IDs or custom role labels", () => {
		const c = make(); c.jump("Council"); c.move(2);
		c.draft.council = { members: ["claude-persona"], backends: { "claude-persona": "pi:codex-model" } };
		c.move("first"); c.horizontal("right");
		const rows = presentationRows(c);
		const model = rows.find(row => rowText(row).includes(" Model"))!;
		expect(model.props.segments![0].color).toBeUndefined();
		expect(model.props.segments!.find(part => part.text === "codex-model")?.color).toBe(backendAccent("pi"));
		const effort = rows.find(row => rowText(row).includes(" Effort"))!;
		expect(effort.props.segments!.every(part => !part.color)).toBe(true);
		c.horizontal("left"); c.move(1); c.horizontal("right");
		const inherited = presentationRows(c).find(row => row.props.segments && rowText(row).includes(" Backend"))!;
		expect(inherited.props.segments!.find(part => part.text === "Inherit Advisor → ")?.color).toBeUndefined();
		expect(inherited.props.segments!.find(part => part.text === "codex:retired@high")?.color).toBe(backendAccent("codex"));
		const empty = make({} as BpxCouncilConfig); empty.tab();
		expect(presentationRows(empty).filter(row => row.props.segments).every(row => row.props.segments!.every(part => !part.color))).toBe(true);
	});
	it("amber focus overrides every segment foreground and background, leaving labels and marker present", () => {
		const c = make(); c.tab();
		const row = presentationRows(c).find(row => row.props.active && row.props.segments)!;
		expect(rowText(row)).toContain("► Backend");
		const renderRow = row.type as (props: PresentationRow) => React.ReactElement<{ color: string; backgroundColor: string; children: React.ReactNode }>;
		const inkRow = renderRow(row.props);
		expect(inkRow.props.color).toBe(workbenchColor("black")); expect(inkRow.props.backgroundColor).toBe(workbenchColor("#ffd787"));
		for (const child of React.Children.toArray(inkRow.props.children)) {
			if (!React.isValidElement<{ color: string; backgroundColor: string }>(child)) continue;
			expect(child.props.color).toBe(workbenchColor("black")); expect(child.props.backgroundColor).toBe(workbenchColor("#ffd787"));
		}
	});
	it("only nonempty NO_COLOR opts out of requested color props", () => {
		expect(workbenchColor("red", "")).toBe("red");
		for (const value of ["1", "0", "false", " "]) expect(workbenchColor("red", value)).toBeUndefined();
		expect(workbenchColor(undefined, "")).toBeUndefined();
	});
	it.each(["1", ""])("NO_COLOR=%j overrides forced color only when nonempty; bold/caret/borders remain", noColor => {
		const env = { ...process.env, FORCE_COLOR: "3", NO_COLOR: noColor };
		const script = `
			import React from "react";
			import { renderToString } from "ink";
			import { WorkbenchView } from ${JSON.stringify(new URL("../src/config-workbench.tsx", import.meta.url).href)};
			import { ConfigDraft } from ${JSON.stringify(new URL("../src/config-draft.ts", import.meta.url).href)};
			const config = { solo: { backend: { type: "cli", command: "pi", model: "codex-model" } }, council: { members: ["architect", "critic", "simplifier"], backends: { architect: "codex", critic: "claude", simplifier: "opencode" }, synthesizer: "anthropic" } };
			const backends = ["pi", "codex", "claude", "opencode"].map(name => ({ name, kind: "cli", detail: "mock" }));
			const diagnostics = { inventory: () => [...backends.map(row => ({ ...row, label: row.name, status: "installed", path: "/mock/" + row.name, check: "not-checked" })), { name: "anthropic", label: "Anthropic API", kind: "http", status: "key-present", check: "not-applicable" }], check: async () => [] };
			const c = new ConfigDraft(config, { path: "/tmp/test.json", scope: "explicit" }, backends, { listModels: async () => ["catalog-model"], listEfforts: async () => null }, undefined, diagnostics);
			const screens = {};
			/** Capture current frame without starting a terminal session. */
			function capture(name, columns = 100, rows = 28) { screens[name] = renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows } }), { columns }); }
			capture("sidebar"); c.tab(); capture("detail");
			c.jump("Council"); capture("council");
			c.jump("Backends"); capture("backends"); c.move(2); c.horizontal("right"); capture("backendDetail"); capture("backendNarrow", 40, 12);
			c.jump("Review"); capture("review"); c.move(1); c.enter(); capture("save"); c.escape();
			c.jump("Advisor"); c.enter(); capture("backendChoices"); c.cancel();
			c.move(1); c.enter(); await Promise.resolve(); capture("search");
			c.modal.index = c.modal.choices.findIndex(choice => choice.manual); c.choose(); c.text("manual-model"); capture("manual"); c.cancel();
			c.escape(); c.escape(); capture("exit"); capture("narrow", 40, 12); capture("tiny", 20, 8);
			process.stdout.write(JSON.stringify(screens));
		`;
		const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { env, encoding: "utf8" });
		expect(result.status, result.stderr).toBe(0);
		const screens: Record<string, string> = JSON.parse(result.stdout);
		for (const [name, screen] of Object.entries(screens)) {
			// Inspect color SGR only: bold/inverse and Ink terminal controls must remain usable.
			const colors = [...screen.matchAll(/\x1b\[([0-9;]*)m/g)].filter(match => match[1].split(";").map(Number).some(code => (code >= 30 && code <= 49) || (code >= 90 && code <= 107)));
			if (noColor) expect(colors, name).toEqual([]);
			else expect(colors.length, name).toBeGreaterThan(0);
		}
		expect(stripAnsi(screens.detail)).toContain("► Backend"); expect(stripAnsi(screens.detail)).toContain("pi:codex-model");
		expect(screens.detail).toMatch(/\x1b\[1m/); expect(screens.manual).toMatch(/\x1b\[7m/);
		expect(stripAnsi(screens.sidebar)).toContain("╔"); expect(stripAnsi(screens.save)).toContain("Save changes?");
		expect(stripAnsi(screens.search)).toContain("Find:"); expect(stripAnsi(screens.manual)).toContain("Value:");
	});
	it("backend choices accent names only; current/catalog model choices keep information suffix neutral", async () => {
		const c = make(); c.tab(); edit(c, "backend");
		let rows = presentationRows(c);
		const choice = rows.find(row => rowText(row).includes("codex (Installed; not checked)"))!;
		expect(choice.props.segments).toEqual([{ text: "  " }, { text: "codex", color: backendAccent("codex") }, { text: " (Installed; not checked)" }]);
		expect(c.modal!.choices.find(choice => choice.value === null)?.backend).toBeUndefined();
		expect(c.modal!.choices.find(choice => choice.manual)?.backend).toBeUndefined();
		c.cancel(); edit(c, "model"); await Promise.resolve(); rows = presentationRows(c);
		const current = rows.find(row => rowText(row).includes("retired (current; keep unchanged)"))!;
		expect(current.props.segments![1]).toEqual({ text: "retired", color: backendAccent("codex") });
		expect(current.props.segments![2]).toEqual({ text: " (current; keep unchanged)" });
		expect(c.modal!.choices.find(choice => choice.value === "new")).toMatchObject({ backend: "codex", accentText: "new" });
		c.cancel();
	});
});

describe("workbench renderer", () => {
	it("dialog title shows selected backend/model without redundant Advisor/Gut-check labels", () => {
		const c = make(); edit(c, "model");
		expect(presentationRows(c).map(rowText)).toContain("Edit Model · Codex · retired");
		expect(presentationRows(c).map(rowText).some(text => text.includes("Advisor / Model"))).toBe(false);
		c.cancel(); c.jump("Gut-check"); edit(c, "backend");
		expect(presentationRows(c).map(rowText)).toContain("Edit Backend · Codex · retired");
		c.cancel(); c.jump("Council"); edit(c, "model", "tokens");
		expect(presentationRows(c).map(rowText)).toContain("Edit Model · Pi · unknown"); c.cancel();
	});
	it.each([20, 40, 61, 100])("keeps both horizontal hints visible at %i columns", columns => {
		for (const pane of ["sidebar", "detail"] as const) {
			const c = make(); c.pane = pane;
			const screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows: 20 } }), { columns }));
			expect(screen).toContain("←"); expect(screen).toContain("→");
		}
	});
	it.each([[100, 28], [61, 20], [40, 12], [20, 8], [80, 10]])("bounds frame to %ix%i and retains status/path/keyhint", (columns, rows) => {
		const c = make();
		const screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows } }), { columns }));
		const lines = screen.split("\n"); expect(lines.length).toBeLessThanOrEqual(rows);
		for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
		expect(screen).toContain("bpx-council"); expect(screen).toContain("explicit");
		if (columns >= 40) expect(screen).toContain("Tab");
	});
	it("wide frame contains persistent sidebar, direct values, path, and focus cue", () => {
		const c = make(); c.tab();
		const screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns: 120, rows: 28 } }), { columns: 120 }));
		for (const section of ["Advisor", "Gut-check", "Council", "Debate", "Preferences", "Review", "Discard"]) expect(screen).toContain(section);
		expect(screen).toContain("codex:retired@high"); expect(screen).toContain("/tmp/test.json"); expect(screen).toContain("► Backend"); expect(screen).toContain("custom args override model/effort");
	});
	it("review excludes private prompts/arguments; Pi dialog marks catalog limits", () => {
		const c = make(); c.selectSection("Review"); c.tab();
		let screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns: 120, rows: 28 } }), { columns: 120 }));
		expect(screen).not.toContain("private"); expect(screen).not.toContain("Do not expose"); expect(screen).toContain("Save");
		c.selectSection("Council"); edit(c, "model", "tokens");
		screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns: 120, rows: 28 } }), { columns: 120 }));
		expect(screen).toContain("auth-filtered catalog; extensions disabled"); expect(screen).toContain("unknown (current");
		c.cancel();
	});
	it.each([[100, 28], [40, 12], [20, 8]])("centers bounded Save/clean-exit/dirty-exit overlays in %ix%i", (columns, rows) => {
		for (const type of ["save", "clean-exit", "dirty-exit"] as const) {
			const c = make();
			if (type === "save") { c.jump("Review"); c.move(1); c.enter(); }
			else { if (type === "dirty-exit") c.draft.defaultMode = "debate"; c.escape(); }
			const before = workspace(c);
			const screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows } }), { columns }));
			const lines = screen.split("\n"); expect(lines.length).toBeLessThanOrEqual(rows);
			for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
			const panel = workbenchGeometry(c, { columns, rows }).dialog;
			const title = fitWorkbenchText(type === "save" ? "Save changes?" : "Exit configuration?", panel.innerWidth);
			const titleRow = lines.findIndex(line => line.includes(title));
			expect(titleRow).toBe(panel.top + Number(panel.inset > 0));
			expect(lines[titleRow].indexOf(title)).toBe(panel.left + panel.inset);
			expect(Math.abs(panel.left - (columns - panel.width - panel.left))).toBeLessThanOrEqual(1);
			expect(Math.abs(panel.top - (rows - 1 - panel.height - panel.top))).toBeLessThanOrEqual(1);
			expect(screen).toContain(type === "save" ? "► Cancel" : "► Keep editing");
			if (type === "dirty-exit") { expect(screen).toContain("Save & exit"); expect(screen).toContain("Discard & exit"); }
			if (columns === 100) {
				for (const section of ["Advisor", "Gut-check", "Council", "Debate", "Preferences", "Review", "Discard"]) expect(screen).toContain(section);
				expect(screen).toContain("bpx-council"); expect(screen).toContain("explicit");
			}
			expect(workspace(c)).toEqual(before); c.escape(); expect(workspace(c)).toEqual(before);
		}
	});
	it("suppresses underlying amber focus while keeping workspace mounted", () => {
		for (const pane of ["sidebar", "detail"] as const) {
			const c = make(); c.pane = pane;
			if (pane === "sidebar") c.escape(); else { c.jump("Review"); c.move(1); c.enter(); }
			const tree = WorkbenchView({ controller: c, size: { columns: 100, rows: 28 } }) as React.ReactElement<{ children?: React.ReactNode }>;
			const children = React.Children.toArray(tree.props.children);
			expect(children).toHaveLength(2);
			/** Inspect workspace Row props without mounting confirmation children. @param node Workspace subtree. */
			const inspect = (node: React.ReactNode): void => {
				React.Children.forEach(node, child => {
					if (!React.isValidElement<{ active?: boolean; children?: React.ReactNode }>(child)) return;
					expect(child.props.active).not.toBe(true); inspect(child.props.children);
				});
			};
			inspect(children[0]);
		}
	});
	it("clips wide characters and strips escape/control injections", () => {
		expect(fitWorkbenchText("\x1b[31m界界x\n", 4)).toBe("界…");
		expect(fitWorkbenchText("abc\rdef", 20)).toBe("abc def");
	});
});

/** Mock-only paid operations; source route remains opaque and no process/provider starts. @returns Injectable service. */
function mockActions(): ConfigActions {
	return {
		preflight: vi.fn((draft, target) => ({ route: backendLabel(configRoute(draft, target) ?? draft.solo?.backend) })),
		test: vi.fn(async (draft, target) => ({ ok: true, route: backendLabel(configRoute(draft, target) ?? draft.solo?.backend), elapsedMs: 12, text: "OK" })),
		generate: vi.fn(async () => ({ ok: true, route: "claude:generator", elapsedMs: 25, text: "", candidate: { name: "evidence", stance: "against", systemPrompt: "Check evidence.\nAllow either verdict." } })),
	};
}
/** Construct controller over mocks only. @param actions Injectable paid service. @param config Exact unsaved source. @param project Trust restriction. @returns Controller. */
function withActions(actions = mockActions(), config = existing, project = false): ConfigDraft {
	return new ConfigDraft(config, { path: "/tmp/test.json", scope: project ? "project" : "explicit", project }, [{ name: "claude", kind: "cli", detail: "mock" }, { name: "pi", kind: "cli", detail: "mock" }], { listModels: async () => [], listEfforts: async () => null }, actions, installedDiagnostics());
}
/** Focus named action through contextual rows. @param c Controller. @param action Row intent. */
function action(c: ConfigDraft, action: string): void {
	const index = c.fields.findIndex(field => field.action === action);
	expect(index).toBeGreaterThanOrEqual(0); c.move("first"); c.move(index); c.enter();
}
/** Confirm cost only after checking safe initial choice. @param c Controller. */
function runConfirmed(c: ConfigDraft): void { expect(c.confirmation?.type).toBe("cost"); expect(c.confirmation?.index).toBe(0); c.move(1); c.enter(); }
/** Drain resolved mock jobs without calling controller.settle (which intentionally cancels). */
async function flushOperations(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }

describe("nested workbench and staged persona flows", () => {
	it("Council overview uses one row per persona, Verdict separate; restores parent focus", () => {
		const c = withActions(); c.jump("Council");
		expect(c.fields.slice(0, 4).map(f => [f.label, f.kind, f.target?.member])).toEqual([["back", "action", true], ["tokens", "action", true], ["reviewer", "action", true], ["Verdict", "action", undefined]]);
		c.move(1); c.horizontal("right"); expect(c.breadcrumb).toBe("Council > tokens");
		expect(c.fields.map(f => f.label)).toEqual(["Backend", "Model", "Effort", "Persona", "Test this route"]);
		c.move(3); c.horizontal("right"); expect(c.breadcrumb).toBe("Council > tokens > Persona");
		c.horizontal("left"); expect(c.index).toBe(3); c.escape(); expect(c.screen.type).toBe("root"); expect(c.index).toBe(1);
		c.jump("Debate"); c.move(1); c.enter(); expect(c.breadcrumb).toBe("Debate > critic");
		expect(c.fields.map(f => f.label)).toEqual(["Backend", "Model", "Effort", "Test this route"]);
		c.escape(); expect(c.index).toBe(1); expect(c.section).toBe("Debate");
	});
	it("literal Verdict member cannot share closing Verdict target or route fields", () => {
		const config = structuredClone(existing); config.council = { members: ["Verdict"], backends: { Verdict: "pi:member" }, synthesizer: "claude:closing" };
		const c = withActions(mockActions(), config); c.jump("Council"); c.enter(); expect(c.fields[0].target?.member).toBe(true); expect(c.fields[0].value).toBe("pi:member");
		c.escape(); c.move(1); c.enter(); expect(c.fields[0].target?.member).toBeUndefined(); expect(c.fields[0].value).toBe("claude:closing"); expect(c.fields.some(f => f.action === "persona")).toBe(false); expect(c.draft).toEqual(config);
	});
	it("Right never executes Test/Add/seat/Accept actions; Enter does", () => {
		const service = mockActions(); const c = withActions(service); c.jump("Council");
		for (const intent of ["add", "test-all"]) { c.move("first"); c.move(c.fields.findIndex(f => f.action === intent)); c.horizontal("right"); expect(c.screen.type).toBe("root"); expect(c.confirmation).toBeUndefined(); }
		action(c, "library"); c.enter(); const bytes = JSON.stringify(c.draft); c.horizontal("right"); expect(JSON.stringify(c.draft)).toBe(bytes);
		c.enter(); expect(JSON.stringify(c.draft)).not.toBe(bytes);
		expect(service.test).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
	});
	it("manual candidate fields and multiline apply remain isolated until preview Accept", () => {
		const c = withActions(); c.jump("Council"); action(c, "add"); action(c, "manual"); const bytes = JSON.stringify(c.draft);
		c.enter(); c.submit("tokens"); c.move(1); c.enter(); choose(c, "for"); c.move(1); c.enter(); expect(c.multiline).toBe(true);
		c.text(" leading\n\tindented\n"); c.submit(c.modal!.text); expect(JSON.stringify(c.draft)).toBe(bytes);
		action(c, "preview"); action(c, "accept"); expect(c.error).toContain("already exists"); expect(JSON.stringify(c.draft)).toBe(bytes);
		action(c, "candidate-edit"); c.enter(); c.submit("new-persona"); action(c, "preview"); action(c, "accept");
		expect(c.draft.personas?.["new-persona"]).toEqual({ stance: "for", systemPrompt: " leading\n\tindented\n" });
		expect(c.draft.council?.members).toContain("new-persona"); expect(c.draft.council?.backends?.["new-persona"]).toBeUndefined(); expect(c.result).toBeUndefined(); expect(c.screen.type).toBe("root");
	});
	it("unseated library edit keeps name immutable; Esc field cancel retains prompt and no seating", () => {
		const config = structuredClone(existing); config.council!.members = ["architect"]; const c = withActions(mockActions(), config); c.jump("Council"); action(c, "library");
		c.move(c.fields.findIndex(f => f.name === "back")); c.enter(); action(c, "edit-persona"); c.enter(); expect(c.error).toContain("immutable"); expect(c.modal).toBeUndefined();
		c.move(2); c.enter(); c.text("discard this edit"); c.escape(); expect(c.candidate?.value.systemPrompt).toBe(config.personas!.back.systemPrompt);
		c.enter(); c.submit("Accepted prompt\nSecond line"); action(c, "preview"); action(c, "accept");
		expect(c.draft.personas?.back.systemPrompt).toBe("Accepted prompt\nSecond line"); expect(c.draft.council?.members).toEqual(["architect"]); expect(c.draft.council?.backends).toEqual(config.council?.backends);
	});
	it("bundled override and reset each require explicit intent; default reset Cancel", () => {
		const c = withActions(mockActions(), {} as BpxCouncilConfig); c.jump("Council"); c.enter(); action(c, "persona"); action(c, "edit-persona"); c.move(2); c.enter(); c.submit("Override"); action(c, "preview"); action(c, "accept");
		expect(c.draft.personas?.architect.systemPrompt).toBe("Override"); action(c, "reset-persona"); c.enter(); expect(c.draft.personas?.architect.systemPrompt).toBe("Override");
		action(c, "reset-persona"); c.move(1); c.enter(); expect(c.draft.personas?.architect).toBeUndefined(); expect(c.draft.council).toBeUndefined();
	});
	it("project exposes bundled seating only and never Add/edit/generate prompt controls", () => {
		const service = mockActions(); const c = withActions(service, {} as BpxCouncilConfig, true); c.jump("Council");
		expect(c.fields.some(f => f.action === "add")).toBe(false); action(c, "library"); c.enter(); expect(c.fields.map(f => f.action)).toEqual(["seat"]);
		c.startCandidate(); expect(c.candidate).toBeUndefined(); expect(c.error).toContain("global or explicit"); expect(service.generate).not.toHaveBeenCalled();
	});
	it("generated preview keeps Accept visible at 40x12 and marks clipped single-line prompt", () => {
		const c = withActions(); c.jump("Council"); c.startCandidate({ name: "new", stance: "neutral", systemPrompt: "x".repeat(400) }, undefined, true); action(c, "preview"); c.move("last");
		for (const [columns, rows] of [[40, 12], [20, 8], [100, 28]]) {
			const screen = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows } }), { columns }));
			expect(screen).toContain("► Accept"); if (columns === 100) expect(screen).toContain("Prompt clipped:");
		}
	});
});

describe("explicit mocked route tests and AI operations", () => {
	it("new test selects new seat outcome rather than retained Advisor result", async () => {
		const c = withActions(); c.jump("Advisor"); action(c, "test"); runConfirmed(c); await flushOperations(); expect(c.testResults[c.index].target.section).toBe("advisor");
		c.jump("Debate"); c.move(1); c.enter(); action(c, "test"); runConfirmed(c); await flushOperations();
		expect(c.testResults).toHaveLength(2); expect(c.testResults[c.index].target).toEqual({ section: "debate", role: "critic" });
	});
	it("ambient change before Run blocks dispatch until user reconfirms", async () => {
		const service = mockActions(); let ambient = "claude:old"; service.preflight = vi.fn(() => ({ route: ambient }));
		const c = withActions(service, {} as BpxCouncilConfig); c.jump("Advisor"); action(c, "test"); ambient = "pi:new"; runConfirmed(c); await flushOperations();
		expect(service.test).not.toHaveBeenCalled(); expect(c.error).toContain("confirm again"); expect(c.draft).toEqual({});
	});
	it("ambient changes during response cannot relabel stale test or accept stale generated candidate", async () => {
		const service = mockActions(); let ambient = "claude:old"; service.preflight = vi.fn(() => ({ route: ambient }));
		let testDone!: (result: RouteTestResult) => void; service.test = vi.fn(() => new Promise(done => { testDone = done; }));
		const c = withActions(service, {} as BpxCouncilConfig); c.jump("Advisor"); action(c, "test"); runConfirmed(c); ambient = "pi:new"; testDone({ ok: true, route: "claude:old", elapsedMs: 3, text: "OK" }); await flushOperations(); expect(c.testResults).toEqual([]);
		let generationDone!: (result: PersonaGenerationResult) => void; service.generate = vi.fn(() => new Promise(done => { generationDone = done; }));
		c.jump("Council"); action(c, "add"); action(c, "ai"); c.generationFocus = "Evidence"; action(c, "generate"); runConfirmed(c); ambient = "claude:changed";
		generationDone({ ok: true, route: "pi:new", elapsedMs: 4, text: "", candidate: { name: "stale", stance: "neutral", systemPrompt: "Not accepted" } }); await flushOperations();
		expect(c.candidate).toBeUndefined(); expect(c.error).toContain("stale candidate ignored"); expect(c.draft).toEqual({});
	});
	it("preflight-resolved ambient/auto route changes invalidate prior status", async () => {
		const service = mockActions(); let resolved = "claude:first";
		service.preflight = vi.fn(() => ({ route: resolved })); const c = withActions(service, {} as BpxCouncilConfig);
		c.jump("Advisor"); action(c, "test"); runConfirmed(c); await flushOperations(); expect(c.testResults).toHaveLength(1);
		resolved = "pi:new-ambient"; c.jump("Preferences"); expect(c.testResults).toEqual([]);
	});
	it("name entry does not filter stance choices; against remains selectable", () => {
		const c = withActions(); c.jump("Council"); c.startCandidate(); c.enter(); c.submit("security"); c.move(1); c.enter();
		expect(c.modal?.text).toBe(""); expect(modalChoices(c.modal!).map(choice => choice.value)).toEqual(["for", "against", "neutral"]);
		c.move("first"); c.move(1); c.enter(); expect(c.candidate?.value.stance).toBe("against"); expect(c.dirty).toBe(false);
	});
	it("cost defaults Cancel, arrows trapped, no automatic calls during route discovery/selection", async () => {
		const service = mockActions(); const c = withActions(service); c.jump("Advisor"); edit(c, "model"); await flushOperations(); choose(c, null);
		expect(service.test).not.toHaveBeenCalled(); expect(service.generate).not.toHaveBeenCalled();
		action(c, "test"); expect(c.confirmation?.routes).toEqual(["codex"]); const bytes = JSON.stringify(c.draft);
		key(c, {}, "3"); expect(c.section).toBe("Advisor"); c.enter(); expect(c.confirmation).toBeUndefined(); expect(service.test).not.toHaveBeenCalled(); expect(JSON.stringify(c.draft)).toBe(bytes);
		action(c, "test"); key(c, { rightArrow: true }); expect(service.test).not.toHaveBeenCalled(); c.escape();
	});
	it("tests exact unsaved draft including literal @, old args and legacy fields; no Save", async () => {
		const service = mockActions(); const c = withActions(service); c.jump("Council"); edit(c, "model", "tokens"); c.text("vendor/model@rev"); c.choose(); c.submit(c.modal!.text);
		const snapshot = structuredClone(c.draft); action(c, "test"); runConfirmed(c); await flushOperations();
		expect(service.test).toHaveBeenCalledWith(snapshot, { section: "council", role: "tokens", member: true }, expect.any(AbortSignal));
		expect(vi.mocked(service.test).mock.calls[0][0]).not.toBe(c.draft); expect(c.draft).toEqual(snapshot); expect(c.draft.solo).toEqual(existing.solo); expect(c.result).toBeUndefined(); expect(c.testResults[0].result.text).toBe("OK");
		c.escape(); expect(c.screen.type).toBe("route"); expect(c.fields[c.index].action).toBe("test");
	});
	it("preflight blocks single test with reasons and no cost/call; Test all skips blocked seats", async () => {
		const service = mockActions(); service.preflight = vi.fn((_draft, target) => ({ route: target.role, ...(target.role === "back" ? { error: "Custom args blocked; remove args." } : {}) }));
		const c = withActions(service); c.jump("Council"); c.enter(); action(c, "test"); expect(c.confirmation).toBeUndefined(); expect(c.error).toContain("No eligible"); expect(c.testResults[0].result.error).toContain("Custom args"); expect(service.test).not.toHaveBeenCalled();
		c.escape(); c.escape(); action(c, "test-all"); expect(c.confirmation?.routes).toEqual(["tokens", "reviewer"]); runConfirmed(c); await flushOperations();
		expect(service.test).toHaveBeenCalledTimes(2); expect(vi.mocked(service.test).mock.calls.map(call => call[1].role)).toEqual(["tokens", "reviewer"]); expect(c.testResults.map(item => item.result.ok)).toEqual([false, true, true]);
	});
	it("all blocked seats show failure statuses with no confirmation", () => {
		const service = mockActions(); service.preflight = vi.fn((_draft, target) => ({ route: target.role, error: "Unsupported transport; select guarded route." }));
		const c = withActions(service); c.jump("Council"); action(c, "test-all"); expect(c.screen.type).toBe("results"); expect(c.testResults).toHaveLength(3); expect(c.confirmation).toBeUndefined(); expect(service.test).not.toHaveBeenCalled();
	});
	it("sequential Test all preserves completed results, stops before next seat and awaits cancelled cleanup", async () => {
		const service = mockActions(); let resolve!: (result: RouteTestResult) => void; let signal!: AbortSignal;
		service.test = vi.fn(async (_draft, target, next) => { if (target.role === "back") return { ok: true, route: "claude", elapsedMs: 11, text: "OK" }; signal = next; return new Promise(done => { resolve = done; }); });
		const c = withActions(service); c.jump("Council"); action(c, "test-all"); runConfirmed(c); await flushOperations(); expect(c.testResults.filter(item => !item.pending)).toHaveLength(1); expect(service.test).toHaveBeenCalledTimes(2);
		const bytes = JSON.stringify(c.draft); c.escape(); expect(signal.aborted).toBe(true); expect(c.operation?.cancelling).toBe(true); c.jump("Preferences"); c.enter(); expect(c.section).toBe("Council"); expect(JSON.stringify(c.draft)).toBe(bytes);
		let settled = false; const drain = c.settle().then(() => { settled = true; }); await flushOperations(); expect(settled).toBe(false);
		resolve({ ok: false, route: "pi", elapsedMs: 20, text: "", cancelled: true }); await drain;
		expect(service.test).toHaveBeenCalledTimes(2); expect(c.testResults[0].result.ok).toBe(true); expect(c.testResults[1].result.cancelled).toBe(true); expect(c.operation).toBeUndefined(); expect(c.error).toContain("cancelled"); c.escape(); expect(c.fields[c.index].action).toBe("test-all");
	});
	it("Ctrl-C during operation waits for actual mock cleanup before result 130", async () => {
		const service = mockActions(); let resolve!: (result: RouteTestResult) => void;
		service.test = vi.fn(() => new Promise(done => { resolve = done; })); const c = withActions(service); c.jump("Advisor"); action(c, "test"); runConfirmed(c);
		key(c, { ctrl: true }, "c"); expect(c.result).toBeUndefined(); expect(c.operation?.abort.signal.aborted).toBe(true);
		resolve({ ok: false, route: "claude", elapsedMs: 10, text: "", cancelled: true }); await flushOperations(); expect(c.result).toEqual({ config: null, code: 130 }); expect(c.operation).toBeUndefined();
	});
	it("failure stays actionable, rejected provider details withheld, later seats still run", async () => {
		const service = mockActions(); service.test = vi.fn(async (_draft, target) => { if (target.role === "tokens") throw new Error("secret api-key-leaked"); return { ok: target.role !== "back", route: target.role, elapsedMs: 5, text: "", error: target.role === "back" ? "Login required; authenticate then retry." : undefined }; });
		const c = withActions(service); c.jump("Council"); action(c, "test-all"); runConfirmed(c); await flushOperations();
		expect(c.testResults).toHaveLength(3); expect(c.testResults[0].result.error).toContain("Login required"); expect(c.testResults[1].result.error).toContain("Check settings"); expect(JSON.stringify(c.testResults)).not.toContain("api-key-leaked"); expect(c.testResults[2].result.ok).toBe(true);
	});
	it("route fingerprints invalidate inheritors and legacy fallback but not unrelated fields/pinned route", async () => {
		const config = structuredClone(existing); config.solo!.backend = { type: "cli", command: "claude" }; config.council!.backends!.back = null; const c = withActions(mockActions(), config);
		c.jump("Council"); action(c, "test-all"); runConfirmed(c); await flushOperations(); expect(c.testResults).toHaveLength(3);
		c.jump("Preferences"); edit(c, "mode"); choose(c, "debate"); expect(c.testResults).toHaveLength(3);
		c.jump("Advisor"); edit(c, "effort"); choose(c, null); expect(c.testResults.map(r => r.target.role)).toEqual(["tokens", "reviewer"]);
	});
	it("ignores stale test response if route changed externally while pending", async () => {
		const service = mockActions(); let resolve!: (result: RouteTestResult) => void; service.test = vi.fn(() => new Promise(done => { resolve = done; }));
		const c = withActions(service); c.jump("Advisor"); action(c, "test"); runConfirmed(c); c.draft.solo.backend!.model = "changed";
		resolve({ ok: true, route: "old", elapsedMs: 3, text: "OK" }); await flushOperations(); expect(c.testResults).toEqual([]);
	});
	it("AI creation requires focus, selectable draft generator route, cost Cancel and candidate Accept", async () => {
		const service = mockActions(); const c = withActions(service); c.jump("Council"); action(c, "add"); action(c, "ai"); action(c, "generate"); expect(c.error).toContain("Describe"); expect(service.generate).not.toHaveBeenCalled();
		c.move("first"); c.enter(); c.submit("Review evidence\nnot forced opposition"); action(c, "generator"); c.move(2); c.enter(); expect(c.generatorTarget).toEqual({ section: "council", role: "tokens", member: true });
		const snapshot = structuredClone(c.draft); action(c, "generate"); c.enter(); expect(service.generate).not.toHaveBeenCalled(); action(c, "generate"); runConfirmed(c); await flushOperations();
		expect(service.generate).toHaveBeenCalledWith(snapshot, { section: "council", role: "tokens", member: true }, "Review evidence\nnot forced opposition", expect.any(AbortSignal)); expect(c.screen.type).toBe("preview"); expect(c.draft).toEqual(snapshot);
		action(c, "candidate-edit"); c.move(2); c.enter(); c.text("cancelled prompt edit"); c.escape(); c.escape(); expect(c.candidate?.value.systemPrompt).toBe("Check evidence.\nAllow either verdict.");
		action(c, "accept"); expect(c.draft.personas?.evidence).toBeDefined(); expect(c.draft.council?.backends?.evidence).toBeUndefined(); expect(c.generatorTarget.role).toBe("tokens"); expect(c.result).toBeUndefined();
	});
	it("cancelled Regenerate preserves prior candidate; error never changes stored draft", async () => {
		const service = mockActions(); const c = withActions(service); c.jump("Council"); c.generationFocus = "Evidence"; c.startCandidate({ name: "old", stance: "neutral", systemPrompt: "Old candidate" }, undefined, true); action(c, "preview");
		let resolve!: (result: PersonaGenerationResult) => void; service.generate = vi.fn(() => new Promise(done => { resolve = done; })); const before = structuredClone(c.candidate); const bytes = JSON.stringify(c.draft);
		action(c, "generate"); runConfirmed(c); c.escape(); resolve({ ok: true, route: "claude", elapsedMs: 2, text: "", candidate: { name: "late", stance: "for", systemPrompt: "Ignore late" } }); await flushOperations(); expect(c.candidate).toEqual(before); expect(JSON.stringify(c.draft)).toBe(bytes);
		service.generate = vi.fn(async () => ({ ok: false, route: "claude", elapsedMs: 1, text: "", error: "Login required. Authenticate and retry." })); action(c, "generate"); runConfirmed(c); await flushOperations(); expect(c.error).toContain("Login required"); expect(c.candidate).toEqual(before); expect(JSON.stringify(c.draft)).toBe(bytes);
	});
	it("captured multiline Ctrl-S apply cannot redispatch or change focus", () => {
		const c = withActions(); c.jump("Council"); c.startCandidate(); c.move(2); c.enter(); const editing = c.modal; c.submit("one\ntwo");
		workbenchKey(c, "s", { ctrl: true } as Key, { columns: 40, rows: 12 }, editing); expect(c.modal).toBeUndefined(); expect(c.screen.type).toBe("candidate"); expect(c.index).toBe(2); expect(c.candidate?.value.systemPrompt).toBe("one\ntwo"); expect(c.dirty).toBe(false);
	});
});
