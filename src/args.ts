/**
 * args — CLI argument parsing.
 *
 * Split out of index.ts so it can be tested without importing the entrypoint,
 * which runs main() on load. Pure in, pure out: no I/O, no process.exit.
 */

export type Mode = "solo" | "council" | "debate" | "gut-check";

export interface CliArgs {
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

	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		if (a === "-h" || a === "--help") args.help = true;
		else if (a === "--mode" || a === "-m") args.mode = (argv[++i] as Mode) ?? "solo";
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
