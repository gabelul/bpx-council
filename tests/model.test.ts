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

describe("reasoning effort", () => {
	it("parses a backend:model@effort spec", () => {
		expect(parseBackendArg("codex:gpt-5.6-sol@max")).toEqual({
			type: "cli",
			command: "codex",
			model: "gpt-5.6-sol",
			effort: "max",
		});
	});

	it("parses effort without a model", () => {
		expect(parseBackendArg("claude@high")).toMatchObject({ command: "claude", model: undefined, effort: "high" });
	});

	it("splits effort from the last @, so a model id containing one survives", () => {
		expect(parseBackendArg("codex:some@model@low")).toMatchObject({ model: "some@model", effort: "low" });
	});

	it("injects codex's effort as a config override after exec", () => {
		const args = cliArgsFor("codex", "gpt-5.6-sol", "xhigh");
		expect(args.slice(0, 4)).toEqual(["exec", "-c", "model_reasoning_effort=xhigh", "--model"]);
	});

	it("injects claude's effort as its own flag", () => {
		expect(cliArgsFor("claude", undefined, "max")).toEqual(["--effort", "max", "-p"]);
	});

	it("ignores effort for backends with no such control", () => {
		// gemini has no reasoning flag — passing one must not invent an argument.
		expect(cliArgsFor("gemini", undefined, "high")).toEqual(["-p"]);
	});

	it("shows the effort in the council label", () => {
		expect(backendLabel({ type: "cli", command: "codex", model: "gpt-5.6-sol", effort: "max" })).toBe(
			"codex:gpt-5.6-sol@max",
		);
	});
});
