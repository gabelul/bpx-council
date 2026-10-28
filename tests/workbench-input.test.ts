import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { editWorkbenchInput, workbenchInputWindow } from "../src/workbench-input.js";

describe("workbench input editing", () => {
	it("inserts a whole paste at caret and preserves existing suffix", () => {
		expect(editWorkbenchInput("model-abc", 6, "XYZ", {})).toEqual({ value: "model-XYZabc", cursor: 9 });
	});
	it("distinguishes forward Delete from ASCII DEL/Backspace", () => {
		expect(editWorkbenchInput("abc", 1, "", { delete: true }, true)).toEqual({ value: "ac", cursor: 1 });
		expect(editWorkbenchInput("abc", 1, "", { delete: true }, false)).toEqual({ value: "bc", cursor: 0 });
		expect(editWorkbenchInput("abc", 1, "", { backspace: true })).toEqual({ value: "bc", cursor: 0 });
	});
	it("moves by code points and never splits a surrogate pair", () => {
		const value = "a\u{1d400}b";
		expect(editWorkbenchInput(value, 2, "", { leftArrow: true })).toEqual({ value, cursor: 1 });
		expect(editWorkbenchInput(value, 1, "", { delete: true }, true)).toEqual({ value: "ab", cursor: 1 });
	});
	it.each([["home", 0], ["end", 3], ["leftArrow", 0], ["rightArrow", 2]] as const)("handles %s caret movement", (key, cursor) => {
		expect(editWorkbenchInput("abc", 1, "", { [key]: true })).toEqual({ value: "abc", cursor });
	});
	it("supports Ctrl-A/E without inserting shortcut letters", () => {
		expect(editWorkbenchInput("abc", 1, "a", { ctrl: true })).toEqual({ value: "abc", cursor: 0 });
		expect(editWorkbenchInput("abc", 1, "e", { ctrl: true })).toEqual({ value: "abc", cursor: 3 });
		expect(editWorkbenchInput("abc", 1, "k", { ctrl: true })).toEqual({ value: "abc", cursor: 1 });
	});
	it("leaves global navigation and cancellation alone", () => {
		for (const key of ["escape", "tab", "upArrow", "downArrow", "pageUp", "pageDown", "return", "meta"]) {
			expect(editWorkbenchInput("abc", 1, "X", { [key]: true })).toEqual({ value: "abc", cursor: 1 });
		}
	});
	it("clamps caret and deletion at either edge", () => {
		expect(editWorkbenchInput("abc", -2, "", { backspace: true })).toEqual({ value: "abc", cursor: 0 });
		expect(editWorkbenchInput("abc", 99, "", { delete: true }, true)).toEqual({ value: "abc", cursor: 3 });
	});
	it("drops control characters from pasted text", () => {
		expect(editWorkbenchInput("", 0, "provider/\nmodel\x00", {})).toEqual({ value: "provider/model", cursor: 14 });
	});
});

describe("workbench input horizontal viewport", () => {
	it("scrolls without truncating stored value", () => {
		expect(workbenchInputWindow("provider/long-model", 19, 8)).toEqual({ before: "g-model", caret: " ", after: "" });
	});
	it("counts terminal cells for wide characters", () => {
		expect(workbenchInputWindow("界abc", 3, 3)).toEqual({ before: "ab", caret: "c", after: "" });
		for (let width = 1; width <= 12; width++) {
			for (let cursor = 0; cursor <= 4; cursor++) {
				const result = workbenchInputWindow("界界ab", cursor, width);
				expect(stringWidth(result.before + result.caret + result.after)).toBeLessThanOrEqual(width);
			}
		}
	});
});
