/**
 * cli-registry — the one place that knows how each advisor CLI is driven.
 *
 * Every CLI backend needs the same four facts: how to detect it, how to hand it
 * a prompt headlessly, whether its stdout is JSON we have to unwrap, and whether
 * it can list its own models. Those used to live in three different files as
 * parallel switch statements — add a tool and you'd edit `cliArgsFor`,
 * `availableBackends`, and `listModels` in lockstep, and drift was a matter of
 * time. Now it's one row per tool here, and those three functions read from it.
 *
 * Every invocation below was taken from the tool's own `--help`. Round-trip
 * verification (actually getting an answer back) is only proven for codex and
 * claude; the rest are wired-per-docs and marked so — same honesty bar as the
 * long-standing opencode caveat.
 */

/** Everything bpx-council needs to know to drive one advisor CLI. */
/** What a single invocation needs to know. */
export interface RunArgOpts {
	model?: string;
	effort?: string;
	/** Image paths, for backends that attach them as arguments. */
	images?: string[];
}

export interface CliBackendSpec {
	/** Binary name — both how we spawn it and how we detect it on PATH. */
	command: string;
	/** Friendly name for the wizard's backend picker (the value stays `command`). */
	label: string;
	/**
	 * How the prompt reaches the process:
	 *  - `"stdin"` — piped to stdin (codex reads `-`, claude/opencode read stdin).
	 *  - `"arg"`   — appended as the final argv entry. For the gemini-family and
	 *    amp that lands as the value of the trailing `-p`/`-x`; for cursor-agent
	 *    and crush it's a positional prompt. Either way the consuming flag is last
	 *    in `runArgs`, so appending the prompt does the right thing.
	 */
	prompt: "stdin" | "arg";
	/**
	 * Args for one headless prompt, with the model injected when pinned. The
	 * prompt (for `"arg"` delivery) is appended AFTER these — keep the flag that
	 * swallows it at the end.
	 */
	runArgs(opts: RunArgOpts): string[];
	/** stdout is JSONL wrapping the reply (codex/opencode). Plain text otherwise. */
	jsonl?: boolean;
	/** Whether pinning a model does anything — amp picks its own, so a pin is a no-op. */
	ignoresModel?: boolean;
	/** How to enumerate models, when the CLI can. Omit → the wizard asks for free text. */
	list?: { args: string[]; parse(stdout: string): string[] };
	/**
	 * How this CLI takes a reasoning-effort level, and which levels it accepts.
	 *
	 * Omit when the tool has no such control — the effort is then simply not
	 * passed, rather than guessed at with a flag the CLI would reject.
	 *
	 * `levels` is the static fallback list; codex overrides it per model, since
	 * its catalog reports what each one actually supports (gpt-5.6-sol goes to
	 * `ultra`, gpt-5.5 stops at `xhigh`).
	 */
	effort?: { levels: string[]; perModel?: boolean };
	/**
	 * How this backend takes images.
	 *
	 *  - `"attach"`  the CLI has an image flag; runArgs places the paths.
	 *  - `"read"`    no flag, but the agent will open a path given in the prompt.
	 *                Weaker: it depends on the tool's own file access, and if it
	 *                declines you get a confident answer about an unseen image.
	 *
	 * Omitted means no image support — better a clear error than a silent drop.
	 */
	images?: "attach" | "read";
}

/** Pull the pickable slugs out of `codex debug models` JSON (drops hidden ones). */
export function parseCodexModels(body: unknown): string[] {
	const models = (body as { models?: Array<{ slug?: unknown; visibility?: unknown }> })?.models ?? [];
	return models
		.filter((m) => m.visibility === "list")
		.map((m) => m.slug)
		.filter((slug): slug is string => typeof slug === "string");
}

/**
 * Reasoning levels codex reports for one model, plus its default.
 *
 * The catalog is per model — gpt-5.6-sol accepts `ultra`, gpt-5.5 stops at
 * `xhigh` — so offering a fixed list would let you pick something the model
 * rejects. Returns null when the model isn't in the catalog.
 */
export function parseCodexEfforts(body: unknown, model?: string): { levels: string[]; def?: string } | null {
	const models = (body as { models?: Array<Record<string, unknown>> })?.models ?? [];
	const hit = model ? models.find((m) => m.slug === model) : undefined;
	const target = hit ?? (model ? undefined : models.find((m) => m.visibility === "list"));
	if (!target) return null;
	const raw = (target.supported_reasoning_levels as Array<{ effort?: unknown }> | undefined) ?? [];
	const levels = raw.map((l) => l.effort).filter((e): e is string => typeof e === "string");
	if (levels.length === 0) return null;
	return { levels, def: typeof target.default_reasoning_level === "string" ? target.default_reasoning_level : undefined };
}

/**
 * Whether a codex model accepts image input, per its catalog.
 *
 * Returns null when the model isn't listed — unknown is not the same as "no",
 * and refusing to run on a model we simply don't recognise would be worse than
 * letting the attempt through.
 */
export function codexModelTakesImages(body: unknown, model?: string): boolean | null {
	const models = (body as { models?: Array<Record<string, unknown>> })?.models ?? [];
	const hit = model ? models.find((m) => m.slug === model) : undefined;
	if (!hit) return null;
	const modalities = hit.input_modalities;
	if (!Array.isArray(modalities)) return null;
	return modalities.includes("image");
}

/** One `provider/model` (or bare model) per line — opencode, crush, cursor-agent. */
export function parseLineList(stdout: string): string[] {
	return stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

/**
 * The known advisor CLIs. codex/claude/opencode were here first; cursor-agent,
 * gemini, qwen, crush, and amp were added off their `--help` interfaces.
 */
export const CLI_BACKENDS: Record<string, CliBackendSpec> = {
	// --- Round-trip verified ---
	codex: {
		command: "codex",
		label: "Codex CLI",
		prompt: "stdin",
		jsonl: true,
		// codex exec [--model M] --sandbox read-only --skip-git-repo-check -   (prompt on stdin)
		images: "attach",
		runArgs: ({ model: m, effort: e, images = [] }) => [
			"exec",
			// -i is repeatable; codex attaches each to the initial prompt.
			...images.flatMap((p) => ["-i", p]),
			// -c is a config override, not a flag codex parses per-subcommand; unquoted
			// is deliberate — it fails TOML parsing and codex keeps the raw string.
			...(e ? ["-c", `model_reasoning_effort=${e}`] : []),
			...(m ? ["--model", m] : []),
			"--sandbox",
			"read-only",
			"--skip-git-repo-check",
			"-",
		],
		// codex enumerates itself, resolving its own provider/auth — no config parsing on our side.
		list: { args: ["debug", "models"], parse: (s) => parseCodexModels(JSON.parse(s)) },
		// codex has no --effort flag; effort is a config override. Unquoted is fine —
		// it fails TOML parsing and codex falls back to the raw string, which is what
		// we want. Verified against a live `codex exec` call.
		effort: { levels: ["low", "medium", "high", "xhigh"], perModel: true },
	},
	claude: {
		command: "claude",
		label: "Claude CLI",
		prompt: "stdin",
		// claude [--model M] [--effort L] -p   (prompt on stdin). No model-list command.
		runArgs: ({ model: m, effort: e }) => [...(m ? ["--model", m] : []), ...(e ? ["--effort", e] : []), "-p"],
		effort: { levels: ["low", "medium", "high", "xhigh", "max"] },
		// No image flag — claude opens a path mentioned in the prompt with its own
		// Read tool. Verified working, but it's the agent fetching the file, not us
		// handing it over.
		images: "read",
	},

	// --- Wired per --help, round-trip UNVERIFIED (confirm before advertising) ---
	opencode: {
		command: "opencode",
		label: "OpenCode",
		prompt: "stdin",
		jsonl: true,
		// opencode run [--model M]   (message on stdin).
		runArgs: ({ model: m }) => ["run", ...(m ? ["--model", m] : [])],
		list: { args: ["models"], parse: parseLineList },
	},
	"cursor-agent": {
		command: "cursor-agent",
		label: "Cursor",
		prompt: "arg",
		// cursor-agent [--model M] --output-format text -p "<prompt>"   (-p is print mode; prompt positional).
		runArgs: ({ model: m }) => [...(m ? ["--model", m] : []), "--output-format", "text", "-p"],
		// `cursor-agent models` lists per account (empty when the account has none → free text).
		list: { args: ["models"], parse: parseLineList },
	},
	gemini: {
		command: "gemini",
		label: "Gemini CLI",
		prompt: "arg",
		// gemini [-m M] -p "<prompt>"   (-p takes the prompt as its value, so it goes last).
		runArgs: ({ model: m }) => [...(m ? ["-m", m] : []), "-p"],
	},
	qwen: {
		command: "qwen",
		label: "Qwen Code",
		prompt: "arg",
		// qwen [-m M] -p "<prompt>"   (gemini-cli fork, same shape).
		runArgs: ({ model: m }) => [...(m ? ["-m", m] : []), "-p"],
	},
	crush: {
		command: "crush",
		label: "Crush",
		prompt: "arg",
		// crush run [-m M] "<prompt>"   (prompt positional after run).
		runArgs: ({ model: m }) => ["run", ...(m ? ["-m", m] : [])],
		// `crush models` → provider/model lines, same shape as opencode.
		list: { args: ["models"], parse: parseLineList },
	},
	amp: {
		command: "amp",
		label: "Amp",
		prompt: "arg",
		ignoresModel: true, // amp has no model flag — it answers on whatever it picks.
		// amp -x "<prompt>"   (execute mode; prompt is -x's value).
		//
		// Caveat, learned from a live smoke test: amp is an *executing* agent, and
		// in execute mode it blocks on a permission prompt unless you pass
		// --dangerously-allow-all (which lets it run any command). We deliberately
		// don't — a read-only second opinion has no business running commands — so
		// amp will hang on its confirmation and hit the timeout. Wired for
		// completeness; not recommended as an advisor.
		runArgs: () => ["-x"],
	},
};

/** The known CLI command names, in detection priority order (codex stays the default). */
export const KNOWN_CLI_COMMANDS = Object.keys(CLI_BACKENDS);

/**
 * How a backend takes images, or undefined when it can't.
 *
 * anthropic isn't a CLI, but it does take images over HTTP as base64 blocks, so
 * it answers here too — callers only care whether images are possible and how.
 */
export function imageSupport(name: string): "attach" | "read" | undefined {
	if (name === "anthropic") return "attach";
	return CLI_BACKENDS[name]?.images;
}

/** Registry entry for a known command, or `undefined` for a custom binary. */
export function cliSpec(command: string): CliBackendSpec | undefined {
	return CLI_BACKENDS[command];
}

/**
 * A spec for any command — the registry entry when known, otherwise a generic
 * best-effort one: prompt on stdin, `--model` up front if pinned, plain-text
 * output, no model list. Keeps custom advisor binaries working.
 */
export function cliSpecOrGeneric(command: string): CliBackendSpec {
	return (
		CLI_BACKENDS[command] ?? {
			command,
			label: command,
			prompt: "stdin",
			runArgs: ({ model: m }) => (m ? ["--model", m] : []),
		}
	);
}
