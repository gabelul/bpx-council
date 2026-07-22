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
