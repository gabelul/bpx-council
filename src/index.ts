#!/usr/bin/env node
/**
 * bpx-council — a portable multi-model council CLI.
 *
 * Usage:
 *   bpx-council "Should I use REST or GraphQL?"
 *   echo "context here" | bpx-council --question "Is this sane?"
 *   bpx-council --mode council "Architecture decision"
 *   bpx-council --mode debate "Rewrite the parser, or patch it?"
 *   bpx-council --mode gut-check "Does this smell off?"
 */

import { loadConfig } from "./config.js";
import { runSolo } from "./solo.js";
import { runCouncil } from "./council.js";
import { runDebate } from "./debate.js";

// ---------------------------------------------------------------------------
// Arg parsing
// ---------------------------------------------------------------------------

type Mode = "solo" | "council" | "debate" | "gut-check";

interface CliArgs {
	question: string | undefined;
	mode: Mode;
	configPath: string | undefined;
	help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { question: undefined, mode: "solo", configPath: undefined, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--mode" || a === "-m") args.mode = (argv[++i] as Mode) ?? "solo";
		else if (a === "--config" || a === "-c") args.configPath = argv[++i];
		else if (a === "--question" || a === "-q") args.question = argv[++i];
		else if (!a.startsWith("-") && !args.question) args.question = a;
	}
	return args;
}

const HELP = `bpx-council — a portable multi-model council CLI.

Usage:
  bpx-council "Should I use REST or GraphQL?"
  echo "code/context" | bpx-council --question "Is this auth flow sane?"
  bpx-council --mode council "Architecture: monolith or microservices?"
  bpx-council --mode debate "Rewrite the parser, or patch it?"
  bpx-council --mode gut-check "Does this smell off?"

Options:
  -m, --mode <mode>    solo (default) | council | debate | gut-check
  -q, --question <q>   The question (alternative to passing it positionally)
  -c, --config <path>  Path to config file (default: ~/.bpx-council.json)
  -h, --help           Show this help

Context:
  If stdin is piped, it's read as conversation context and prepended to the
  question before being sent to the advisor(s). If not, only the question is sent.

Modes:
  solo        One advisor model, one response. Fast, cheap, the default.
  council     Several models in parallel, each with a stance. A synthesizer
              merges their verdicts. For real decisions.
  debate      Advocate vs critic, sequential rounds, then a verdict. For
              contentious calls where you want the strongest case on both sides.
  gut-check   One advisor, terse output. The "does this smell off?" check.

Config:
  ~/.bpx-council.json defines the advisor model and backend. Defaults to the
  codex CLI (uses your ChatGPT subscription — no API key needed).`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	if (args.help) {
		console.log(HELP);
		return;
	}

	if (!args.question) {
		console.error("Error: a question is required. Pass it as an argument or use --help.");
		process.exit(1);
	}

	// Read piped stdin as context.
	let stdinContext = "";
	if (!process.stdin.isTTY) {
		stdinContext = await readStdin();
	}

	const config = loadConfig(args.configPath);
	const commonArgs = { question: args.question, context: stdinContext || undefined, config };

	let result: { ok: true; text: string } | { ok: false; error: string };

	switch (args.mode) {
		case "council": {
			const r = await runCouncil(commonArgs);
			result = r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error };
			break;
		}
		case "debate": {
			const r = await runDebate(commonArgs);
			result = r;
			break;
		}
		case "gut-check": {
			// Gut-check = solo with terse instruction.
			const r = await runSolo({
				...commonArgs,
				question: `${args.question}\n\n(Reply tersely — one or two sentences. Does this smell off?)`,
			});
			result = r;
			break;
		}
		default: {
			result = await runSolo(commonArgs);
			break;
		}
	}

	if (!result.ok) {
		console.error(`Council failed: ${result.error}`);
		process.exit(1);
	}

	console.log(result.text);
}

function readStdin(): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		process.stdin.setEncoding("utf-8");
		process.stdin.on("data", (chunk) => { data += chunk; });
		process.stdin.on("end", () => resolve(data.trim()));
		// If no data in 200ms, assume nothing piped.
		setTimeout(() => resolve(data.trim()), 200);
	});
}

main().catch((e) => {
	console.error(`bpx-council: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
