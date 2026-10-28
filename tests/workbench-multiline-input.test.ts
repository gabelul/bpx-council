import { describe, expect, it } from "vitest";
import { editMultilineInput } from "../src/workbench-multiline-input.js";

describe("multiline input", () => {
	it("Enter inserts LF while Ctrl-S leaves text/caret for submit owner", () => {
		expect(editMultilineInput("onetwo", 3, "", { return: true })).toEqual({ value: "one\ntwo", cursor: 4 });
		expect(editMultilineInput("one\ntwo", 4, "s", { ctrl: true })).toEqual({ value: "one\ntwo", cursor: 4 });
	});
	it("preserves multiline paste, tabs, leading/trailing spaces; strips ANSI and other controls", () => {
		expect(editMultilineInput("", 0, "  one\r\n\ttwo\n\x1b[31mthree\x1b[0m\x00\x07 ", {})).toEqual({ value: "  one\n\ttwo\nthree ", cursor: 17 });
	});
	it("arrows navigate logical lines without mutating Unicode text", () => {
		const value = "界abc\nxy\nlast";
		expect(editMultilineInput(value, 3, "", { downArrow: true })).toEqual({ value, cursor: 7 });
		expect(editMultilineInput(value, 7, "", { upArrow: true })).toEqual({ value, cursor: 2 });
		expect(editMultilineInput(value, 0, "", { upArrow: true })).toEqual({ value, cursor: 0 });
		expect(editMultilineInput(value, 12, "", { downArrow: true })).toEqual({ value, cursor: 12 });
	});
	it("Home/End and Ctrl-A/E belong to current line, including empty first line", () => {
		const value = "\none\ntwo";
		expect(editMultilineInput(value, 0, "", { home: true })).toEqual({ value, cursor: 0 });
		expect(editMultilineInput(value, 0, "", { end: true })).toEqual({ value, cursor: 0 });
		expect(editMultilineInput(value, 1, "", { upArrow: true })).toEqual({ value, cursor: 0 });
		expect(editMultilineInput(value, 3, "a", { ctrl: true })).toEqual({ value, cursor: 1 });
		expect(editMultilineInput(value, 2, "e", { ctrl: true })).toEqual({ value, cursor: 4 });
	});
	it("Backspace/Delete can join lines and remain code-point aware", () => {
		expect(editMultilineInput("界\nx", 2, "", { backspace: true })).toEqual({ value: "界x", cursor: 1 });
		expect(editMultilineInput("界\nx", 1, "", { delete: true }, true)).toEqual({ value: "界x", cursor: 1 });
		expect(editMultilineInput("界\nx", 1, "", { delete: true })).toEqual({ value: "\nx", cursor: 0 });
	});
	it("Esc, Tab and Ctrl-C never edit or submit text", () => {
		for (const [input, key] of [["", { escape: true }], ["", { tab: true }], ["c", { ctrl: true }]] as const) expect(editMultilineInput("one\ntwo", 4, input, key)).toEqual({ value: "one\ntwo", cursor: 4 });
	});
});
