import { describe, expect, it } from "vitest";
import { ConfigDraft, type DraftTestResult } from "../src/config-draft.js";

/** Create status-only controller without filesystem inventory or provider calls.
 * @returns Injectable empty controller.
 */
function controller(): ConfigDraft {
	return new ConfigDraft({}, { path: "/tmp/status.json", scope: "explicit" }, [], { listModels: async () => [], listEfforts: async () => null }, undefined, { inventory: () => [], check: async () => [] });
}

describe("honest connection receipts", () => {
	it.each([
		[{ pending: true }, "Queued"],
		[{ blocked: true }, "Not supported"],
		[{ blocked: true, error: "Not available: Missing" }, "Not available"],
		[{ ok: true }, "Response received"],
		[{ ok: false }, "Test failed"],
		[{ cancelled: true, error: "Cancelled" }, "Cancelled"],
		[{ cancelled: true, error: "Not called; cancellation stopped batch." }, "Not called"],
		[{ error: "Not called; route changed. Confirm again." }, "Not called"],
	])("distinguishes %j as %s", (fields, label) => {
		const { pending, blocked, ...result } = fields as { pending?: boolean; blocked?: boolean; ok?: boolean; cancelled?: boolean; error?: string };
		const receipt: DraftTestResult = { target: { section: "advisor", role: "Advisor" }, fingerprint: "fixture", pending, blocked, result: { ok: false, route: "claude:selected", elapsedMs: 1, text: "", ...result } };
		expect(controller().testStatus(receipt)).toBe(label);
	});
	it("manual backend entry isn't described as an ID/API-key field", () => {
		const c = controller(); c.jump("Advisor"); c.enter();
		expect(c.modal?.choices.find(choice => choice.manual)?.label).toBe("Enter backend manually…");
		expect(c.modal?.notice).toContain("not an API key");
	});
});
