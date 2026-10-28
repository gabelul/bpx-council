import { describe, expect, it, vi } from "vitest";
import { ConfigDraft } from "../src/config-draft.js";
import type { ConfigActions } from "../src/config-actions.js";
import type { BpxCouncilConfig } from "../src/config.js";

/** Create project controller with explicit mock-only operations.
 * @param config Target-file layer, not merged global settings. @returns Controller and call spies.
 */
function project(config: BpxCouncilConfig) {
	const actions: ConfigActions = {
		preflight: vi.fn(() => ({ route: "anthropic:selected" })),
		test: vi.fn(async () => ({ ok: true, route: "anthropic:selected", elapsedMs: 1, text: "Route responded." })),
		generate: vi.fn(async () => ({ ok: false, route: "unused", elapsedMs: 0, text: "" })),
	};
	return { actions, controller: new ConfigDraft(config, { path: "/tmp/project/.bpx-council.json", scope: "project", project: true }, [], { listModels: async () => [], listEfforts: async () => null }, actions) };
}

/** Request current route's Test action without bypassing controller confirmation.
 * @param controller Active route detail. @returns No value.
 */
function testRoute(controller: ConfigDraft): void {
	controller.move("first");
	controller.move(controller.fields.findIndex(field => field.action === "test"));
	controller.enter();
}

describe("project action inheritance", () => {
	it("refuses unrepresented global Advisor before confirmation or transport", () => {
		const { controller: c, actions } = project({ defaultMode: "solo", solo: {} });
		c.jump("Advisor"); testRoute(c);
		expect(c.confirmation).toBeUndefined();
		expect(c.testResults[0].result.error).toContain("Global Advisor is not represented");
		expect(actions.preflight).not.toHaveBeenCalled();
		expect(actions.test).not.toHaveBeenCalled();
	});
	it("refuses an inherited Council seat instead of testing auto-detection", () => {
		const { controller: c, actions } = project({ defaultMode: "council", solo: {}, council: { members: ["architect"], backends: { architect: null } } });
		c.jump("Council"); c.horizontal("right"); testRoute(c);
		expect(c.confirmation).toBeUndefined();
		expect(c.testResults[0].result.route).toBe("Inherited global Advisor");
		expect(actions.test).not.toHaveBeenCalled();
	});
	it("allows independently pinned project HTTP seats after explicit confirmation", async () => {
		const { controller: c, actions } = project({ defaultMode: "council", solo: {}, council: { members: ["architect"], backends: { architect: "anthropic:selected" } } });
		c.jump("Council"); c.horizontal("right"); testRoute(c);
		expect(c.confirmation?.type).toBe("cost");
		expect(actions.test).not.toHaveBeenCalled();
		c.move(1); c.enter(); await Promise.resolve();
		expect(actions.test).toHaveBeenCalledTimes(1);
		expect(actions.test).toHaveBeenCalledWith(expect.objectContaining({ council: { members: ["architect"], backends: { architect: "anthropic:selected" } } }), { section: "council", role: "architect", member: true }, expect.any(AbortSignal));
	});
	it("allows inherited seats when project explicitly pins Advisor", () => {
		const { controller: c, actions } = project({ defaultMode: "council", solo: { backend: { type: "http", provider: "anthropic", model: "project-model" } } });
		c.jump("Council"); c.horizontal("right"); testRoute(c);
		expect(c.confirmation?.type).toBe("cost");
		expect(actions.preflight).toHaveBeenCalled();
		expect(actions.test).not.toHaveBeenCalled();
	});
});
