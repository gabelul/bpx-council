/**
 * cli-registry tests.
 *
 * The registry is the single source of truth for how each advisor CLI is
 * invoked, so these pin the parts that would silently break a real call: the
 * exact args (with and without a pinned model), how the prompt is delivered, and
 * which tools can enumerate models. The flag positions come from each tool's
 * `--help`; a wrong one here means a broken subprocess in the field.
 */

import { describe, expect, it } from "vitest";
import { CLI_BACKENDS, cliSpec, cliSpecOrGeneric, parseLineList, unusableReason } from "../src/cli-registry.js";

describe("runArgs — per-tool invocation", () => {
	it("codex: model after exec, prompt on stdin", () => {
		const s = CLI_BACKENDS.codex;
		expect(s.prompt).toBe("stdin");
		expect(s.runArgs({})).toEqual(["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
		expect(s.runArgs({ model: "gpt-5-codex" })).toEqual([
			"exec",
			"--model",
			"gpt-5-codex",
			"--sandbox",
			"read-only",
			"--skip-git-repo-check",
			"-",
		]);
	});

	it("claude: model before -p, prompt on stdin", () => {
		expect(CLI_BACKENDS.claude.prompt).toBe("stdin");
		expect(CLI_BACKENDS.claude.runArgs({ model: "claude-opus-4-8" })).toEqual(["--model", "claude-opus-4-8", "-p"]);
	});

	it("opencode: model after run, prompt on stdin", () => {
		expect(CLI_BACKENDS.opencode.runArgs({ model: "anthropic/claude-opus-4-8" })).toEqual([
			"run",
			"--model",
			"anthropic/claude-opus-4-8",
		]);
	});

	it("cursor-agent: text output, -p last so the appended prompt is positional", () => {
		const s = CLI_BACKENDS["cursor-agent"];
		expect(s.prompt).toBe("arg");
		expect(s.runArgs({ model: "gpt-5" })).toEqual(["--model", "gpt-5", "--output-format", "text", "-p"]);
		expect(s.runArgs({}).at(-1)).toBe("-p"); // prompt is appended after this
	});

	it("gemini/qwen: -m up front, -p last to swallow the appended prompt", () => {
		for (const cmd of ["gemini", "qwen"] as const) {
			const s = CLI_BACKENDS[cmd];
			expect(s.prompt).toBe("arg");
			expect(s.runArgs({ model: "some-model" })).toEqual(["-m", "some-model", "-p"]);
			expect(s.runArgs({}).at(-1)).toBe("-p");
		}
	});

	it("crush: model after run, prompt positional", () => {
		expect(CLI_BACKENDS.crush.runArgs({ model: "zai/glm-5" })).toEqual(["run", "-m", "zai/glm-5"]);
	});

	it("amp: no model flag — a pinned model is a no-op", () => {
		const s = CLI_BACKENDS.amp;
		expect(s.ignoresModel).toBe(true);
		expect(s.runArgs({ model: "anything" })).toEqual(["-x"]); // model ignored on purpose
	});
});

describe("enumeration coverage", () => {
	it("lists models only for the CLIs that actually can", () => {
		const canList = (n: string) => Boolean(cliSpec(n)?.list);
		expect(canList("codex")).toBe(true);
		expect(canList("opencode")).toBe(true);
		expect(canList("crush")).toBe(true);
		expect(canList("cursor-agent")).toBe(true);
		// no `models` command → free text
		expect(canList("claude")).toBe(false);
		expect(canList("gemini")).toBe(false);
		expect(canList("qwen")).toBe(false);
		expect(canList("amp")).toBe(false);
	});

	it("codex's list command is the debug subcommand", () => {
		expect(cliSpec("codex")?.list?.args).toEqual(["debug", "models"]);
	});
});

describe("cliSpecOrGeneric — custom binaries still work", () => {
	it("falls back to a stdin, --model-first generic for an unknown command", () => {
		const s = cliSpecOrGeneric("my-advisor");
		expect(s.prompt).toBe("stdin");
		expect(s.jsonl).toBeUndefined();
		expect(s.runArgs({})).toEqual([]);
		expect(s.runArgs({ model: "v2" })).toEqual(["--model", "v2"]);
	});
});

describe("parseLineList", () => {
	it("keeps provider/model lines, drops blanks and whitespace", () => {
		expect(parseLineList("zai/glm-5\n\n  \nopenai/gpt-5\n")).toEqual(["zai/glm-5", "openai/gpt-5"]);
	});
});

describe("isolation from project instructions", () => {
	it("codex suppresses the project doc with a config override", () => {
		const args = CLI_BACKENDS.codex.runArgs({ isolate: true });
		expect(args.slice(0, 3)).toEqual(["exec", "-c", "project_doc_max_bytes=0"]);
	});

	it("codex passes nothing extra when not isolating", () => {
		expect(CLI_BACKENDS.codex.runArgs({}).join(" ")).not.toContain("project_doc_max_bytes");
	});

	it("claude takes the persona as a real system prompt when isolating", () => {
		const args = CLI_BACKENDS.claude.runArgs({ isolate: true, systemPrompt: "You are a critic." });
		expect(args).toEqual(["--system-prompt", "You are a critic.", "-p"]);
	});

	it("claude keeps its plain form when not isolating", () => {
		expect(CLI_BACKENDS.claude.runArgs({ systemPrompt: "You are a critic." })).toEqual(["-p"]);
	});

	it("only the backends that actually read project files declare isolation", () => {
		expect(CLI_BACKENDS.codex.isolation).toBe("config");
		expect(CLI_BACKENDS.claude.isolation).toBe("system-prompt");
		// crush was tested with a planted instruction and ignored it.
		expect(CLI_BACKENDS.crush.isolation).toBeUndefined();
	});
});

describe("unusable backends", () => {
	it("marks amp unusable with a reason that explains itself", () => {
		expect(unusableReason("amp")).toMatch(/dangerously-allow-all/);
	});

	it("leaves the working backends usable", () => {
		for (const cmd of ["codex", "claude", "crush", "opencode", "gemini", "qwen", "cursor-agent"]) {
			expect(unusableReason(cmd)).toBeUndefined();
		}
	});

	it("says nothing about a command it's never heard of", () => {
		expect(unusableReason("my-advisor")).toBeUndefined();
	});
});
