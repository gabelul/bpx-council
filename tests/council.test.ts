/**
 * Unit tests for the pure logic: arg parsing, config loading, persona prompts,
 * CLI output parsing. The subprocess calls (callCliAdvisor) aren't unit-tested
 * — they spawn real processes and are proven by the live smoke tests.
 */

import { describe, expect, it } from "vitest";
import { parseCliOutput } from "../src/backend.js";
import { DEFAULT_PERSONAS, SYNTHESIZER_PROMPT } from "../src/personas.js";
import { DEFAULT_CONFIG, loadConfig } from "../src/config.js";

describe("parseCliOutput", () => {
	it("extracts text from codex JSONL lines, ignoring junk preamble", () => {
		const stdout = `Using model gpt-5\n{"type":"item.completed","item":{"type":"agent_message","text":"The answer is 42."}}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("The answer is 42.");
	});

	it("collects multiple JSONL payloads in order", () => {
		const stdout = `{"type":"item.completed","item":{"type":"agent_message","text":"First part."}}\n{"type":"item.completed","item":{"type":"agent_message","text":"Second part."}}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("First part.\nSecond part.");
	});

	it("falls back to plain text for claude", () => {
		expect(parseCliOutput("Just a plain reply.", "claude")).toBe("Just a plain reply.");
	});

	it("returns empty for empty stdout", () => {
		expect(parseCliOutput("", "codex")).toBe("");
	});

	it("tolerates non-JSON lines that start with {", () => {
		const stdout = `{not valid json}\n{"type":"item.completed","item":{"type":"agent_message","text":"Real payload."}}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("Real payload.");
	});

	it("does not mistake tool output or progress JSONL for an advisor answer", () => {
		const stdout = `{"type":"item.completed","item":{"type":"command_execution","text":"tool output"}}\n{"type":"status","status":"running"}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("");
	});
});

describe("personas", () => {
	it("DEFAULT_PERSONAS has architect (for), critic (against), simplifier (neutral)", () => {
		const stances = DEFAULT_PERSONAS.map((p) => [p.name, p.stance]);
		expect(stances).toEqual([["architect", "for"], ["critic", "against"], ["simplifier", "neutral"]]);
	});

	it("each persona has a non-empty systemPrompt", () => {
		for (const p of DEFAULT_PERSONAS) {
			expect(p.systemPrompt.length).toBeGreaterThan(50);
		}
	});

	it("SYNTHESIZER_PROMPT instructs reading ALL sections", () => {
		expect(SYNTHESIZER_PROMPT).toMatch(/READ EVERY SECTION|read every section/i);
	});
});

describe("config", () => {
	it("DEFAULT_CONFIG leaves backend undefined for auto-detection", () => {
		// No hardcoded backend — detectBackend picks the best available at runtime
		// (env vars > CLIs on PATH > default). Override via config or --backend.
		expect(DEFAULT_CONFIG.solo.backend).toBeUndefined();
		// solo.model used to default to "auto" and was read by nothing.
		expect(DEFAULT_CONFIG.solo.model).toBeUndefined();
	});

	it("DEFAULT_CONFIG has a sane context window", () => {
		// contextWindow and solo.model used to ship as defaults and were read by
		// nothing. New configs shouldn't carry either.
		expect(DEFAULT_CONFIG.contextWindow).toBeUndefined();
		expect(DEFAULT_CONFIG.solo.model).toBeUndefined();
	});

	it("loadConfig rejects a missing explicit file instead of falling back", () => {
		expect(() => loadConfig("/nonexistent/path/bpx-council.json")).toThrow(/config file not found/);
	});
});
