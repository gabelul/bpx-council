import React from "react";
import { renderToString } from "ink";
import stripAnsi from "strip-ansi";
import { describe, expect, it } from "vitest";
import { ConfigDraft } from "../src/config-draft.js";
import { WorkbenchView } from "../src/config-workbench.js";

/** Render isolated Council navigation without discovery or provider calls.
 * @param columns Terminal cell width. @param action Select Enter-only Add persona.
 * @returns Plain terminal frame.
 */
function frame(columns: number, action: boolean): string {
	const controller = new ConfigDraft({ defaultMode: "solo", solo: { backend: { type: "cli", command: "claude" } } },
		{ path: "/tmp/test.json", scope: "explicit" }, [], { listModels: async () => [], listEfforts: async () => null });
	controller.jump("Council");
	if (action) controller.move(controller.fields.findIndex(field => field.action === "add"));
	return stripAnsi(renderToString(React.createElement(WorkbenchView, { controller, size: { columns, rows: columns === 40 ? 12 : 26 } }), { columns }));
}

describe("contextual workbench hints", () => {
	it("advertises arrows for nested seat navigation", () => {
		expect(frame(100, false)).toContain("→/Enter open");
	});
	it.each([100, 40])("advertises Enter, not arrow execution, for actions at %i columns", columns => {
		const rendered = frame(columns, true);
		expect(rendered).toContain("Enter action");
		expect(rendered).not.toContain("→/Enter open");
	});
});
