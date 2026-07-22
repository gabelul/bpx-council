/**
 * multiselect tests.
 *
 * The raw-mode driver needs a real pty to exercise, so what's tested here is
 * the pure state machine and the renderer — the parts where a bug would pick
 * the wrong agents or corrupt the redraw. The keypress wiring on top is thin.
 */

import { describe, expect, it } from "vitest";
import { chosen, initState, move, render, toggleAll, toggleCurrent } from "../src/multiselect.js";

const ITEMS = ["Claude Code", "Codex", "Shared skills", "AGENTS.md"];

describe("initState", () => {
	it("pre-checks the given indices and starts at the top", () => {
		const s = initState(ITEMS, [0, 2]);
		expect(chosen(s)).toEqual([0, 2]);
		expect(s.cursor).toBe(0);
	});

	it("drops out-of-range initial indices", () => {
		expect(chosen(initState(ITEMS, [0, 9, -1]))).toEqual([0]);
	});
});

describe("move", () => {
	it("wraps at both ends", () => {
		const s = initState(ITEMS, []);
		move(s, -1);
		expect(s.cursor).toBe(ITEMS.length - 1); // up from top → bottom
		move(s, 1);
		expect(s.cursor).toBe(0); // down from bottom → top
	});
});

describe("toggleCurrent", () => {
	it("adds then removes the item under the cursor", () => {
		const s = initState(ITEMS, []);
		s.cursor = 1;
		toggleCurrent(s);
		expect(chosen(s)).toEqual([1]);
		toggleCurrent(s);
		expect(chosen(s)).toEqual([]);
	});
});

describe("toggleAll", () => {
	it("selects all when some are unselected, clears when all are selected", () => {
		const s = initState(ITEMS, [0]);
		toggleAll(s); // some unselected → select all
		expect(chosen(s)).toEqual([0, 1, 2, 3]);
		toggleAll(s); // all selected → clear
		expect(chosen(s)).toEqual([]);
	});
});

describe("render", () => {
	it("marks the cursor row and the checked boxes", () => {
		const s = initState(ITEMS, [0]);
		s.cursor = 0;
		const out = render(s, "Pick:", 80);
		expect(out).toContain("❯ ◉ Claude Code"); // cursor + checked
		expect(out).toContain("  ◯ Codex"); // unchecked, no cursor
		expect(out).toContain("space toggle");
	});

	it("clips long lines to the width so nothing wraps", () => {
		const long = "x".repeat(200);
		const out = render(initState([long], [0]), "h", 40);
		for (const line of out.split("\n")) {
			expect(line.length).toBeLessThanOrEqual(40);
		}
		expect(out).toContain("…"); // truncation marker
	});
});
