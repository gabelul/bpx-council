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
import { runInstall } from "./install.js";
import { maybeNotifyUpdate, readPackageMeta } from "./update-check.js";

const HELP = `bpx-council — a portable multi-model council CLI.

Usage:
  bpx-council "Should I use REST or GraphQL?"
  echo "code/context" | bpx-council --question "Is this auth flow sane?"
  bpx-council --mode council "Architecture: monolith or microservices?"
  bpx-council --mode debate "Rewrite the parser, or patch it?"
  bpx-council --mode gut-check "Does this smell off?"

Commands:
  install              Wire bpx-council into the coding agents on this machine
                      (Claude Code skill + slash command, Codex skill,
                      AGENTS.md block). Interactive by default.
                      See "bpx-council install --help".

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
  -v, --version        Print the installed version and exit

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

const INSTALL_HELP = `bpx-council install — wire the council into your coding agents.

Installing the CLI teaches you it exists. It teaches your agent nothing —
agents discover capabilities from files in their own config tree. This puts
those files there.

Usage:
  bpx-council install                    Interactive wizard (recommended)
  bpx-council install --dry-run          Show the plan, write nothing
  bpx-council install --agent claude-code --scope global --yes

What gets written:
  Claude Code    skills/bpx-council/SKILL.md  (auto-triggers on "second
                 opinion", "council", "gut check")
                 commands/council.md          (/council slash command)
                 settings.json                (Stop hook, only with --with-hook)
  Codex          ~/.codex/skills/bpx-council/SKILL.md (global)
  agents-skills  .agents/skills/bpx-council/SKILL.md — the shared project
                 convention read by Cursor, Codex, Gemini CLI, Copilot,
                 OpenCode, Zed, and others (one copy, whole cluster)
  AGENTS.md      an instruction block, for anything that reads AGENTS.md

Options:
      --agent <id>   claude-code | codex | agents-skills | agents-md.
                    Repeatable, or comma-separated. Omit to be asked.
      --scope <s>    project (default) | global. Codex skills are global-only.
      --with-hook    Also add the Claude Code Stop hook. It gut-checks after
                    every turn, which costs a model call every turn — hence
                    opt-in.
      --link         Symlink each agent's skill dir at one canonical copy
                    (.agents/skills) instead of duplicating it — update once,
                    every agent sees it. Opt-in: symlinks are fragile on
                    Windows and in git clones, so copy is the default, and any
                    link that can't be made falls back to a copy.
  -y, --yes          Skip prompts, take the defaults.
      --dry-run      Print the plan and exit.
  -h, --help         This.

Files you own are never rewritten: settings.json gets a structural merge and
AGENTS.md gets a marker-delimited block, both idempotent. If either is in a
shape we don't recognise — unparseable JSON, a half-deleted block — the install
refuses and says so rather than guessing.

The skill and command files are ours, so a reinstall replaces them. The plan
marks those [overwrite] before writing, and --dry-run shows it without writing.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));

	// --version short-circuits everything, including the update check — you
	// asked what you have, not whether something newer exists.
	if (args.version) {
		console.log(readPackageMeta().version);
		return;
	}

	// `install` short-circuits everything below — it writes files instead of
	// asking a model anything, so none of the backend resolution applies.
	if (args.command === "install") {
		if (args.help) {
			console.log(INSTALL_HELP);
			return;
		}
		if (args.unknown.length > 0) {
			console.error(`Error: unknown option ${args.unknown.join(", ")}. See "bpx-council install --help".`);
			process.exit(1);
		}
		const code = await runInstall({
			agents: args.install.agents,
			scope: args.install.scope,
			withHook: args.install.withHook,
			yes: args.install.yes,
			dryRun: args.install.dryRun,
			link: args.install.link,
		});
		if (code !== 0) process.exit(code);
		return;
	}

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

	// The answer is already on stdout, so an update notice here adds no latency
	// to what you came for. Prints from cache, refreshes in a detached child —
	// see update-check. Non-blocking, stderr-only, never throws.
	maybeNotifyUpdate(readPackageMeta());
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
