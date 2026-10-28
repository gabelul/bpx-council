import React from "react";
import { PassThrough } from "node:stream";
import { render, renderToString, type Key } from "ink";
import stripAnsi from "strip-ansi";
import stringWidth from "string-width";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConfigDraft, modalChoices } from "../src/config-draft.js";
import type { BackendDiagnostics } from "../src/backend-diagnostics.js";
import type { ConfigActions } from "../src/config-actions.js";
import { WorkbenchView, fitWorkbenchText, workbenchKey } from "../src/config-workbench.js";
import { workbenchGeometry, type WorkbenchFrame, type WorkbenchSize } from "../src/workbench-layout.js";

const sizes = [[220, 60], [120, 40], [80, 24], [40, 12], [20, 8]] as const;
/** Create a controller whose discovery, diagnostics and paid actions never leave this test.
 * @param models Optional compact model list for visible-choice budget checks.
 * @returns Isolated draft with catalog choices and local inventory rows.
 */
function fixture(models?: string[]): ConfigDraft {
	const names = ["codex", "claude", "pi", "opencode", "cursor-agent", "gemini", "qwen", "crush", "amp"];
	const diagnostics: BackendDiagnostics = {
		inventory: () => names.map(name => ({ name, label: name, kind: "cli", path: `/fake/${name}`, status: "installed", check: "not-checked" })),
		check: vi.fn(async () => []),
	};
	const actions: ConfigActions = {
		preflight: () => ({ route: "codex:gpt-pin@low", warning: "Codex basic read-only mode; tools may remain available." }),
		test: vi.fn(async () => ({ ok: true, route: "codex:gpt-pin@low", text: "fake", elapsedMs: 1 })),
		generate: vi.fn(async () => ({ ok: false, route: "fake", text: "", elapsedMs: 1 })),
	};
	return new ConfigDraft({ solo: { backend: { type: "cli", command: "codex", model: "gpt-pin", effort: "low" } } }, { path: "/fake/config.json", scope: "explicit" }, [], {
		listModels: async () => models ?? Array.from({ length: 80 }, (_, index) => `pin-${index}`), listEfforts: async () => null,
	}, actions, diagnostics);
}
/** Render with a terminal cell budget, rejecting overflow.
 * @param c Current draft. @param size Terminal bounds. @returns Plain terminal frame.
 */
function screen(c: ConfigDraft, size: WorkbenchSize): string {
	const text = stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size }), { columns: size.columns }));
	const lines = text.split("\n");
	expect(lines.length).toBeLessThanOrEqual(size.rows);
	for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(size.columns);
	return text;
}
/** Verify both geometry bounds and rendered frame corners, not only matching text.
 * @param text Terminal frame. @param frame Expected DOS window. @param size Terminal bounds.
 */
function centered(text: string, frame: WorkbenchFrame, size: WorkbenchSize): void {
	expect(frame.width).toBeLessThanOrEqual(size.columns);
	expect(frame.height).toBeLessThanOrEqual(size.rows - 1);
	expect(Math.abs(frame.left - (size.columns - frame.width - frame.left))).toBeLessThanOrEqual(1);
	expect(Math.abs(frame.top - (size.rows - 1 - frame.height - frame.top))).toBeLessThanOrEqual(1);
	if (!frame.inset) return;
	const lines = text.split("\n");
	expect(lines[frame.top][frame.left]).toBe("╔");
	expect(lines[frame.top][frame.left + frame.width - 1]).toBe("╗");
	expect(lines[frame.top + frame.height - 1][frame.left]).toBe("╚");
	expect(lines[frame.top + frame.height - 1][frame.left + frame.width - 1]).toBe("╝");
}
/** Focus and request an existing action, leaving execution to the safe-default confirmation.
 * @param c Draft. @param action Action identifier.
 */
function request(c: ConfigDraft, action: string): void {
	c.pane = "detail"; c.move("first"); c.move(c.fields.findIndex(field => field.action === action)); c.enter();
}

afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); });

describe("bounded DOS workbench geometry", () => {
	it.each([[220, 60], [120, 40], [80, 24]])("fits every compact Claude choice at %ix%i without a hidden last row", async (columns, rows) => {
		const c = fixture(["sonnet", "opus", "haiku"]); c.draft.solo!.backend = { type: "cli", command: "claude", model: "saved-only" };
		c.jump("Advisor"); c.edit(c.fields.find(field => field.kind === "model")); await Promise.resolve();
		const choices = modalChoices(c.modal!); expect(choices).toHaveLength(6);
		expect(workbenchGeometry(c, { columns, rows }).modalItems).toBeGreaterThanOrEqual(choices.length);
		const rendered = screen(c, { columns, rows });
		for (const label of ["sonnet", "opus", "haiku", "Backend default", "saved-only", "Enter model ID"]) expect(rendered).toContain(label);
	});
	it("NO_COLOR picker omits transparent underlay while preserving nested seat context", async () => {
		vi.stubEnv("NO_COLOR", "1"); const c = fixture(); c.draft.council = { backends: { architect: "codex:gpt-pin@low" } }; c.jump("Council"); c.horizontal("right");
		c.edit(c.fields.find(field => field.kind === "model")); await Promise.resolve();
		const rendered = screen(c, { columns: 80, rows: 24 });
		expect(rendered).toContain("Council / architect"); expect(rendered).toContain("Find:");
		expect(rendered).not.toContain("CONFIG WORKBENCH"); expect(rendered).not.toContain("Stored values stay unchanged");
	});
	it.each([[20, 8], [40, 12]])("NO_COLOR confirmation hides underlay and wraps exact long pins at %ix%i", (columns, rows) => {
		vi.stubEnv("NO_COLOR", "1"); vi.stubEnv("FORCE_COLOR", "3");
		const c = fixture(); c.jump("Advisor"); request(c, "test");
		c.confirmation!.routes = ["codex:pin@literal@ultra"];
		const rendered = screen(c, { columns, rows });
		expect(rendered).not.toContain("Backend"); expect(rendered).not.toContain("CONFIG WORKBENCH");
		expect(rendered).toContain("Codex read-only;"); expect(rendered).toContain("tools may remain.");
		expect(rendered).toContain("► Cancel");
		const pin = rendered.split("\n").map(line => line.trim().replace(/^[║ ]+|[║ ]+$/g, "")).join("");
		expect(pin).toContain("codex:pin@literal@ultra"); expect(c.confirmation!.routes).toEqual(["codex:pin@literal@ultra"]);
	});
	it.each(sizes)("centers shell, picker and cost windows at %ix%i; active items survive", async (columns, rows) => {
		const size = { columns, rows }, c = fixture();
		const initial = workbenchGeometry(c, size);
		expect(initial.main.width).toBe(Math.min(columns, 112)); expect(initial.main.height).toBeLessThanOrEqual(32); expect(initial.main.height).toBe(Math.min(rows - 1, columns < 24 ? 11 : 15));
		centered(screen(c, size), initial.main, size);
		c.jump("Advisor"); c.edit(c.fields.find(field => field.kind === "model")); await Promise.resolve();
		c.modal!.index = 60;
		const picker = workbenchGeometry(c, size), choices = modalChoices(c.modal!);
		expect(picker.dialog.width).toBeLessThanOrEqual(80);
		let text = screen(c, size); centered(text, picker.dialog, size);
		expect(text).toContain("Find:");
		expect(text).toContain(fitWorkbenchText(`► ${choices[60].label}`, picker.dialog.innerWidth));
		expect(text.match(/►/g)).toHaveLength(1);
		workbenchKey(c, "", { pageDown: true } as Key, size);
		expect(c.modal!.index).toBe(60 + picker.pageItems);
		workbenchKey(c, "", { pageUp: true } as Key, size); expect(c.modal!.index).toBe(60);
		c.escape(); request(c, "test");
		const cost = workbenchGeometry(c, size);
		text = screen(c, size); centered(text, cost.dialog, size);
		expect(text).toContain("Quota/cost:"); expect(text).toContain("codex:gpt-pin@low");
		expect(text).toContain("Codex read-only;"); expect(text).toContain("tools may remain.");
		expect(text).toContain("► Cancel"); expect(text.match(/►/g)).toHaveLength(1);
		c.tab(); text = screen(c, size); expect(text).toContain("► Run 1 call(s)");
	});
	it.each(sizes)("keeps preview/results/action focus reachable at %ix%i with exact page budget", (columns, rows) => {
		const size = { columns, rows }, c = fixture();
		c.jump("Council"); c.startCandidate({ name: "reader", stance: "neutral", systemPrompt: "Line one\nLine two\nLine three" });
		request(c, "preview"); c.move("last");
		let geometry = workbenchGeometry(c, size), text = screen(c, size);
		expect(text).toContain(fitWorkbenchText(`► ${c.fields[c.index].label}`, geometry.detailWidth));
		expect(geometry.pageItems).toBe(Math.min(c.fields.length, geometry.detailItems));
		c.screen = { type: "results" };
		const fingerprint = JSON.stringify([c.draft.solo!.backend, { route: "codex:gpt-pin@low", warning: "Codex basic read-only mode; tools may remain available." }, undefined]);
		c.testResults = Array.from({ length: 40 }, (_, index) => ({ target: { section: "council", role: `seat-${index}`, member: true }, fingerprint, result: { ok: true, route: `claude:pin-${index}`, text: "fake response", elapsedMs: 1 } }));
		c.move("first"); geometry = workbenchGeometry(c, size);
		workbenchKey(c, "", { pageDown: true } as Key, size); expect(c.index).toBe(geometry.pageItems);
		text = screen(c, size);
		expect(text).toContain(fitWorkbenchText(`► ${c.fields[c.index].label} · ${c.fields[c.index].value}`, geometry.detailWidth));
		c.jump("Advisor"); c.move(c.fields.findIndex(field => field.action === "test"));
		if (columns <= 40) expect(screen(c, size)).toContain("► Test this route");
	});
	it.each(sizes)("keeps local operation dimensions stable and paid calls indeterminate at %ix%i", (columns, rows) => {
		const size = { columns, rows }, c = fixture();
		c.operation = { type: "local-check", abort: new AbortController(), cancelling: false, completed: 0, total: 9, current: "codex", rows: c.backendDiagnostics.map(row => ({ label: row.name, status: "Waiting" })) };
		const before = workbenchGeometry(c, size).dialog;
		const inventory = c.backendDiagnostics;
		c.backendDiagnostics = inventory.slice(0, 1); c.operation.total = 1;
		expect(workbenchGeometry(c, size).dialog).toEqual(before);
		c.backendDiagnostics = inventory; c.operation.total = 9;
		c.operation.completed = 6; c.operation.current = "qwen";
		c.operation.rows = c.operation.rows!.map((row, index) => ({ ...row, status: index < 6 ? "Version found" : index === 6 ? "Checking" : "Waiting" }));
		expect(workbenchGeometry(c, size).dialog).toEqual(before);
		let text = screen(c, size); centered(text, before, size);
		expect(before.width).toBeLessThanOrEqual(80); expect(before.height).toBeLessThanOrEqual(24);
		expect(text).toContain("Checked 6/9 steps"); expect(text).toContain("CLI: qwen"); expect(text).toContain("█"); expect(text).toContain("░"); expect(text).not.toContain("►");
		if (columns >= 80) { expect(text).toContain("Backend"); expect(text).toContain("│ Status"); expect(text).toContain("No model calls."); }
		c.operation.cancelling = true; expect(workbenchGeometry(c, size).dialog).toEqual(before); expect(screen(c, size)).toContain("Awaiting cleanup");
		c.operation = { type: "test", abort: new AbortController(), cancelling: false, completed: 0, total: 1, current: "codex:gpt-pin", rows: [{ label: "Advisor", status: "Testing" }] };
		text = screen(c, size); expect(text).toContain("Testing connection"); expect(text).not.toMatch(/[█░%]/); expect(text).toContain("Done 0/1 calls");
	});
	it.each([false, true])("keeps %s multiline caret across wide/narrow resize without remount", async multiline => {
		vi.useFakeTimers(); const c = fixture(); c.jump("Advisor");
		if (multiline) { c.startCandidate({ name: "reader", stance: "neutral", systemPrompt: "abcdef" }); c.edit(c.fields.find(field => field.kind === "prompt")); }
		else { c.edit(c.fields.find(field => field.kind === "model")); await Promise.resolve(); c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.manual); c.choose(); c.text("abcdef"); }
		const stdout = Object.assign(new PassThrough(), { columns: 120, rows: 40, isTTY: true });
		const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() });
		const app = render(React.createElement(WorkbenchView, { controller: c, size: { columns: 120, rows: 40 } }), { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
		try {
			await vi.advanceTimersByTimeAsync(50); stdin.write("\x1b[D"); await vi.advanceTimersByTimeAsync(30); stdin.write("\x1b[D"); await vi.advanceTimersByTimeAsync(30); stdin.write("\x1b[D"); await vi.advanceTimersByTimeAsync(30);
			app.rerender(React.createElement(WorkbenchView, { controller: c, size: { columns: 20, rows: 8 } })); await vi.advanceTimersByTimeAsync(50);
			stdin.write("X"); await vi.advanceTimersByTimeAsync(30); expect(c.modal!.text).toBe("abcXdef");
			app.rerender(React.createElement(WorkbenchView, { controller: c, size: { columns: 220, rows: 60 } })); await vi.advanceTimersByTimeAsync(50);
			stdin.write("Y"); await vi.advanceTimersByTimeAsync(30); expect(c.modal!.text).toBe("abcXYdef");
		} finally { app.unmount(); c.cancel(); }
	});
});
