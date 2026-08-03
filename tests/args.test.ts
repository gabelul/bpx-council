/**
 * Arg parsing tests.
 *
 * These exist because `--model` was documented in --help, declared in CliArgs,
 * and read in main() — but never parsed. An unrecognised flag fell through to
 * the bare-word branch, so `--model opus "Ship it?"` set the question to
 * "opus" and silently dropped the real one. You got a confident answer to a
 * question you never asked.
 */

import { describe, expect, it } from "vitest";
import { parseArgs } from "../src/args.js";

describe("parseArgs", () => {
	it("takes the question positionally", () => {
		expect(parseArgs(["Should I ship this?"]).question).toBe("Should I ship this?");
	});

	it("parses --model instead of eating the question", () => {
		const args = parseArgs(["--model", "opus", "Should I ship this?"]);
		expect(args.model).toBe("opus");
		expect(args.question).toBe("Should I ship this?");
	});

	it("parses --rounds and --timeout as numbers", () => {
		const args = parseArgs(["--rounds", "3", "--timeout", "300000", "Q"]);
		expect(args.rounds).toBe(3);
		expect(args.timeoutMs).toBe(300_000);
		expect(args.question).toBe("Q");
	});

	it("ignores non-numeric --rounds rather than passing NaN downstream", () => {
		expect(parseArgs(["--rounds", "lots", "Q"]).rounds).toBeUndefined();
	});

	it("collects unknown flags instead of swallowing them", () => {
		const args = parseArgs(["--nope", "value", "Real question"]);
		expect(args.unknown).toContain("--nope");
		// The flag's argument still lands in the question slot — parse order
		// alone can't tell "value" from a real question. That's exactly why
		// main() refuses to run when `unknown` is non-empty: the recorded flag
		// is what makes this safe, not the parse.
		expect(args.question).toBe("value");
	});

	it("keeps short flags working", () => {
		const args = parseArgs(["-m", "debate", "-b", "claude", "-q", "Q"]);
		expect(args.mode).toBe("debate");
		expect(args.backend).toBe("claude");
		expect(args.question).toBe("Q");
	});

	it("rejects an invalid --mode rather than quietly running solo", () => {
		// `--mode counsel` used to fall through to the solo branch: you'd pay
		// for one model and believe you'd run three.
		const args = parseArgs(["--mode", "counsel", "Q"]);
		expect(args.unknown.length).toBeGreaterThan(0);
		expect(args.mode).toBe("solo"); // unchanged default, but main() refuses
	});

	it("accepts every documented mode", () => {
		for (const mode of ["solo", "council", "debate", "gut-check"]) {
			const args = parseArgs(["--mode", mode, "Q"]);
			expect(args.mode).toBe(mode);
			expect(args.unknown).toHaveLength(0);
		}
	});

	it("reports help without needing a question", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
	});

	it("parses --version / -v without treating it as unknown", () => {
		expect(parseArgs(["--version"]).version).toBe(true);
		expect(parseArgs(["-v"]).version).toBe(true);
		expect(parseArgs(["--version"]).unknown).toHaveLength(0);
	});

	it("defaults to the consult command", () => {
		expect(parseArgs(["Should I ship this?"]).command).toBe("consult");
	});

	it("keeps the first bare word when several are passed", () => {
		// Unquoted shell input arrives as several argv entries; taking the first
		// is at least predictable.
		expect(parseArgs(["first", "second"]).question).toBe("first");
	});
});

describe("parseArgs — install subcommand", () => {
	it("recognises install in the first position", () => {
		expect(parseArgs(["install"]).command).toBe("install");
	});

	it("does not hijack 'install' inside a question", () => {
		// "Should I install Redis?" is a fair thing to ask the council. Only
		// argv[0] is treated as a subcommand.
		const args = parseArgs(["Should I install Redis?"]);
		expect(args.command).toBe("consult");
		expect(args.question).toBe("Should I install Redis?");
	});

	it("parses install flags", () => {
		const args = parseArgs(["install", "--agent", "codex", "--scope", "global", "--with-hook", "--yes"]);
		expect(args.install.agents).toEqual(["codex"]);
		expect(args.install.scope).toBe("global");
		expect(args.install.withHook).toBe(true);
		expect(args.install.yes).toBe(true);
	});

	it("accepts --agent repeated and comma-separated, de-duped", () => {
		const args = parseArgs(["install", "--agent", "codex,claude-code", "--agent", "codex"]);
		expect(args.install.agents).toEqual(["codex", "claude-code"]);
	});

	it("rejects an invalid --scope rather than silently defaulting", () => {
		const args = parseArgs(["install", "--scope", "everywhere"]);
		expect(args.install.scope).toBeUndefined();
		expect(args.unknown.length).toBeGreaterThan(0);
	});

	it("collects unknown install flags", () => {
		expect(parseArgs(["install", "--force"]).unknown).toContain("--force");
	});

	it("rejects --agent with no value instead of installing everything", () => {
		// Fail-open bug: an empty agent list reads as "no preference"
		// downstream, which installs every detected agent. Same shape as the
		// old --model swallow.
		const args = parseArgs(["install", "--agent"]);
		expect(args.install.agents).toEqual([]);
		expect(args.unknown.length).toBeGreaterThan(0);
	});

	it("does not treat a following flag as --agent's value", () => {
		const args = parseArgs(["install", "--agent", "--dry-run"]);
		expect(args.install.agents).toEqual([]);
		expect(args.install.dryRun).toBe(true); // still parsed as its own flag
		expect(args.unknown.length).toBeGreaterThan(0);
	});

	it("rejects --scope with no value", () => {
		const args = parseArgs(["install", "--scope"]);
		expect(args.install.scope).toBeUndefined();
		expect(args.unknown.length).toBeGreaterThan(0);
	});

	it("parses --link as an opt-in flag, off by default", () => {
		expect(parseArgs(["install"]).install.link).toBe(false);
		expect(parseArgs(["install", "--link"]).install.link).toBe(true);
	});

	it("supports install --help", () => {
		const args = parseArgs(["install", "--help"]);
		expect(args.command).toBe("install");
		expect(args.help).toBe(true);
	});

	it("defaults to no flags set for a bare install", () => {
		const args = parseArgs(["install"]);
		expect(args.install.agents).toEqual([]);
		expect(args.install.scope).toBeUndefined();
		expect(args.install.withHook).toBe(false);
		expect(args.install.dryRun).toBe(false);
	});
});

describe("parseArgs — config / setup subcommands", () => {
	it("recognises config and setup in the first position only", () => {
		expect(parseArgs(["config"]).command).toBe("config");
		expect(parseArgs(["setup"]).command).toBe("setup");
		// Not hijacked mid-question — "should I config this?" is a fair ask.
		expect(parseArgs(["should I config this?"]).command).toBe("consult");
	});

	it("parses config flags", () => {
		const args = parseArgs(["config", "--backend", "codex", "--model", "gpt-5-codex", "--mode", "council", "--yes"]);
		expect(args.configure.backend).toBe("codex");
		expect(args.configure.model).toBe("gpt-5-codex");
		expect(args.configure.mode).toBe("council");
		expect(args.configure.yes).toBe(true);
	});

	it("shares flags between config and setup", () => {
		const args = parseArgs(["setup", "--backend", "claude", "--dry-run"]);
		expect(args.command).toBe("setup");
		expect(args.configure.backend).toBe("claude");
		expect(args.configure.dryRun).toBe(true);
	});

	it("rejects a bad --mode and a missing --backend value", () => {
		expect(parseArgs(["config", "--mode", "counsel"]).unknown.length).toBeGreaterThan(0);
		expect(parseArgs(["config", "--backend"]).unknown.length).toBeGreaterThan(0);
	});

	it("parses --scope project/global and rejects anything else", () => {
		expect(parseArgs(["config", "--scope", "project"]).configure.scope).toBe("project");
		expect(parseArgs(["config", "--scope", "global"]).configure.scope).toBe("global");
		const bad = parseArgs(["config", "--scope", "repo"]);
		expect(bad.configure.scope).toBeUndefined();
		expect(bad.unknown.length).toBeGreaterThan(0);
	});

	it("supports --help and --config path", () => {
		expect(parseArgs(["config", "--help"]).help).toBe(true);
		expect(parseArgs(["config", "--config", "/tmp/x.json"]).configPath).toBe("/tmp/x.json");
	});
});

describe("--effort", () => {
	it("parses on a consult run", () => {
		expect(parseArgs(["--effort", "max", "Ship it?"]).effort).toBe("max");
	});

	it("parses on the config subcommand", () => {
		const args = parseArgs(["config", "--backend", "codex", "--effort", "xhigh", "--yes"]);
		expect(args.configure.effort).toBe("xhigh");
	});

	it("flags a missing value instead of swallowing the next token", () => {
		// `--effort "Ship it?"` must not eat the question, the same trap --model had.
		const args = parseArgs(["config", "--effort", "--yes"]);
		expect(args.unknown.join(" ")).toContain("--effort");
	});

	it("defaults to undefined so the backend keeps its own setting", () => {
		expect(parseArgs(["Ship it?"]).effort).toBeUndefined();
	});
});

describe("--file and --image", () => {
	it("collects repeated --file paths in order", () => {
		const args = parseArgs(["--file", "a.ts", "--file", "b.ts", "Do these agree?"]);
		expect(args.files).toEqual(["a.ts", "b.ts"]);
		expect(args.question).toBe("Do these agree?");
	});

	it("collects repeated --image paths", () => {
		expect(parseArgs(["--image", "one.png", "--image", "two.png", "Which?"]).images).toEqual(["one.png", "two.png"]);
	});

	it("accepts -f as the short form", () => {
		expect(parseArgs(["-f", "a.ts", "Review"]).files).toEqual(["a.ts"]);
	});

	it("flags a missing value instead of eating the question", () => {
		// `--file "Ship it?"` must not silently treat the question as a path.
		expect(parseArgs(["--file"]).unknown.join(" ")).toContain("--file");
		expect(parseArgs(["--image"]).unknown.join(" ")).toContain("--image");
	});

	it("defaults to empty lists", () => {
		const args = parseArgs(["Ship it?"]);
		expect(args.files).toEqual([]);
		expect(args.images).toEqual([]);
	});
});
