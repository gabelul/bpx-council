import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { CLI_BACKENDS } from "../src/cli-registry.js";
import { backendListsModels, listModels } from "../src/models-list.js";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => { throw new Error("Unexpected subprocess"); }),
	execFileSync: vi.fn(() => { throw new Error("Unexpected synchronous subprocess"); }),
}));

afterEach(() => {
	vi.clearAllMocks();
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
});

describe("Claude selectable model aliases", () => {
	it("offers documented aliases without subprocesses or fetch", async () => {
		const fetch = vi.fn(() => { throw new Error("Unexpected fetch"); });
		vi.stubGlobal("fetch", fetch);
		expect(backendListsModels("claude")).toBe(true);
		expect(await listModels("claude")).toEqual(["sonnet", "opus", "haiku"]);
		expect(spawn).not.toHaveBeenCalled();
		expect(execFileSync).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});

	it("returns independent copies without changing registry presets", async () => {
		const first = await listModels("claude");
		const second = await listModels("claude");
		expect(first).not.toBe(second);
		expect(first).not.toBe(CLI_BACKENDS.claude.modelPresets);
		first[0] = "caller-only";
		first.push("custom-id");
		expect(second).toEqual(["sonnet", "opus", "haiku"]);
		expect(await listModels("claude")).toEqual(second);
		expect(CLI_BACKENDS.claude.modelPresets).toEqual(second);
	});

	it.each(["claude", "codex", "anthropic", "unknown"])("honors pre-aborted %s discovery without I/O", async name => {
		const fetch = vi.fn(() => { throw new Error("Unexpected fetch"); });
		vi.stubGlobal("fetch", fetch);
		vi.stubEnv("ANTHROPIC_API_KEY", "test-key-not-real");
		const abort = new AbortController();
		abort.abort();
		expect(await listModels(name, abort.signal)).toEqual([]);
		expect(spawn).not.toHaveBeenCalled();
		expect(execFileSync).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
});
