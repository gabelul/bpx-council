import React from "react";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { renderToString, type Key } from "ink";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import type { BackendDiagnostic, BackendDiagnostics } from "../src/backend-diagnostics.js";
import type { BpxCouncilConfig } from "../src/config.js";
import type { ConfigActions, RouteTestResult } from "../src/config-actions.js";
import { ConfigDraft, SECTIONS, modalChoices, type DraftDiscovery } from "../src/config-draft.js";
import { WorkbenchView, workbenchKey } from "../src/config-workbench.js";

const presence: BackendDiagnostic[] = [
	{ name: "codex", label: "Codex", kind: "cli", status: "installed", path: "/mock/codex", check: "not-checked" },
	{ name: "claude", label: "Claude", kind: "cli", status: "installed", path: "/mock/claude", check: "not-checked" },
	{ name: "pi", label: "Pi", kind: "cli", status: "missing", check: "not-checked" },
	{ name: "amp", label: "Amp", kind: "cli", status: "unusable", path: "/mock/amp", check: "unsupported", detail: "No supported preset" },
	{ name: "anthropic", label: "Anthropic API", kind: "http", status: "key-missing", check: "not-applicable", detail: "ANTHROPIC_API_KEY not set" },
];
const config: BpxCouncilConfig = {
	solo: { backend: { type: "cli", command: "claude", model: "saved-model", timeoutMs: 5555 }, thinkingLevel: "low" },
	council: { members: ["architect"], backends: { architect: "manual-cli:model@high" } },
	personas: { reader: { stance: "neutral", systemPrompt: "Keep this exact." } },
};

/** Fixed inventory plus mock check; no host PATH, auth or subprocess work. @param rows Diagnostic fixture. @returns Injected service. */
function diagnostics(rows = presence): BackendDiagnostics {
	return { inventory: vi.fn(() => structuredClone(rows)), check: vi.fn(async (_signal, update) => { const checked = structuredClone(rows); update?.(checked); return checked; }) };
}
/** Paid actions are fake and inspect exact draft route. @returns Injected action service. */
function actions(): ConfigActions {
	return {
		preflight: vi.fn(draft => ({ route: `${draft.solo?.backend?.command ?? "ambient"}:${draft.solo?.backend?.model ?? "default"}` })),
		test: vi.fn(async draft => ({ ok: true, route: `${draft.solo?.backend?.command}:${draft.solo?.backend?.model}`, elapsedMs: 37, text: "Route responded." })),
		generate: vi.fn(async () => ({ ok: false, route: "unused", elapsedMs: 0, text: "" })),
	};
}
/** Build test controller with every external operation injected. @param local Local service. @param paid Paid service. @param saved Exact initial config. @param catalogs Catalog fixture. @returns Controller. */
function controller(local = diagnostics(), paid = actions(), saved = config, catalogs: DraftDiscovery = { listModels: vi.fn(async () => ["catalog-model"]), listEfforts: vi.fn(async () => null) }): ConfigDraft {
	return new ConfigDraft(saved, { path: "/tmp/fake-config.json", scope: "explicit" }, [], catalogs, paid, local);
}
/** Choose explicit row intent. @param c Controller. @param intent Action identity. */
function action(c: ConfigDraft, intent: string): void {
	const index = c.fields.findIndex(field => field.action === intent); expect(index).toBeGreaterThanOrEqual(0);
	c.pane = "detail"; c.move("first"); c.move(index); c.enter();
}
/** Open local detail using keyboard Right, never checks or calls. @param c Controller. @param name Backend identity. */
function detail(c: ConfigDraft, name: string): void {
	c.jump("Backends");
	if (c.backendDiagnostics.find(row => row.name === name)?.kind === "cli") action(c, "installed-clis");
	c.move("first"); c.move(c.fields.findIndex(field => field.name === name)); c.horizontal("right");
}
/** Flush async mock completion without timers or live process work. @returns Microtask drain. */
async function flush(): Promise<void> { for (let i = 0; i < 10; i++) await Promise.resolve(); }
/** Render bounded frame in memory. @param c Controller. @param columns Width. @param rows Height. @returns Plain frame. */
function screen(c: ConfigDraft, columns = 100, rows = 28): string { return stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows } }), { columns })); }

describe("explicit local Backends diagnostics", () => {
	it("adds eight root sections and all shortcuts; Right never runs checks/paid actions", () => {
		expect(SECTIONS).toEqual(["Advisor", "Gut-check", "Council", "Debate", "Backends", "Preferences", "Review", "Discard"]);
		const local = diagnostics(); const paid = actions(); const c = controller(local, paid);
		for (let i = 1; i <= 8; i++) { workbenchKey(c, String(i), {} as Key, { columns: 100, rows: 28 }); expect(c.section).toBe(SECTIONS[i - 1]); }
		c.jump("Backends"); c.move(1); c.horizontal("right"); expect(c.operation).toBeUndefined();
		detail(c, "pi"); expect(c.screen).toEqual({ type: "backend-detail", name: "pi" });
		c.horizontal("right"); expect(local.check).not.toHaveBeenCalled(); expect(paid.test).not.toHaveBeenCalled(); expect(paid.generate).not.toHaveBeenCalled();
		expect(screen(c)).toContain("Missing"); expect(screen(c)).toContain("Version: not checked");
	});
	it("startup inventories saved manual CLI names but no checks, catalogs or mutations", () => {
		const local = diagnostics(); const paid = actions(); const catalogs = { listModels: vi.fn(async () => []), listEfforts: vi.fn(async () => null) };
		const original = JSON.stringify(config); const c = controller(local, paid, config, catalogs);
		expect(local.inventory).toHaveBeenCalledWith(["claude", "manual-cli"]); expect(local.check).not.toHaveBeenCalled();
		expect(catalogs.listModels).not.toHaveBeenCalled(); expect(catalogs.listEfforts).not.toHaveBeenCalled(); expect(paid.test).not.toHaveBeenCalled();
		expect(JSON.stringify(config)).toBe(original); expect(JSON.stringify(c.draft)).toBe(original); expect(c.dirty).toBe(false);
	});
	it("known missing/unusable CLIs and Anthropic key state stay visible, including narrow details", () => {
		const c = controller(); c.jump("Backends"); const wide = screen(c);
		for (const text of ["Direct providers", "Installed CLIs", "anthropic: Key missing", "legacy HTTP"]) expect(wide).toContain(text);
		action(c, "installed-clis"); const installed = screen(c);
		for (const text of ["codex: Installed", "pi: Missing", "amp: Unusable"]) expect(installed).toContain(text);
		expect(installed).not.toContain("anthropic: Key missing");
		for (const name of ["pi", "amp", "anthropic"]) {
			detail(c, name); const narrow = screen(c, 40, 12);
			expect(narrow).toContain(name === "pi" ? "Missing" : name === "amp" ? "Unusable" : "Key missing");
			expect(narrow).toContain("Version:"); expect(narrow).toContain("Check installed CLIs"); expect(narrow).toContain("Configure Advisor");
			expect(narrow.split("\n").length).toBeLessThanOrEqual(12); for (const line of narrow.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(40);
			c.escape(); expect(c.screen.type).toBe(name === "anthropic" ? "root" : "installed-clis");
		}
		const keyPresent = controller(diagnostics(presence.map(row => row.kind === "http" ? { ...row, status: "key-present" } : row)));
		keyPresent.jump("Backends"); expect(screen(keyPresent)).toContain("anthropic: Key present");
	});
	it.each(["not-checked", "version-found", "failed", "unsupported", "cancelled", "not-applicable"] as const)("renders version receipt %s without implying response/login", check => {
		const c = controller(diagnostics([{ ...presence[1], check, ...(check === "version-found" ? { version: "2.3.4" } : {}), detail: `Local ${check}` }]));
		detail(c, "claude"); const frame = screen(c);
		expect(frame).toContain("Installed"); expect(frame).toContain(`Version: ${c.backendVersion(c.backendDiagnostics[0])}`);
		expect(frame).not.toContain("Response received"); expect(frame).not.toContain("Test failed · Requested"); expect(c.testResults).toEqual([]);
	});
	it("explicit Enter checks local versions, refreshes picker, keeps saved/draft/discovery pins unchanged", async () => {
		const local = diagnostics(); local.check = vi.fn(async (_signal, update, names) => {
			expect(names).toEqual(["claude", "manual-cli"]);
			const rows = presence.map(row => row.name === "pi" ? { ...row, status: "installed" as const, path: "/new/pi", check: "version-found" as const, version: "1.2.3" } : row);
			update?.(rows); return rows;
		});
		const paid = actions(); const c = controller(local, paid); const original = JSON.stringify(c.draft);
		c.jump("Advisor"); c.move(1); c.enter(); await flush(); expect(c.modal!.choices.map(choice => choice.value)).toContain("catalog-model"); c.escape();
		c.jump("Backends"); action(c, "check-backends"); await flush(); expect(local.check).toHaveBeenCalledTimes(1);
		expect(paid.test).not.toHaveBeenCalled(); expect(paid.generate).not.toHaveBeenCalled(); expect(c.result).toBeUndefined(); expect(c.confirmation).toBeUndefined();
		expect(JSON.stringify(c.draft)).toBe(original); expect(JSON.stringify(config)).toBe(original); expect(c.dirty).toBe(false);
		c.jump("Advisor"); c.move("first"); c.enter(); expect(c.modal!.choices.find(choice => choice.value === "pi")?.label).toContain("1.2.3");
		c.escape(); c.move(1); c.enter(); await flush(); expect(c.modal!.choices.find(choice => choice.value === undefined)?.label).toContain("saved-model");
	});
	it.each([false, true])("Escape/Ctrl-C abort local check and await actual service cleanup (exit=%s)", async exit => {
		const local = diagnostics(); let resolve!: (rows: BackendDiagnostic[]) => void; let signal!: AbortSignal;
		local.check = vi.fn(next => { signal = next; return new Promise(done => { resolve = done; }); });
		const paid = actions(); const c = controller(local, paid); c.jump("Backends"); action(c, "check-backends");
		workbenchKey(c, exit ? "c" : "", { ...(exit ? { ctrl: true } : { escape: true }) } as Key, { columns: 40, rows: 12 });
		expect(signal.aborted).toBe(true); expect(c.operation?.type).toBe("local-check"); expect(c.operation?.cancelling).toBe(true); expect(c.result).toBeUndefined();
		c.jump("Advisor"); c.enter(); expect(c.section).toBe("Backends");
		let settled = false; const drain = c.settle().then(() => { settled = true; }); await flush(); expect(settled).toBe(false);
		resolve(presence.map(row => row.kind === "cli" ? { ...row, check: "cancelled" } : row)); await drain;
		expect(c.operation).toBeUndefined(); expect(c.result).toEqual(exit ? { config: null, code: 130 } : undefined); expect(paid.test).not.toHaveBeenCalled();
		expect(c.dirty).toBe(false); if (!exit) { expect(c.error).toContain("cleanup complete"); c.escape(); expect(c.pane).toBe("sidebar"); }
	});
	it("startup and explicit local checks preserve target-file bytes, including whitespace", async () => {
		const directory = mkdtempSync(join(tmpdir(), "bpx-ui-diagnostics-"));
		const path = join(directory, "config.json"); const bytes = `  ${JSON.stringify(config, null, 3)}\n\n`;
		try {
			writeFileSync(path, bytes, "utf8");
			const c = new ConfigDraft(JSON.parse(bytes), { path, scope: "explicit" }, [], { listModels: async () => [], listEfforts: async () => null }, actions(), diagnostics());
			c.jump("Backends"); action(c, "check-backends"); await flush(); await c.settle();
			expect(readFileSync(path, "utf8")).toBe(bytes); expect(c.draft).toEqual(config); expect(c.dirty).toBe(false);
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
	it("cancelled local check ignores late update snapshots until final cleanup receipt", async () => {
		const local = diagnostics(); let update!: (rows: BackendDiagnostic[]) => void; let done!: (rows: BackendDiagnostic[]) => void;
		local.check = vi.fn((_signal, next) => { update = next!; return new Promise(resolve => { done = resolve; }); });
		const c = controller(local); c.jump("Backends"); action(c, "check-backends"); c.escape();
		update([{ ...presence[0], check: "version-found", version: "9.9.9" }]); expect(c.backendDiagnostics).toEqual(presence);
		done(presence.map(row => row.name === "codex" ? { ...row, check: "cancelled" } : row)); await flush();
		expect(c.backendDiagnostics[0].check).toBe("cancelled"); expect(c.operation).toBeUndefined(); expect(c.testResults).toEqual([]);
	});
	it("unconfigured/missing/nonmatching detail guides configuration, never probes another route", () => {
		const paid = actions(); const c = controller(diagnostics(), paid);
		for (const name of ["codex", "pi", "amp", "anthropic"]) {
			detail(c, name); expect(c.fields.some(field => field.action === "test")).toBe(false);
			action(c, "configure-advisor"); expect(c.section).toBe("Advisor");
		}
		const empty = controller(diagnostics(), paid, {} as BpxCouncilConfig); empty.jump("Backends"); expect(empty.fields.some(field => field.action === "test")).toBe(false);
		detail(empty, "claude"); action(empty, "configure-advisor"); expect(empty.draft).toEqual({}); expect(paid.test).not.toHaveBeenCalled();
	});
	it("root and matching detail test exact unsaved Advisor route only after cost Run", async () => {
		const paid = actions(); const c = controller(diagnostics(), paid); c.draft.solo!.backend!.model = "unsaved@rev";
		c.jump("Backends"); action(c, "test"); expect(c.confirmation?.routes).toEqual(["claude:unsaved@rev"]); c.enter(); expect(paid.test).not.toHaveBeenCalled();
		detail(c, "claude"); action(c, "test"); c.move(1); c.enter(); await flush();
		expect(paid.test).toHaveBeenCalledWith(c.draft, { section: "advisor", role: "Advisor" }, expect.any(AbortSignal));
		expect(vi.mocked(paid.test).mock.calls[0][0]).not.toBe(c.draft); expect(c.testResults[0].result.elapsedMs).toBe(37);
		expect(screen(c)).toContain("Requested: claude:unsaved@rev"); expect(screen(c)).not.toContain("independent proof");
		c.escape(); expect(screen(c)).toContain("Response received · Requested: claude:unsaved@rev · 37ms");
		c.draft.solo!.backend!.model = "different"; expect(screen(c)).not.toContain("Response received"); expect(c.connectionReceipt({ section: "advisor", role: "Advisor" })).toBeUndefined();
		c.escape(); detail(c, "codex"); expect(screen(c)).not.toContain("Response received");
	});
	it("backend picker uses presence/version/key state, keeps unavailable saved route, manual copy names CLI route", () => {
		const saved = structuredClone(config); saved.solo!.backend = { type: "cli", command: "pi", model: "keep", args: ["private"], timeoutMs: 321 };
		const c = controller(diagnostics(), actions(), saved); c.jump("Advisor"); c.enter(); const choices = c.modal!.choices;
		expect(choices.find(choice => choice.value === undefined)?.label).toContain("current; keep exact; missing");
		expect(choices.some(choice => choice.value === "pi")).toBe(false); expect(choices.some(choice => choice.value === "amp")).toBe(false);
		expect(choices.find(choice => choice.value === "claude")?.label).toContain("Installed; not checked");
		expect(choices.find(choice => choice.value === "anthropic")?.label).toContain("Key missing"); expect(choices.map(choice => choice.label).join(" ")).not.toContain("login not verified");
		c.enter(); expect(c.draft).toEqual(saved); c.enter(); c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.manual); c.choose();
		expect(c.modal!.notice).toContain("CLI name"); expect(c.modal!.notice).toContain("not install CLI or accept API keys"); c.escape(); expect(c.draft).toEqual(saved);
	});
	it("unsupported preflight and missing routes show Not supported/Not available, not provider failure", () => {
		const paid = actions(); paid.preflight = vi.fn(() => ({ route: "claude:saved-model", error: "Custom args cannot be tested safely." }));
		const c = controller(diagnostics(), paid); c.jump("Backends"); action(c, "test");
		expect(c.confirmation).toBeUndefined(); expect(c.testResults[0].blocked).toBe(true); expect(screen(c)).toContain("Not supported"); expect(screen(c)).not.toContain("Failed");
		const saved = structuredClone(config); saved.solo!.backend = { type: "cli", command: "pi" }; const missing = controller(diagnostics(), paid, saved);
		missing.jump("Backends"); action(missing, "test"); expect(screen(missing)).toContain("Not available"); expect(screen(missing)).not.toContain("Failed"); expect(paid.test).not.toHaveBeenCalled();
	});
	it("cancelled in-flight receipt renders Cancelled, while local version remains separate", async () => {
		const paid = actions(); let done!: (result: RouteTestResult) => void; paid.test = vi.fn(() => new Promise(resolve => { done = resolve; }));
		const c = controller(diagnostics(), paid); c.jump("Backends"); action(c, "test"); c.move(1); c.enter(); c.escape();
		done({ ok: false, route: "claude:saved-model", elapsedMs: 5, text: "", cancelled: true }); await flush();
		expect(screen(c)).toContain("Cancelled"); expect(screen(c)).not.toContain("Test failed"); c.escape(); detail(c, "claude"); expect(screen(c)).toContain("Version: not checked");
	});
	it("local service rejection remains actionable and withheld, without dirty config", async () => {
		const local = diagnostics(); local.check = vi.fn(async () => { throw new Error("secret raw detail"); }); const c = controller(local);
		c.jump("Backends"); action(c, "check-backends"); await flush(); expect(c.operation).toBeUndefined(); expect(c.error).toContain("Retry Check installed CLIs"); expect(c.error).not.toContain("secret"); expect(c.dirty).toBe(false);
	});
});
