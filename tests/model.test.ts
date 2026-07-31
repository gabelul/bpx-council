/**
 * Model-selection tests.
 *
 * Covers the two things that make "use codex on model X" and per-persona models
 * work: parsing a `name:model` backend spec, and injecting the model as each
 * CLI's own flag in the right position. The flag positions were verified against
 * `--help`; these tests pin them so a refactor can't quietly move them.
 */

import { describe, expect, it } from "vitest";
import { cliArgsFor } from "../src/backend.js";
import { backendLabel, detectBackend, parseBackendArg } from "../src/detect.js";

describe("parseBackendArg", () => {
	it("parses a bare backend name (no model)", () => {
		expect(parseBackendArg("codex")).toEqual({ type: "cli", command: "codex", model: undefined });
		expect(parseBackendArg("anthropic")).toEqual({ type: "http", provider: "anthropic", model: undefined });
	});

	it("parses a name:model spec for CLI and HTTP", () => {
		expect(parseBackendArg("codex:gpt-5-codex")).toEqual({ type: "cli", command: "codex", model: "gpt-5-codex" });
		expect(parseBackendArg("anthropic:claude-opus-4-8")).toEqual({
			type: "http",
			provider: "anthropic",
			model: "claude-opus-4-8",
		});
	});

	it("splits on the first colon only", () => {
		// Defensive — model IDs don't contain a colon today, but don't lose the rest.
		expect(parseBackendArg("codex:a:b").model).toBe("a:b");
	});

	it("treats an unknown name as a custom CLI command, model and all", () => {
		expect(parseBackendArg("my-advisor:v2")).toEqual({ type: "cli", command: "my-advisor", model: "v2" });
	});
});

describe("cliArgsFor — model flag injection", () => {
	it("returns the preset unchanged when no model is pinned", () => {
		expect(cliArgsFor("codex")).toEqual(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
	});

	it("injects --model after `exec` for codex", () => {
		expect(cliArgsFor("codex", "gpt-5-codex")).toEqual([
			"exec",
			"--model",
			"gpt-5-codex",
			"--sandbox",
			"read-only",
			"--skip-git-repo-check",
			"-",
		]);
	});

	it("injects --model before -p for claude", () => {
		expect(cliArgsFor("claude", "claude-opus-4-8")).toEqual(["--model", "claude-opus-4-8", "-p"]);
	});

	it("injects --model after `run` for opencode", () => {
		expect(cliArgsFor("opencode", "anthropic/claude-opus-4-8")).toEqual([
			"run",
			"--model",
			"anthropic/claude-opus-4-8",
		]);
	});
});

describe("detectBackend — model threads through", () => {
	it("carries a pinned model onto a resolved CLI backend", () => {
		const backend = detectBackend(parseBackendArg("codex:gpt-5-codex"));
		expect(backend).toMatchObject({ type: "cli", command: "codex", model: "gpt-5-codex" });
	});

	it("uses the current anthropic default when no model is pinned", () => {
		const backend = detectBackend(parseBackendArg("anthropic"));
		expect(backend).toMatchObject({ type: "http", provider: "anthropic", model: "claude-opus-4-8" });
	});
});

describe("backendLabel", () => {
	it("shows the model alongside a CLI command when pinned", () => {
		expect(backendLabel({ type: "cli", command: "codex", model: "gpt-5-codex" })).toBe("codex:gpt-5-codex");
		expect(backendLabel({ type: "cli", command: "codex" })).toBe("codex");
	});
});
