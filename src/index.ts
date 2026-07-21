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
import { detectBackend, parseBackendArg, type ExplicitBackend } from "./detect.js";
import { runSolo } from "./solo.js";
import { runCouncil } from "./council.js";
import { runDebate } from "./debate.js";
import { parseArgs, type Mode } from "./args.js";

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
  -b, --backend <name> Force a backend: codex, claude, opencode (CLI) or
                      anthropic, openai, google (HTTP via API key in env)
      --model <id>     Override the model (e.g. claude-opus-4-20250514).
                      Also reads BPX_COUNCIL_MODEL / ANTHROPIC_MODEL env vars.
      --rounds <n>     Debate rounds, 1-4 (default: 2). Each round is an
                      advocate turn plus a critic turn.
      --timeout <ms>   Per-call timeout (default: 120000). Raise it for long
                      debates on meaty questions.
      --backends <a,b> Council mode: one backend per persona, in order
                      (architect, critic, simplifier). This is what makes a
                      council genuinely multi-model:
                        --mode council --backends codex,claude,opencode
                      Personas without a backend use the default.
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

	// Refuse unknown flags rather than guessing. Silently ignoring one is how
	// `--model opus "Ship it?"` ended up asking the council "opus".
	if (args.unknown.length > 0) {
		console.error(`Error: unknown option ${args.unknown.join(", ")}. See --help.`);
		process.exit(1);
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

	// Auto-detect the backend if not explicitly configured. Override chain:
	// --backend arg > config file > env vars (ANTHROPIC_API_KEY etc.) > CLIs on
	// PATH > default (codex). This is what makes bpx-council work from any host:
	// Claude Code sets ANTHROPIC_API_KEY → HTTP; Codex has codex on PATH → CLI.
	if (args.backend || !config.solo.backend) {
		const explicit: ExplicitBackend | undefined = args.backend
			? parseBackendArg(args.backend)
			: undefined;
		config.solo.backend = detectBackend(explicit) as never;
	}

	// Model override: --model flag > BPX_COUNCIL_MODEL env > ANTHROPIC_MODEL env.
	// For HTTP backends, this sets which model the API call targets. For CLI
	// backends it's informational (the CLI picks its own model). This is how a
	// user running Claude Code on Sonnet can make the advisor use Opus, or match.
	const modelOverride = args.model ?? process.env.BPX_COUNCIL_MODEL ?? process.env.ANTHROPIC_MODEL;
	if (modelOverride && config.solo.backend && (config.solo.backend as { type: string }).type === "http") {
		(config.solo.backend as { model?: string }).model = modelOverride;
	}
	// --timeout raises the per-call ceiling. Debate makes up to nine sequential
	// calls, so the default 120s is the difference between a verdict and a
	// timeout on a meaty question.
	if (args.timeoutMs && config.solo.backend) {
		(config.solo.backend as { timeoutMs?: number }).timeoutMs = args.timeoutMs;
	}

	const commonArgs = { question: args.question, context: stdinContext || undefined, config };

	// `partial` is debate-only: rounds that completed before a later call failed.
	let result: { ok: true; text: string } | { ok: false; error: string; partial?: string };

	switch (args.mode) {
		case "council": {
			const r = await runCouncil({ ...commonArgs, backends: args.backends });
			result = r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error };
			break;
		}
		case "debate": {
			const r = await runDebate({ ...commonArgs, rounds: args.rounds });
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
		// Print salvaged work to stdout first so a pipe or redirect still
		// captures it, then fail loudly. Minutes of completed rounds shouldn't
		// vanish because the last call timed out.
		if (result.partial) console.log(result.partial);
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
