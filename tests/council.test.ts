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
		const stdout = `Using model gpt-5\n{"type":"item.completed","item":{"text":"The answer is 42."}}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("The answer is 42.");
	});

	it("collects multiple JSONL payloads in order", () => {
		const stdout = `{"item":{"text":"First part."}}\n{"item":{"text":"Second part."}}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("First part.\nSecond part.");
	});

	it("falls back to plain text for claude", () => {
		expect(parseCliOutput("Just a plain reply.", "claude")).toBe("Just a plain reply.");
	});

	it("returns empty for empty stdout", () => {
		expect(parseCliOutput("", "codex")).toBe("");
	});

	it("tolerates non-JSON lines that start with {", () => {
		const stdout = `{not valid json}\n{"item":{"text":"Real payload."}}\n`;
		expect(parseCliOutput(stdout, "codex")).toBe("Real payload.");
	});

	it("falls back to the whole stdout when JSONL has no text payloads", () => {
		// No extractable text in JSONL → return everything (defensive: better to
		// return potentially-useful stdout than empty).
		const stdout = `{"type":"status","status":"running"}\nPlain text after.\n`;
		const result = parseCliOutput(stdout, "codex");
		expect(result).toContain("Plain text after.");
		expect(result.trim()).toBe(stdout.trim());
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
		expect(DEFAULT_CONFIG.solo.model).toBe("auto");
	});

	it("DEFAULT_CONFIG has a sane context window", () => {
		expect(DEFAULT_CONFIG.contextWindow).toBeGreaterThan(10_000);
	});

	it("loadConfig returns defaults when no file exists", () => {
		const cfg = loadConfig("/nonexistent/path/bpx-council.json");
		expect(cfg.defaultMode).toBe("solo");
		expect(cfg.solo.model).toBe("auto");
	});
});
