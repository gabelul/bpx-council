/**
 * select tests.
 *
 * The raw-mode driver needs a pty, so these pin the pure parts: the filter (what
 * matches, in what order) and the renderers (cursor row, width clipping, the
 * windowed match list). A wrong filter or a wrapping line desyncs the redraw.
 */

import { describe, expect, it } from "vitest";
import { filterItems, renderFilter, renderSelect } from "../src/select.js";
import { dimProvider, highlightMatch, MODE_HINTS, modeTone } from "../src/theme.js";
import { parseAnthropicModels, parseCodexModels, parseOpencodeModels, backendListsModels } from "../src/models-list.js";

describe("filterItems", () => {
	const items = ["google/gemini-3-pro", "openai/gpt-5", "anthropic/claude-opus-4-8", "google/gemini-3-flash"];

	it("returns everything for an empty query", () => {
		expect(filterItems(items, "")).toEqual(items);
	});

	it("is case-insensitive substring, order preserved", () => {
		expect(filterItems(items, "GEMINI")).toEqual(["google/gemini-3-pro", "google/gemini-3-flash"]);
		expect(filterItems(items, "gpt")).toEqual(["openai/gpt-5"]);
	});

	it("returns nothing for a non-match", () => {
		expect(filterItems(items, "zzz")).toEqual([]);
	});
});

describe("renderSelect", () => {
	it("marks the cursor row", () => {
		const out = renderSelect([{ label: "codex", value: "codex" }, { label: "claude", value: "claude" }], 1, "Pick:", 80);
		expect(out).toContain("❯ claude");
		expect(out).toContain("  codex");
		expect(out).toContain("enter select");
	});

	it("clips long labels to width so nothing wraps", () => {
		const long = "x".repeat(200);
		const out = renderSelect([{ label: long, value: "v" }], 0, "h", 40);
		for (const line of out.split("\n")) expect(line.length).toBeLessThanOrEqual(40);
	});
});

describe("renderFilter", () => {
	it("shows the query, the cursor match, and the total on a windowed list", () => {
		const matches = Array.from({ length: 30 }, (_, i) => `model-${i}`);
		const out = renderFilter("Model?", "model", matches, 0, 8, 80);
		expect(out).toContain("model"); // the query line
		expect(out).toContain("❯ model-0"); // cursor
		expect(out).toContain("30 matches"); // more than the window
	});

	it("prompts to use typed text when nothing matches", () => {
		const out = renderFilter("Model?", "zzz", [], 0, 8, 80);
		expect(out).toContain("no match");
	});
});

describe("models-list parsing", () => {
	it("parses opencode's provider/model lines, dropping blanks", () => {
		expect(parseOpencodeModels("google/gemini-3-pro\n\nopenai/gpt-5\n  \n")).toEqual([
			"google/gemini-3-pro",
			"openai/gpt-5",
		]);
	});

	it("pulls ids from the Anthropic models response", () => {
		expect(parseAnthropicModels({ data: [{ id: "claude-opus-4-8" }, { id: "claude-sonnet-5" }, { notId: 1 }] })).toEqual([
			"claude-opus-4-8",
			"claude-sonnet-5",
		]);
	});

	it("takes only the listable slugs from codex's catalog, dropping hidden ones", () => {
		const catalog = {
			models: [
				{ slug: "gpt-5.6-sol", visibility: "list" },
				{ slug: "codex-auto-review", visibility: "hide" }, // internal, not pickable
				{ slug: "gpt-5.5", visibility: "list" },
				{ notSlug: 1, visibility: "list" }, // malformed, skipped
			],
		};
		expect(parseCodexModels(catalog)).toEqual(["gpt-5.6-sol", "gpt-5.5"]);
	});

	it("survives a codex catalog with no models field", () => {
		expect(parseCodexModels({})).toEqual([]);
	});

	it("knows which backends can list models", () => {
		expect(backendListsModels("opencode")).toBe(true);
		expect(backendListsModels("anthropic")).toBe(true);
		expect(backendListsModels("codex")).toBe(true);
		expect(backendListsModels("claude")).toBe(false);
	});
});

describe("theme", () => {
	it("highlights the matched slice, case-insensitively, first hit only", () => {
		// Colour is off when stdout isn't a TTY (vitest), so the text must survive untouched.
		expect(highlightMatch("zai/glm-5", "GLM")).toContain("glm");
		expect(highlightMatch("zai/glm-5", "zzz")).toBe("zai/glm-5");
		expect(highlightMatch("zai/glm-5", "")).toBe("zai/glm-5");
	});

	it("leaves an unqualified model id alone when dimming the provider", () => {
		expect(dimProvider("gpt-5.6-sol")).toBe("gpt-5.6-sol");
		expect(dimProvider("zai/glm-5")).toContain("glm-5");
	});

	it("gives council, debate and gut-check distinct tones from solo", () => {
		const tones = ["solo", "council", "debate", "gut-check"].map((m) => modeTone(m));
		// Distinct function identities — each mode maps to its own colour helper.
		expect(new Set(tones).size).toBe(4);
	});

	it("explains every mode in the picker", () => {
		for (const m of ["solo", "council", "debate", "gut-check"]) {
			expect(MODE_HINTS[m]).toBeTruthy();
		}
	});
});
