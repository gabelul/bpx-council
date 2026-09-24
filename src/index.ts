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

import { resolveConfig } from "./config.js";
import type { BackendConfig as AdvisorBackend } from "./backend.js";
import { buildFileContext, readTextAttachments, validateImages } from "./attachments.js";
import { imageSupport } from "./cli-registry.js";
import { detectBackend, parseBackendArg, resolveSeatBackend, textOnlyImageWarning, type ExplicitBackend } from "./detect.js";
import { runSolo } from "./solo.js";
import { runCouncil } from "./council.js";
import { runDebate } from "./debate.js";
import { parseArgs, type Mode } from "./args.js";
import { runInstall } from "./install.js";
import { runUninstall } from "./lifecycle.js";
import { maybeNotifyUpdate, readPackageMeta } from "./update-check.js";
import { maybeOnboard } from "./onboard.js";
import { runConfig } from "./config-wizard.js";
import { runSetup } from "./setup.js";
import { readStdin } from "./stdin.js";
import { runDoctor } from "./doctor.js";
import { addAttempt, newReceipt, settleReceipt, type Receipt } from "./receipt.js";

let activeReceipt: Receipt | undefined;

/** Print exactly one machine-readable object, leaving diagnostics on stderr. */
function printReceipt(receipt: Receipt): void {
	process.stdout.write(`${JSON.stringify(receipt)}\n`);
}

const HELP = `bpx-council — a portable multi-model council CLI.

Usage:
  bpx-council "Should I use REST or GraphQL?"
  echo "code/context" | bpx-council --question "Is this auth flow sane?"
  bpx-council --mode council "Architecture: monolith or microservices?"
  bpx-council --mode debate "Rewrite the parser, or patch it?"
  bpx-council --mode gut-check "Does this smell off?"

Commands:
  config               Configure default mode, advisor and Council/Debate
                      seat routes in ~/.bpx-council.json.
  setup                config, then offer to wire into your coding agents.
                      The one-command onboarding.
  doctor               Offline config, trust and effective route diagnostics.
                       --probe explicitly makes ONE bounded Solo smoke call.
  install              Install host instructions; --verify inspects offline.
  uninstall            Remove only exact bundled artifacts; edited files stay.
                      See "bpx-council install --help".

Options:
  -m, --mode <mode>    solo | council | debate | gut-check (config default if omitted)
      --format json    Consult only: one versioned JSON receipt on stdout
  -q, --question <q>   The question (alternative to passing it positionally)
      --isolate        Change Codex/Claude project instruction handling;
                       not a CLI filesystem sandbox
      --no-stdin       Ignore open stdin pipe; use when a calling harness won't close it
  -f, --file <path>    Attach a text file as context (repeatable)
      --image <path>   Attach an image (repeatable). codex and anthropic take
                       them directly. Other backends have no image input
                       and will refuse.
  -c, --config <path>  Explicit trusted config file; replaces repo discovery
  -b, --backend <name> Force a backend: codex, claude, opencode (CLI) or
                      anthropic (HTTP). openai/google HTTP aren't implemented.
      --model <id>     Override the model (e.g. claude-opus-4-20250514).
      --effort <level> Reasoning effort for backends that have one (codex,
                       claude): low, medium, high, xhigh, max. Ignored by the
                       rest. Per backend: --backends codex:gpt-5.6-sol@max
                      Also reads BPX_COUNCIL_MODEL / ANTHROPIC_MODEL env vars.
      --rounds <n>     Debate rounds, 1-4 (default: 2). Each round is an
                      advocate turn plus a critic turn.
      --timeout <ms>   Per-call timeout (default: 120000). Raise it for long
                      debates on meaty questions.
      --backends <a,b> Council: positional routes in roster order; extra specs
                      fail before calls. Default: architect, critic, simplifier.
      --synthesizer <s> Council or Debate: verdict backend[:model][@effort].
      --advocate <s>   Debate: advocate backend[:model][@effort].
      --critic <s>     Debate: critic backend[:model][@effort].
                      Unassigned seats use the shared --backend / Solo config.
                      Example: --mode debate --advocate codex:gpt-5.6-sol
                               --critic claude --synthesizer codex
  -h, --help           Show this help
  -v, --version        Print the installed version and exit

Context:
  Piped stdin must end within three seconds; otherwise the call fails. Use
  --no-stdin for harnesses that leave a pipe open. TTY skips stdin.

Modes:
  solo        One advisor model, one response. Fast, cheap, the default.
  council     Several stances in parallel, then a synthesizer. Separate models
              only when seat routes differ.
  debate      Advocate vs critic, sequential rounds, then a verdict. For
              contentious calls where you want the strongest case on both sides.
  gut-check   One advisor, terse output. Separate saved gutCheck.backend;
              explicit --backend wins, then saved gut-check, then Solo.

Config:
  ~/.bpx-council.json defines the advisor model and backend. Auto-detection
  uses Anthropic HTTP, Codex (read-only), or tool-disabled Claude CLI.
  Other CLIs need explicit trust. Advanced JSON: trusted personas definitions,
  council.members (ordered roster), gutCheck.backend and maxOutputTokens.
  Project auto-discovery permits bundled roster only, no custom prompts.
  HTTP maxOutputTokens sets max_tokens; CLI gets a prompt request only.`;

const CONFIG_HELP = `bpx-council config / setup — configure your advisor.

bpx-council auto-detects Anthropic HTTP, Codex (read-only), or tool-disabled
Claude CLI when available; other CLIs need an explicit trusted choice. This is the
optional deepening: pin a backend and model, assign Council/Debate seats, or
change the default mode — written to ~/.bpx-council.json.

  config   Just the advisor config.
  setup    config, then offer to wire bpx-council into your coding agents
           (runs the installer). The one-command onboarding.

Usage:
  bpx-council config                 Interactive wizard (recommended)
  bpx-council setup                  Configure, then offer agent install
  bpx-council config --dry-run       Show what it'd write, write nothing
  bpx-council config --backend codex --model gpt-5-codex --mode solo --yes

Options:
  -b, --backend <name>  Advisor backend: codex | claude | opencode | anthropic
      --model <id>      Pin the advisor's model (blank = the backend's default)
      --effort <level>  Pin the reasoning effort (codex, claude)
  -m, --mode <mode>     solo (default) | council | debate | gut-check
      --scope <s>       global (default, ~/.bpx-council.json) | project
                       (.bpx-council.json in the repo — commit it to share a
                       council with your team). At runtime, a project config
                       layers over global: it overrides only the keys it sets.
                       Project routes: Anthropic HTTP only; no
                       custom commands, args, tmux, or HTTP redirects.
  -c, --config <path>   Trusted file instead of project discovery (wins over --scope).
  -y, --yes             Skip prompts, take the flags/defaults.
      --dry-run         Print the plan and exit.
  -h, --help            This.

An existing config is merged, not clobbered — keys the wizard doesn't manage
(including personas, roster, gut-check, and backend-specific options) survive.
Edit advanced fields in JSON; the wizard doesn't offer pickers for them.
An unparseable config is refused, not overwritten. Seat routes are set up interactively; --yes writes
the core advisor config and keeps existing seat assignments.`;

const DOCTOR_HELP = `bpx-council doctor — offline route diagnostics.

Usage:
  bpx-council doctor                   Inspect config and all effective seat routes
  bpx-council doctor --config <path>   Inspect one trusted config instead of discovery
  bpx-council doctor --probe           ONE bounded Solo smoke call (may incur a charge)

Options:
      --probe           Explicit opt-in: one 10s call, 8 KiB CLI stdout cap or
                        32 HTTP output tokens. No Council/Debate fan-out.
  -c, --config <path>   Trusted config file; replaces repo discovery
  -h, --help            Show this help

Offline output reports local executable/key presence only, not authentication.
Probe uses read-only Codex, tool-disabled Claude, or Anthropic HTTP; custom
commands, args, endpoints and tmux are not probed. No response text printed.`;

const INSTALL_HELP = `bpx-council install — wire the council into your coding agents.

Installing the CLI teaches you it exists. It teaches your agent nothing —
agents discover capabilities from files in their own config tree. This puts
those files there.

Usage:
  bpx-council install                    Interactive wizard (recommended)
  bpx-council install --dry-run          Show the plan, write nothing
  bpx-council install --agent claude-code --scope global --yes
  bpx-council install --verify --agent claude-code --scope global
  bpx-council uninstall --agent claude-code --scope global --dry-run
  bpx-council uninstall --agent claude-code --scope global --yes

What gets written:
  Claude Code    .claude/skills and .claude/commands (or ~/.claude/)
  Codex          .agents/skills (project) or ~/.agents/skills (global)
  OpenCode       .opencode/skills and commands (project), or
                 ~/.config/opencode/skills and commands (global)
  agents-skills  .agents/skills project compatibility copy (manual choice)
  agents-md      project AGENTS.md instruction block

This installs host-readable files, not native host execution or cost tracking.
Old ~/.codex/skills/bpx-council copies are reported, not migrated.

Options:
      --agent <id>   claude-code | codex | opencode | agents-skills | agents-md.
                    Repeatable, or comma-separated. Omit to be asked.
      --scope <s>    project (default) | global.
      --with-hook    Retired. Fails without installing an every-Stop paid hook.
      --link         Symlink each agent's skill dir at one canonical copy
                    (.agents/skills) instead of duplicating it — update once,
                    every agent sees it. Opt-in: symlinks are fragile on
                    Windows and in git clones, so copy is the default, and any
                    link that can't be made falls back to a copy.
  -y, --yes          Skip prompts, take the defaults.
      --dry-run      Print plan without prompting or changing files.
      --verify       Install only: inspect selected host artifacts offline;
                     missing/drifted/current, no auth or model calls.
  -h, --help         This.

Uninstall uses same --agent, --scope, --yes and --dry-run selection. Without
--yes, mutation requires interactive confirmation. No prompt on dry run.
Only exact bundled bytes are removed. Edited files, extra skill entries,
foreign links, and malformed marker blocks are left untouched and reported.
Uninstall removes only exact retired bundled Claude Stop entries; install
never adds one. Other settings keys and hooks survive. Shared canonical skill
copies stay when another host link still points to them. Reinstall refuses
extra skill entries or foreign links; clean those up manually.`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
	const args = parseArgs(process.argv.slice(2));
	if (args.command === "consult" && args.format === "json") {
		activeReceipt = newReceipt();
		if (args.modeExplicit) activeReceipt.mode = args.mode;
		if (args.help || args.version) throw new Error("--format json cannot be combined with --help or --version");
	}

	if (args.command === "doctor") {
		if (args.unknown.length > 0) {
			console.error('Error: unknown option for doctor. See "bpx-council doctor --help".');
			process.exitCode = 1;
			return;
		}
		if (args.help) { console.log(DOCTOR_HELP); return; }
		process.exitCode = await runDoctor(args.configPath, process.cwd(), args.probe);
		return;
	}

	// --version short-circuits everything, including the update check — you
	// asked what you have, not whether something newer exists.
	if (args.version) {
		console.log(readPackageMeta().version);
		return;
	}

	// `install` short-circuits everything below — it writes files instead of
	// asking a model anything, so none of the backend resolution applies.
	if (args.command === "install" || args.command === "uninstall") {
		if (args.help) {
			console.log(INSTALL_HELP);
			return;
		}
		if (args.unknown.length > 0) {
			console.error(`Error: unknown option ${args.unknown.join(", ")}. See "bpx-council ${args.command} --help".`);
			process.exit(1);
		}
		const code = await (args.command === "install" ? runInstall : runUninstall)({
			agents: args.install.agents,
			scope: args.install.scope,
			withHook: args.install.withHook,
			yes: args.install.yes,
			dryRun: args.install.dryRun,
			verify: args.install.verify,
			link: args.install.link,
		});
		if (code !== 0) process.exit(code);
		return;
	}

	// `config` / `setup` short-circuit the same way — they write ~/.bpx-council.json
	// (and setup then offers the agent installer), not a model call.
	if (args.command === "config" || args.command === "setup") {
		if (args.help) {
			console.log(CONFIG_HELP);
			return;
		}
		if (args.unknown.length > 0) {
			console.error(`Error: unknown option ${args.unknown.join(", ")}. See "bpx-council ${args.command} --help".`);
			process.exit(1);
		}
		const configOpts = {
			backend: args.configure.backend,
			model: args.configure.model,
			effort: args.configure.effort,
			mode: args.configure.mode,
			scope: args.configure.scope,
			yes: args.configure.yes,
			dryRun: args.configure.dryRun,
			configPath: args.configPath,
			cwd: process.cwd(),
		};
		const code = args.command === "setup" ? await runSetup(configOpts) : await runConfig(configOpts);
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
		throw new Error(`Error: unknown option ${args.unknown.join(", ")}. See --help.`);
	}

	if (!args.question) {
		throw new Error("Error: a question is required. Pass it as an argument or use --help.");
	}

	// Attachments — files become context, images ride on the backend. Both are
	// validated before any model call, so a typo'd path fails in milliseconds
	// rather than after a two-minute council run.
	let fileContext = "";
	let imageData: ReturnType<typeof validateImages> = [];
	try {
		fileContext = buildFileContext(readTextAttachments(args.files));
		imageData = validateImages(args.images);
	} catch (e) {
		throw new Error(`Error: ${e instanceof Error ? e.message : String(e)}`);
	}

	// Reject untrusted project routes before waiting for stdin or calling any model.
	const config = resolveConfig(args.configPath, process.cwd());
	const mode = args.modeExplicit ? args.mode : config.defaultMode;
	if (activeReceipt) activeReceipt.mode = mode;
	const stdinContext = args.noStdin || process.stdin.isTTY ? "" : await readStdin();
	if ((args.advocate || args.critic) && mode !== "debate") {
		throw new Error("Error: --advocate and --critic require --mode debate.");
	}
	if (args.synthesizer && mode !== "council" && mode !== "debate") {
		throw new Error("Error: --synthesizer requires --mode council or debate.");
	}
	if (args.backends && mode !== "council") {
		throw new Error("Error: --backends requires --mode council.");
	}

	// Auto-detect the backend if not explicitly configured. Override chain:
	// --backend arg > config file > env vars (ANTHROPIC_API_KEY etc.) > CLIs on
	// PATH (Codex read-only or tool-disabled Claude). Other CLIs need explicit trust.
	if (args.backend || !config.solo.backend) {
		const explicit: ExplicitBackend | undefined = args.backend
			? parseBackendArg(args.backend)
			: undefined;
		config.solo.backend = detectBackend(explicit) as never;
	}

	// Model override: --model flag > BPX_COUNCIL_MODEL env > ANTHROPIC_MODEL env.
	// Applies to BOTH backend types now — HTTP sets the API model directly, CLI
	// gets it injected as the CLI's own --model flag (so `--backend codex --model
	// gpt-5-codex` really runs codex on that model). This is how a user on Claude
	// Code's Sonnet can make the advisor use Opus, or point codex at a model.
	// Effort: an explicit --effort wins, else the config's thinkingLevel acts as the
	// fallback for backends that support one. A backend that pinned its own with
	// `@level` keeps it — that's the more specific choice.
	const effortOverride = args.effort ?? config.solo.thinkingLevel;
	if (effortOverride && config.solo.backend) {
		const b = config.solo.backend as { effort?: string };
		if (args.effort || !b.effort) b.effort = effortOverride;
	}

	if (args.isolate && config.solo.backend) {
		(config.solo.backend as { isolate?: boolean }).isolate = true;
	}

	const modelOverride = args.model ?? process.env.BPX_COUNCIL_MODEL ?? process.env.ANTHROPIC_MODEL;
	if (modelOverride && config.solo.backend) {
		(config.solo.backend as { model?: string }).model = modelOverride;
	}
	// --timeout raises the per-call ceiling. Debate makes up to nine sequential
	// calls, so the default 120s is the difference between a verdict and a
	// timeout on a meaty question.
	if (args.timeoutMs && config.solo.backend) {
		(config.solo.backend as { timeoutMs?: number }).timeoutMs = args.timeoutMs;
	}

	// An explicit --backend wins; otherwise gut-check takes its own saved route.
	// Resolve before image checks so an unused Solo route never rejects an image.
	const gutBackend: AdvisorBackend | undefined = mode === "gut-check" && config.solo.backend
		? args.backend ? config.solo.backend as AdvisorBackend
			: resolveSeatBackend(config.gutCheck?.backend, config.solo.backend as AdvisorBackend,
				{ timeoutMs: args.timeoutMs, isolate: args.isolate })
		: undefined;
	if (gutBackend?.type === "http" && config.gutCheck?.maxOutputTokens !== undefined) {
		gutBackend.maxOutputTokens = config.gutCheck.maxOutputTokens;
	}

	// Images need a backend that actually takes them. Refuse loudly rather than
	// dropping them — a confident answer about an image the model never saw is
	// the worst possible outcome here.
	if (args.images.length > 0) {
		// Multi-seat modes validate and attach images on each resolved route before
		// the first call; Solo only needs the shared backend checked here.
		if (mode === "solo" || mode === "gut-check") {
			const backend = (mode === "gut-check" ? gutBackend : config.solo.backend) as { type?: string; command?: string; provider?: string; model?: string; images?: string[]; imageData?: typeof imageData } | undefined;
			const command = backend?.type === "http" ? backend.provider : backend?.command;
			const support = backend?.type === "tmux" ? undefined : command ? imageSupport(command) : undefined;
			if (!support) {
				throw new Error(`Error: ${command ?? "this backend"} can't take images. Try: codex or anthropic.`);
			}
			if (support === "attach") {
				if (backend) backend.images = args.images;
				if (backend?.type === "http") backend.imageData = imageData;
			}
			const warning = backend ? textOnlyImageWarning(backend as AdvisorBackend) : undefined;
			if (warning) console.error(warning);
		}
		// HTTP gets frozen bytes; Codex CLI gets a path (weaker, documented).
		fileContext = `${fileContext ? `${fileContext}\n\n` : ""}Images to look at: ${args.images.join(", ")}`;
	}

	const context = [fileContext, stdinContext].filter(Boolean).join("\n\n");
	const commonArgs = { question: args.question, context: context || undefined, config };
	const seatOptions = { timeoutMs: args.timeoutMs, isolate: args.isolate, images: args.images, imageData };
	const onAttempt = activeReceipt ? (attempt: Parameters<typeof addAttempt>[1]) => addAttempt(activeReceipt!, attempt) : undefined;
	const onPlan = activeReceipt ? (seats: Receipt["planned"]) => { activeReceipt!.planned = seats; } : undefined;

	// `partial` carries completed Council members or Debate rounds if synthesis fails.
	let result: { ok: true; text: string } | { ok: false; error: string; partial?: string };

	switch (mode) {
		case "council": {
			const r = await runCouncil({ ...commonArgs, backends: args.backends, synthesizer: args.synthesizer, seatOptions, onAttempt, onPlan });
			result = r.ok ? { ok: true, text: r.text } : { ok: false, error: r.error, partial: r.partial };
			break;
		}
		case "debate": {
			const r = await runDebate({ ...commonArgs, rounds: args.rounds, advocate: args.advocate, critic: args.critic,
				synthesizer: args.synthesizer, seatOptions, onAttempt, onPlan });
			result = r;
			break;
		}
		case "gut-check": {
			// CLI cannot enforce token ceilings; its bound is an instruction only.
			const limit = config.gutCheck?.maxOutputTokens;
			const capInstruction = gutBackend?.type !== "http" && limit
				? ` Aim for at most ${limit} output tokens; this is a prompt request, not an enforced limit.` : "";
			const r = await runSolo({
				...commonArgs,
				backend: gutBackend,
				seat: "gut-check",
				question: `${args.question}\n\n(Reply tersely — one or two sentences. Does this smell off?${capInstruction})`,
				onAttempt,
			});
			result = r;
			break;
		}
		default: {
			result = await runSolo({ ...commonArgs, onAttempt });
			break;
		}
	}

	if (activeReceipt) {
		printReceipt(settleReceipt(activeReceipt, result));
		if (!result.ok) process.exitCode = 1;
		return;
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

	// After the answer's on stdout: on a fresh interactive run with nothing
	// wired up, offer the wizard once. If it prompted, skip the update notice —
	// one post-answer interruption is plenty.
	const prompted = await maybeOnboard(process.cwd());
	if (!prompted) {
		// Prints from cache, refreshes in a detached child — see update-check.
		// Non-blocking, stderr-only, never throws.
		maybeNotifyUpdate(readPackageMeta());
	}
}

main().catch((e) => {
	// An unclosed input pipe must not keep Node alive after the stdin deadline.
	process.stdin.destroy();
	const message = e instanceof Error ? e.message : String(e);
	if (activeReceipt) printReceipt(settleReceipt(activeReceipt, { ok: false, error: message }));
	else console.error(message.startsWith("Error:") ? message : `bpx-council: ${message}`);
	process.exitCode = 1;
});
