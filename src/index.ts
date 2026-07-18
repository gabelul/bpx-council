#!/usr/bin/env node
/**
 * bpx-council — a portable multi-model council CLI.
 *
 * Usage:
 *   bpx-council "Should I use REST or GraphQL?"
 *   echo "context here" | bpx-council --question "Is this sane?"
 *   bpx-council --mode council --question "Architecture decision"
 *
 * Reads context from stdin (if piped) or uses the question alone. Routes the
 * fitted context to an advisor model (via a CLI backend like codex/claude, or
 * HTTP), prints the verdict to stdout. Designed to be called by any coding
 * agent (Claude Code, Codex, Cursor, pi) or a human at the terminal.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { loadConfig, type BpxCouncilConfig } from "./config.js";
import { runSolo } from "./solo.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Arg parsing — minimal, no dep. Flags + a positional question.
// ---------------------------------------------------------------------------

interface CliArgs {
	question: string | undefined;
	mode: "solo" | "council" | "debate" | "gut-check";
	configPath: string | undefined;
	help: boolean;
}

function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = { question: undefined, mode: "solo", configPath: undefined, help: false };
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--mode" || a === "-m") args.mode = (argv[++i] as CliArgs["mode"]) ?? "solo";
		else if (a === "--config" || a === "-c") args.configPath = argv[++i];
		else if (!a.startsWith("-") && !args.question) args.question = a;
	}
	return args;
}

const HELP = `bpx-council — a portable multi-model council CLI.

Usage:
  bpx-council "Should I use REST or GraphQL?"
  echo "code/context here" | bpx-council --question "Is this auth flow sane?"
  bpx-council --mode council "Architecture: monolith or microservices?"

Options:
  -m, --mode <mode>    solo (default) | council | debate | gut-check
  -c, --config <path>  Path to config file (default: ~/.bpx-council.json)
  -h, --help           Show this help

Context:
  If stdin is piped, it's read as conversation context and fitted to the
  advisor's window before being sent. If not, only the question is sent.

Config:
  ~/.bpx-council.json — defines advisor models, personas, backends.
  See --help config (TODO) for the schema. For now, if no config exists,
  bpx-council uses sensible defaults (codex CLI if available).`;

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
		// If no question arg, try reading from stdin (piped context might contain it).
		// For now, require a question.
		console.error("Error: a question is required. Pass it as an argument or use --help.");
		process.exit(1);
	}

	// Read piped stdin as context (if available).
	let stdinContext = "";
	if (!process.stdin.isTTY) {
		stdinContext = await readStream(process.stdin);
	}

	const config = loadConfig(args.configPath);

	const result = await runSolo({
		question: args.question,
		context: stdinContext || undefined,
		config,
	});

	if (!result.ok) {
		console.error(`Council failed: ${result.error}`);
		process.exit(1);
	}

	// Print the verdict to stdout — agents/humans read this.
	console.log(result.text);
}

function readStream(stream: NodeJS.ReadableStream): Promise<string> {
	return new Promise((resolve) => {
		let data = "";
		const rl = createInterface({ input: stream });
		rl.on("line", (line) => { data += line + "\n"; });
		rl.on("close", () => resolve(data.trim()));
		// Timeout: if no data in 100ms, assume no piped input.
		setTimeout(() => { rl.close(); }, 100);
	});
}

main().catch((e) => {
	console.error(`bpx-council: ${e instanceof Error ? e.message : String(e)}`);
	process.exit(1);
});
