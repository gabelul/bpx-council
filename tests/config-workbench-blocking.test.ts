import "./interactive-env.js";
import React from "react";
import { PassThrough } from "node:stream";
import { render, renderToString, type Key } from "ink";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BackendDiagnostic, BackendDiagnostics } from "../src/backend-diagnostics.js";
import type { ConfigActions, RouteTestResult } from "../src/config-actions.js";
import type { BpxCouncilConfig } from "../src/config.js";
import { ConfigDraft, modalChoices } from "../src/config-draft.js";
import { WorkbenchView, workbenchKey } from "../src/config-workbench.js";

const saved: BpxCouncilConfig = { solo: { backend: { type: "cli", command: "claude", model: "saved" } }, contextWindow: 5555 };
const rows: BackendDiagnostic[] = [
	{ name: "codex", label: "Codex", kind: "cli", status: "installed", path: "/fake/codex", check: "not-checked" },
	{ name: "claude", label: "Claude", kind: "cli", status: "installed", path: "/fake/claude", check: "not-checked" },
	{ name: "amp", label: "Amp", kind: "cli", status: "unusable", path: "/fake/amp", check: "not-checked" },
	{ name: "/private/manual", label: "Manual", kind: "cli", status: "installed", path: "/private/manual", check: "not-checked" },
	{ name: "pi", label: "Pi", kind: "cli", status: "missing", check: "not-checked" },
	{ name: "anthropic", label: "Anthropic", kind: "http", status: "key-missing", check: "not-applicable" },
];

/** Build inert controller; every subprocess/catalog/provider seam is fake. @param config Saved draft. @returns Controller and fake services. */
function fixture(config = saved) {
	const local: BackendDiagnostics = { inventory: vi.fn(() => structuredClone(rows)), check: vi.fn(async () => structuredClone(rows)) };
	const paid: ConfigActions = {
		preflight: vi.fn((draft, target, purpose = "test") => {
			const route = draft.solo?.backend;
			return { route: `${route?.command}:${route?.model ?? "default"}@${route?.effort ?? "default"}`, ...(purpose === "generate" && route?.command === "codex" ? { error: "Codex generation is not supported." } : route?.command === "codex" ? { warning: "Codex basic read-only mode; tools may remain available." } : {}) };
		}),
		test: vi.fn(async () => ({ ok: true, route: "claude:saved", elapsedMs: 7, text: "Route responded." })),
		generate: vi.fn(async () => ({ ok: false, route: "unused", elapsedMs: 0, text: "" })),
	};
	const c = new ConfigDraft(config, { path: "/fake/config.json", scope: "explicit" }, [], { listModels: async () => ["saved", "new-model"], listEfforts: async () => ({ levels: ["low", "high"] }) }, paid, local);
	return { c, local, paid };
}
/** Start explicit row intent. @param c Controller. @param intent Action name. */
function action(c: ConfigDraft, intent: string): void { c.pane = "detail"; c.move("first"); c.move(c.fields.findIndex(field => field.action === intent)); c.enter(); }
/** Render terminal frame without host terminal or calls. @param c Controller. @param columns Cell width. @param lines Terminal height. @returns Plain frame. */
function frame(c: ConfigDraft, columns = 40, lines = 12): string { return stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows: lines } }), { columns })); }
/** Drain mocked promise completion. @returns Microtask completion. */
async function flush(): Promise<void> { for (let i = 0; i < 12; i++) await Promise.resolve(); }
/** Confirm paid Run after safe-default Cancel. @param c Controller. */
function run(c: ConfigDraft): void { expect(c.confirmation?.index).toBe(0); c.tab(); c.enter(); }

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("blocking backend-check overlay", () => {
	it("does not claim successful cleanup when cancellation returns an unconfirmed receipt", async () => {
		const { c, local } = fixture(); let done!: (value: BackendDiagnostic[]) => void;
		local.check = vi.fn(() => new Promise(resolve => { done = resolve; }));
		c.jump("Backends"); action(c, "check-backends"); c.escape();
		done(rows.map(row => row.name === "claude" ? { ...row, check: "failed", detail: "Private version-check directory cleanup could not be confirmed" } : row));
		await flush(); expect(c.operation).toBeUndefined(); expect(c.error).toContain("cleanup could not be confirmed");
		expect(c.error).not.toContain("cleanup complete"); expect(c.dirty).toBe(false);
	});
	it("locks every navigation/edit key and direct mutation path, preserves exact focus/draft, no duplicate Enter", async () => {
		const { c, local, paid } = fixture(); let done!: (value: BackendDiagnostic[]) => void;
		local.check = vi.fn(() => new Promise(resolve => { done = resolve; }));
		c.jump("Backends"); action(c, "check-backends");
		const before = { draft: JSON.stringify(c.draft), section: c.section, pane: c.pane, screen: structuredClone(c.screen), index: c.index };
		const keys: [string, Partial<Key>][] = [
			["", { upArrow: true }], ["", { downArrow: true }], ["", { leftArrow: true }], ["", { rightArrow: true }],
			["", { tab: true }], ["", { tab: true, shift: true }], ["", { return: true }], ["", { home: true }], ["", { end: true }],
			["", { pageUp: true }], ["", { pageDown: true }], ["s", { ctrl: true }], ["x", {}], ...Array.from({ length: 8 }, (_, i) => [String(i + 1), {}] as [string, Partial<Key>]),
		];
		for (const [input, key] of keys) workbenchKey(c, input, key as Key, { columns: 40, rows: 12 });
		c.jump("Advisor"); c.selectSection("Council"); c.horizontal("right"); c.move(99); c.tab(); c.enter(); c.edit(c.fields[0]); c.choose(); c.text("changed"); c.submit("changed"); c.startCandidate(); c.review();
		expect({ draft: JSON.stringify(c.draft), section: c.section, pane: c.pane, screen: c.screen, index: c.index }).toEqual(before);
		expect(local.check).toHaveBeenCalledTimes(1); expect(paid.test).not.toHaveBeenCalled(); expect(c.modal).toBeUndefined(); expect(c.confirmation).toBeUndefined(); expect(c.dirty).toBe(false);
		done(rows); await flush(); expect(c.operation).toBeUndefined(); expect(c.draft).toEqual(saved); expect(c.index).toBe(before.index);
	});
	it.each([[40, 12], [20, 8]])("shows current CLI/count/log without raw output or background marks at %ix%i", async (columns, lines) => {
		vi.stubEnv("NO_COLOR", "1"); vi.stubEnv("FORCE_COLOR", "3");
		const { c, local } = fixture(); let update!: (value: BackendDiagnostic[]) => void; let done!: (value: BackendDiagnostic[]) => void;
		local.check = vi.fn((_signal, next) => { update = next!; return new Promise(resolve => { done = resolve; }); });
		c.jump("Backends"); action(c, "check-backends");
		update(rows.map(row => row.name === "codex" ? { ...row, check: "checking", detail: "RAW OUTPUT secret", version: "RAW VERSION secret" } : row));
		let rendered = frame(c, columns, lines);
		expect(rendered).toContain("Local backend check"); expect(rendered).toContain("Checked 0/4 steps"); expect(rendered).toContain("CLI: codex"); expect(rendered).toContain("codex: Checking");
		expect(rendered).not.toContain("RAW"); expect(rendered).not.toContain("secret"); expect(rendered).not.toContain("►"); expect(rendered).not.toContain("CONFIG WORKBENCH"); expect(rendered).not.toContain("/private");
		update(rows.map(row => row.name === "codex" ? { ...row, check: "version-found", version: "1.2.3" } : row.name === "claude" ? { ...row, check: "checking" } : row));
		rendered = frame(c, columns, lines); expect(rendered).toContain("Checked 1/4 steps"); expect(rendered).toContain("CLI: claude"); expect(rendered).toContain("claude: Checking");
		expect(rendered.split("\n").length).toBeLessThanOrEqual(lines); for (const line of rendered.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns);
		c.escape(); rendered = frame(c, columns, lines); expect(rendered).toContain("Awaiting cleanup"); expect(rendered).toContain("Cancelling"); expect(c.operation).toBeDefined(); expect(c.dirty).toBe(false);
		done(rows); await flush(); expect(frame(c, columns, lines)).not.toContain("Local backend check");
	});
	it("animates while service waits without controller changes", async () => {
		vi.useFakeTimers(); const { c, local } = fixture(); let done!: (value: BackendDiagnostic[]) => void;
		local.check = vi.fn(() => new Promise(resolve => { done = resolve; })); c.jump("Backends"); action(c, "check-backends");
		const listener = vi.fn(); const unsubscribe = c.subscribe(listener);
		const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 12, isTTY: true }); const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn() });
		let output = ""; stdout.on("data", chunk => { output += chunk.toString(); });
		const app = render(React.createElement(WorkbenchView, { controller: c, size: { columns: 40, rows: 12 } }), { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
		try {
			await vi.advanceTimersByTimeAsync(50); const initial = output;
			// Slow CI runners need several fake-time windows before ink paints the first frame.
			for (let index = 0; index < 20 && output.length <= initial.length; index += 1) await vi.advanceTimersByTimeAsync(100);
			expect(output.length).toBeGreaterThan(initial.length); expect(output).toContain("Checked 0/4 steps"); expect(listener).not.toHaveBeenCalled(); expect(c.draft).toEqual(saved);
		} finally { app.unmount(); unsubscribe(); done(rows); await flush(); }
	});
});

describe("route-aware ordinary choices", () => {
	it("excludes hard local failure, keeps version warning and key-missing configure-later, saved exact failure survives", () => {
		const { c } = fixture(); c.backendDiagnostics = rows.map(row => row.name === "claude" ? { ...row, check: "failed" } : row.name === "codex" ? { ...row, check: "version-unavailable" } : row);
		c.jump("Advisor"); c.enter();
		expect(c.modal!.choices.some(choice => choice.value === "claude")).toBe(false);
		expect(c.modal!.choices.find(choice => choice.value === undefined)?.label).toContain("current; keep exact; check failed");
		expect(c.modal!.choices.find(choice => choice.value === "codex")?.label).toContain("version unavailable (warning)");
		expect(c.modal!.choices.find(choice => choice.value === "anthropic")?.label).toContain("Key missing; configure later");
		c.enter(); expect(c.draft).toEqual(saved); expect(c.dirty).toBe(false);
	});
	it("filters failed exact model only, keeps current and different model selectable", async () => {
		const { c, paid } = fixture(); paid.test = vi.fn(async () => ({ ok: false, route: "claude:saved", elapsedMs: 5, text: "", error: "Provider failed." }));
		c.jump("Advisor"); action(c, "test"); run(c); await flush(); c.jump("Advisor"); c.move("first"); c.enter();
		expect(c.modal!.choices.find(choice => choice.value === undefined)?.label).toContain("Test failed"); expect(c.modal!.choices.some(choice => choice.value === "claude")).toBe(false);
		c.escape(); c.edit(c.fields.find(field => field.kind === "model")); await flush();
		expect(c.modal!.choices.find(choice => choice.value === undefined)?.label).toContain("Test failed"); expect(c.modal!.choices.some(choice => choice.value === "saved")).toBe(false); expect(c.modal!.choices.some(choice => choice.value === "new-model")).toBe(true);
		c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.value === "new-model"); c.choose(); expect(c.draft.solo!.backend!.model).toBe("new-model");
		c.edit(c.fields.find(field => field.kind === "backend")); expect(c.modal!.choices.some(choice => choice.value === "claude")).toBe(true);
	});
	it.each(["cancelled", "unsupported", "not-called"])("%s does not poison backend/model choices", async outcome => {
		const { c, paid } = fixture();
		if (outcome === "unsupported") paid.preflight = vi.fn(() => ({ route: "claude:saved", error: "Transport not supported." }));
		else paid.test = vi.fn(async () => ({ ok: false, route: "claude:saved", elapsedMs: 0, text: "", ...(outcome === "cancelled" ? { cancelled: true } : { error: "Not called; route changed." }) }));
		c.jump("Advisor"); action(c, "test"); if (c.confirmation) run(c); await flush(); c.jump("Advisor"); c.edit(c.fields.find(field => field.kind === "backend"));
		expect(c.modal!.choices.some(choice => choice.value === "claude")).toBe(true); expect(c.modal!.choices.find(choice => choice.value === undefined)?.label).not.toContain("Test failed");
	});
});

describe("purpose-aware cost and paid busy overlay", () => {
	it.each([[40, 12], [20, 8]])("shows Codex warning, pins and Cancel default at %ix%i; generation stays blocked", async (columns, lines) => {
		const { c, paid } = fixture({ solo: { backend: { type: "cli", command: "codex", model: "gpt-pin", effort: "low" } } });
		c.jump("Advisor"); action(c, "test");
		expect(c.confirmation!.warnings).toEqual(["Codex basic read-only mode; tools may remain available."]); expect(c.confirmation!.routes).toEqual(["codex:gpt-pin@low"]); expect(c.confirmation!.index).toBe(0);
		const rendered = frame(c, columns, lines); expect(rendered).toContain(columns === 20 ? "Quota/cost: 1 call" : "Quota/cost: 1 call(s)"); expect(rendered).toContain("codex:gpt-pin@low"); expect(rendered).toContain("Codex read-only;"); expect(rendered).toContain("tools may remain."); expect(rendered).toContain("► Cancel");
		c.enter(); expect(paid.test).not.toHaveBeenCalled(); c.jump("Council"); action(c, "add"); action(c, "ai"); c.generationFocus = "Review boundaries"; action(c, "generate");
		expect(paid.preflight).toHaveBeenCalledWith(expect.anything(), c.generatorTarget, "generate"); expect(c.confirmation).toBeUndefined(); expect(c.error).toContain("Codex generation"); expect(paid.generate).not.toHaveBeenCalled();
	});
	it("deduplicates warning in batch confirmation and freezes eligibility through ambient changes", async () => {
		const { c, paid } = fixture({ solo: { backend: { type: "cli", command: "codex", model: "pinned" } }, council: { members: ["architect", "critic"] } });
		c.jump("Council"); action(c, "test-all"); const frozen = structuredClone(c.confirmation);
		expect(c.confirmation!.warnings).toHaveLength(1); paid.preflight = vi.fn(() => ({ route: "ambient:changed", error: "Ambient route changed." }));
		expect(c.confirmation).toEqual(frozen); run(c); await flush(); expect(paid.test).not.toHaveBeenCalled(); expect(c.error).toContain("Route changed since confirmation");
	});
	it("paid progress hides responses and preserves cancellation overlay until cleanup", async () => {
		const { c, paid } = fixture(); let done!: (value: RouteTestResult) => void;
		paid.test = vi.fn(() => new Promise(resolve => { done = resolve; })); c.jump("Advisor"); action(c, "test"); run(c);
		c.testResults[0].result.text = "SENSITIVE MODEL RESPONSE"; c.error = "SENSITIVE ERROR BODY";
		for (const [columns, lines] of [[40, 12], [20, 8]]) { const rendered = frame(c, columns, lines); expect(rendered).toContain("Testing connection"); expect(rendered).toContain("Done 0/1 calls"); expect(rendered).not.toContain("SENSITIVE"); }
		c.escape(); expect(frame(c)).toContain("Awaiting cleanup"); expect(c.operation).toBeDefined(); c.enter(); expect(paid.test).toHaveBeenCalledTimes(1);
		done({ ok: false, route: "claude:saved", elapsedMs: 8, text: "PRIVATE" }); await flush(); expect(c.operation).toBeUndefined(); expect(c.testResults[0].result.cancelled).toBe(true); expect(c.testResults[0].result.text).toBe(""); expect(c.draft).toEqual(saved);
	});
});
