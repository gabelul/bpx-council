/** HTTP seat deadlines must reach the HTTP caller, not just CLI subprocesses. */
import { describe, expect, it, vi } from "vitest";

const callHttp = vi.fn().mockResolvedValue({ ok: true, text: "answer" });
vi.mock("../src/http-backend.js", () => ({ callHttpAdvisor: (...args: unknown[]) => callHttp(...args) }));

const { callAdvisor } = await import("../src/backend.js");
const { resolveSeatBackend } = await import("../src/detect.js");

describe("HTTP seat timeout", () => {
	it("passes --timeout to an explicit Anthropic seat", async () => {
		callHttp.mockClear();
		const backend = resolveSeatBackend("anthropic:claude-opus-4-8", { type: "cli", command: "codex" }, { timeoutMs: 9000 });
		await callAdvisor("system", "question", backend);
		expect(callHttp).toHaveBeenCalledWith("system", "question", expect.objectContaining({
			provider: "anthropic", model: "claude-opus-4-8", timeoutMs: 9000,
		}), 9000);
	});

	it("also honors a deadline on the shared HTTP backend", async () => {
		callHttp.mockClear();
		await callAdvisor("system", "question", {
			type: "http", provider: "anthropic", model: "claude-opus-4-8", timeoutMs: 5000,
		});
		expect(callHttp.mock.calls[0]?.[3]).toBe(5000);
	});
});
