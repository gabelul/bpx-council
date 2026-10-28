import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ preflight: vi.fn(), advisor: vi.fn() }));
vi.mock("../src/sdk-backend.js", () => ({ preflightSdkBackend: fake.preflight }));
vi.mock("../src/backend.js", () => ({ callAdvisor: fake.advisor }));
import { doctorRoutes, routeStatus, runDoctor } from "../src/doctor.js";
import { seatAttempt, addAttempt, newReceipt } from "../src/receipt.js";
import type { BpxCouncilConfig } from "../src/config.js";

/** Build SDK config without credentials or executable paths. @returns Isolated config value. */
function sdkConfig(): BpxCouncilConfig {
	return { defaultMode: "solo", solo: { backend: { type: "sdk", provider: "openai", model: "gpt-5-mini", effort: "low" } } };
}

beforeEach(() => {
	fake.preflight.mockReset().mockReturnValue({ ok: true, revision: "opaque-generation" });
	fake.advisor.mockReset().mockResolvedValue({ ok: true, text: "fixture answer" });
	vi.stubEnv("BPX_COUNCIL_MODEL", "");
	vi.stubEnv("ANTHROPIC_MODEL", "");
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

describe("SDK route reporting", () => {
	it("reports own credential presence without asserting authentication", () => {
		expect(routeStatus(sdkConfig().solo.backend!)).toBe("Council credential stored; connection untested");
		expect(fake.advisor).not.toHaveBeenCalled();
	});
	it("shows safe preflight blockers, never treats SDK as a CLI", () => {
		fake.preflight.mockReturnValue({ ok: false, error: "Choose a Council provider account", revision: "missing" });
		expect(routeStatus(sdkConfig().solo.backend!)).toBe("unavailable (Choose a Council provider account)");
		expect(fake.advisor).not.toHaveBeenCalled();
	});
	it("keeps SDK pins despite ambient model overrides and preserves inherited seat identity", () => {
		vi.stubEnv("BPX_COUNCIL_MODEL", "ambient-model");
		const config = sdkConfig();
		config.council = { backends: { critic: "sdk:anthropic:claude-sonnet-4-6@high" } };
		const routes = doctorRoutes(config);
		expect(routes.find(row => row.seat === "Solo")?.backend?.model).toBe("gpt-5-mini");
		expect(routes.find(row => row.seat === "Gut-check")?.backend?.type).toBe("sdk");
		expect(routes.find(row => row.seat === "Council/critic")?.backend).toMatchObject({ type: "sdk", provider: "anthropic", model: "claude-sonnet-4-6", effort: "high" });
	});
	it("does not hide legacy effort from SDK preflight", () => {
		const config = sdkConfig();
		delete config.solo.backend!.effort;
		config.solo.thinkingLevel = "ultra";
		const route = doctorRoutes(config)[0].backend;
		expect(route?.type === "sdk" ? route.effort : undefined).toBe("ultra");
	});
	it("attributes SDK provider/model/effort and only reported usage", () => {
		const attempt = seatAttempt("critic", null, sdkConfig().solo.backend!, { ok: true, text: "fixture", usage: { inputTokens: 3, outputTokens: 2 } });
		expect(attempt.route).toMatchObject({ type: "sdk", command: null, provider: "openai", model: "gpt-5-mini", effort: "low" });
		const receipt = newReceipt(); addAttempt(receipt, attempt);
		expect(receipt.usage).toMatchObject({ attempted: 1, reported: 1, inputTokens: 3, outputTokens: 2 });
		expect(JSON.stringify(receipt)).not.toContain("opaque-generation");
	});
	it("makes only an explicitly requested bounded SDK smoke call", async () => {
		const directory = mkdtempSync(join(tmpdir(), "bpx-sdk-doctor-"));
		const file = join(directory, "config.json");
		writeFileSync(file, JSON.stringify(sdkConfig()));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		try {
			expect(await runDoctor(file, directory, false)).toBe(0);
			expect(fake.advisor).not.toHaveBeenCalled();
			expect(await runDoctor(file, directory, true)).toBe(0);
			expect(fake.advisor).toHaveBeenCalledTimes(1);
			expect(fake.advisor.mock.calls[0][2]).toMatchObject({ type: "sdk", provider: "openai", model: "gpt-5-mini", timeoutMs: 10_000, maxOutputBytes: 8192 });
			expect(fake.advisor.mock.calls[0][2].maxOutputTokens).toBeUndefined();
		} finally { rmSync(directory, { recursive: true, force: true }); }
	});
});
