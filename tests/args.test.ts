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

	it("reports help without needing a question", () => {
		expect(parseArgs(["--help"]).help).toBe(true);
	});

	it("keeps the first bare word when several are passed", () => {
		// Unquoted shell input arrives as several argv entries; taking the first
		// is at least predictable.
		expect(parseArgs(["first", "second"]).question).toBe("first");
	});
});
