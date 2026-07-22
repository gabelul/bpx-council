/**
 * args — CLI argument parsing.
 *
 * Split out of index.ts so it can be tested without importing the entrypoint,
 * which runs main() on load. Pure in, pure out: no I/O, no process.exit.
 */

/** The valid `--mode` values, as data so the parser can check against them. */
export const MODES = ["solo", "council", "debate", "gut-check"] as const;

export type Mode = (typeof MODES)[number];

/**
 * Subcommand. `consult` is the default and the historical behaviour — a bare
 * `bpx-council "question"` still works exactly as before.
 */
export type Command = "consult" | "install";

export interface InstallArgs {
	/** `--agent` may be repeated or comma-separated. Empty means "ask". */
	agents: string[];
	scope: "project" | "global" | undefined;
	withHook: boolean;
	yes: boolean;
	dryRun: boolean;
	/** Symlink skill dirs at one canonical copy instead of duplicating. */
	link: boolean;
}

export interface CliArgs {
	command: Command;
	/** Only meaningful when `command === "install"`. */
	install: InstallArgs;
	question: string | undefined;
	mode: Mode;
	configPath: string | undefined;
	backend: string | undefined;
	model: string | undefined;
	rounds: number | undefined;
	timeoutMs: number | undefined;
	/**
	 * Council mode: one backend per persona, in order.
	 * `--backends codex,claude,opencode` → architect, critic, simplifier.
	 */
	backends: string[] | undefined;
	help: boolean;
	/** Flags we don't recognise. The caller should refuse to run — see below. */
	unknown: string[];
}

export function parseArgs(argv: string[]): CliArgs {
	const args: CliArgs = {
		command: "consult",
		install: { agents: [], scope: undefined, withHook: false, yes: false, dryRun: false, link: false },
		question: undefined,
		mode: "solo",
		configPath: undefined,
		backend: undefined,
		model: undefined,
		rounds: undefined,
		timeoutMs: undefined,
		backends: undefined,
		help: false,
		unknown: [],
	};

	// Subcommands are recognised in the first position only. A bare "install"
	// later in the line belongs to the question — "should I install this?" is a
	// perfectly reasonable thing to ask the council, and hijacking it would be
	// the same class of bug as the old --model swallow.
	if (argv[0] === "install") {
		args.command = "install";
		return parseInstallArgs(argv.slice(1), args);
	}

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--mode" || a === "-m") {
			// Validate rather than cast. `--mode counsel` (a plausible typo)
			// used to fall through to the solo branch and answer as if nothing
			// were wrong — you'd pay for one model and think you ran three.
			const value = argv[++i];
			if (value !== undefined && (MODES as readonly string[]).includes(value)) args.mode = value as Mode;
			else args.unknown.push(`--mode ${value ?? ""}`.trim());
		}
		else if (a === "--config" || a === "-c") args.configPath = argv[++i];
		else if (a === "--backend" || a === "-b") args.backend = argv[++i];
		else if (a === "--question" || a === "-q") args.question = argv[++i];
		else if (a === "--model") args.model = argv[++i];
		else if (a === "--rounds") args.rounds = Number(argv[++i]) || undefined;
		else if (a === "--timeout") args.timeoutMs = Number(argv[++i]) || undefined;
		else if (a === "--backends") {
			// Comma-separated, trimmed. Empty entries dropped so "codex,,claude"
			// doesn't silently assign a blank backend to the critic.
			const specs = (argv[++i] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
			args.backends = specs.length > 0 ? specs : undefined;
		}
		// An unrecognised flag used to fall through to the bare-word branch
		// below, where its *argument* became the question and the real question
		// was dropped — `--model opus "Ship it?"` quietly asked "opus". Collect
		// them so the caller can refuse to run instead of guessing.
		else if (a.startsWith("-")) args.unknown.push(a);
		else if (!args.question) args.question = a;
	}

	return args;
}

/**
 * The value at `argv[i + 1]`, or undefined if there isn't one.
 *
 * A following token that starts with "-" counts as missing: `--agent
 * --dry-run` means someone forgot the agent name, not that they want an agent
 * called "--dry-run". The caller advances `i` only on a real value.
 */
function takeValue(argv: string[], i: number): string | undefined {
	const next = argv[i + 1];
	if (next === undefined || next.startsWith("-")) return undefined;
	return next;
}

/**
 * Flags for `bpx-council install`.
 *
 * All optional: bare `install` launches the wizard. These exist so CI and
 * dotfile scripts can run it headless.
 *
 * @param argv - Arguments after the `install` subcommand.
 * @param args - The partially built result to fill in.
 */
function parseInstallArgs(argv: string[], args: CliArgs): CliArgs {
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--agent") {
			// Repeatable and comma-separated both work: --agent codex --agent
			// claude-code is the same as --agent codex,claude-code.
			//
			// A missing value must not silently widen scope. `install --agent`
			// with nothing after it used to leave the list empty, which the
			// caller reads as "no preference" and installs everything detected
			// — the same fail-open shape as the old --model bug.
			const value = takeValue(argv, i);
			if (value === undefined) {
				args.unknown.push("--agent (missing value)");
				continue;
			}
			i++;
			args.install.agents.push(...value.split(",").map((s) => s.trim()).filter(Boolean));
		} else if (a === "--scope") {
			const value = takeValue(argv, i);
			if (value === undefined) {
				args.unknown.push("--scope (missing value)");
				continue;
			}
			i++;
			if (value === "project" || value === "global") args.install.scope = value;
			else args.unknown.push(`--scope ${value}`);
		} else if (a === "--with-hook") args.install.withHook = true;
		else if (a === "--link") args.install.link = true;
		else if (a === "-y" || a === "--yes") args.install.yes = true;
		else if (a === "--dry-run") args.install.dryRun = true;
		else args.unknown.push(a);
	}

	// De-dupe so --agent codex --agent codex doesn't plan the same write twice.
	args.install.agents = [...new Set(args.install.agents)];
	return args;
}
