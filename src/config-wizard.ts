/**
 * config-wizard — interactive setup for ~/.bpx-council.json.
 *
 * The tool works with zero config (auto-detect picks a backend), so this isn't
 * onboarding you have to pass through — it's the optional deepening for people
 * who want to pin a specific backend/model, save a multi-model council, or
 * change the default mode. Interactive by default; flags drive it headless.
 *
 * It configures the tool's OWN advisor. Wiring bpx-council into your coding
 * agents is a separate concern — that's `install`. `setup` runs both.
 */

import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { MODES, type Mode } from "./args.js";
import { type BackendConfig, type BpxCouncilConfig, configPath, projectConfigWritePath } from "./config.js";
import { availableBackends, parseBackendArg, type AvailableBackend } from "./detect.js";
import { listModels } from "./models-list.js";
import { runConfirm, runFilterSelect, runInput, runSelect } from "./select.js";
import { bold, cyan, dim, green, red, yellow } from "./style.js";

/** Council personas, in the order the council assigns backends. */
const PERSONAS = ["architect", "critic", "simplifier"] as const;

export interface ConfigOptions {
	/** Advisor backend name, e.g. "codex" (headless). */
	backend?: string;
	/** Advisor model to pin (headless). */
	model?: string;
	/** Default mode (headless). */
	mode?: Mode;
	/** Which file to write: project `.bpx-council.json` or the global one. */
	scope?: "project" | "global";
	yes?: boolean;
	dryRun?: boolean;
	/** Override the config path outright (wins over scope; mainly for tests). */
	configPath?: string;
	/** Project root context for project-scope writes. Defaults to process.cwd(). */
	cwd?: string;
}

/** The file the wizard reads and writes, given the options. */
function targetPath(opts: ConfigOptions): string {
	if (opts.configPath) return opts.configPath;
	if (opts.scope === "project") return projectConfigWritePath(opts.cwd ?? process.cwd());
	return configPath();
}

/** The answers the wizard gathers, before they're turned into a config. */
export interface Answers {
	mode: Mode;
	/** The advisor backend spec, e.g. "codex" or "codex:gpt-5-codex". */
	soloSpec: string;
	/** Council persona → backend spec, if the user set one up. */
	council?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Pure logic — building the config object, testable without any I/O
// ---------------------------------------------------------------------------

/**
 * Turn a `name` or `name:model` spec into a config-file BackendConfig.
 *
 * The wizard only offers cli/http backends, so those are the two shapes here.
 */
export function backendConfigFromSpec(spec: string): BackendConfig {
	const parsed = parseBackendArg(spec);
	if (parsed.type === "http") {
		const backend: BackendConfig = { type: "http", provider: parsed.provider as BackendConfig["provider"] };
		if (parsed.model) backend.model = parsed.model;
		return backend;
	}
	// cli (and anything unknown falls here — a custom advisor command)
	const backend: BackendConfig = { type: "cli", command: parsed.command ?? "codex" };
	if (parsed.model) backend.model = parsed.model;
	return backend;
}

/**
 * Merge the wizard's answers into any existing config.
 *
 * Pure and total — the same answers always produce the same object. Preserves
 * keys the wizard doesn't manage (contextWindow, solo.thinkingLevel, …); a
 * council step that ran replaces `council` outright, one that was skipped leaves
 * the existing council untouched.
 */
export function buildConfig(answers: Answers, existing?: BpxCouncilConfig): BpxCouncilConfig {
	const solo: BpxCouncilConfig["solo"] = {
		model: existing?.solo?.model ?? "auto",
		backend: backendConfigFromSpec(answers.soloSpec),
	};
	if (existing?.solo?.thinkingLevel) solo.thinkingLevel = existing.solo.thinkingLevel;

	const config: BpxCouncilConfig = {
		...existing,
		defaultMode: answers.mode,
		solo,
	};

	if (answers.council && Object.keys(answers.council).length > 0) {
		config.council = { backends: answers.council };
	} else if (existing?.council) {
		config.council = existing.council;
	}
	return config;
}

// ---------------------------------------------------------------------------
// I/O
// ---------------------------------------------------------------------------

/** Write the config, tmp-then-rename so a crash can't leave it truncated. */
function writeConfigFile(path: string, config: BpxCouncilConfig): void {
	const tmp = `${path}.bpx-council-tmp`;
	try {
		writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
		renameSync(tmp, path);
	} catch (e) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			// Best-effort cleanup.
		}
		throw e;
	}
}

/** Read the existing config, or a refusal if it's there but unparseable. */
function readExisting(path: string): { ok: true; config?: BpxCouncilConfig } | { ok: false } {
	if (!existsSync(path)) return { ok: true };
	try {
		return { ok: true, config: JSON.parse(readFileSync(path, "utf-8")) as BpxCouncilConfig };
	} catch {
		return { ok: false };
	}
}

/** The current advisor backend name, for the default in the picker. */
function currentBackendName(existing: BpxCouncilConfig | undefined, available: AvailableBackend[]): string {
	const b = existing?.solo?.backend;
	const name = b?.type === "http" ? b.provider : b?.command;
	if (name && available.some((a) => a.name === name)) return name;
	return available[0]?.name ?? "codex";
}

function printPlan(path: string, config: BpxCouncilConfig): void {
	console.log(`\n${bold("Config")}  ${dim(path)}\n`);
	console.log(`  ${dim("mode")}     ${config.defaultMode}`);
	const b = config.solo.backend;
	const label = b?.type === "http" ? `${b.provider}${b.model ? ` (${b.model})` : ""}` : `${b?.command}${b?.model ? ` (${b.model})` : ""}`;
	console.log(`  ${dim("advisor")}  ${label ?? "auto-detect"}`);
	if (config.council?.backends) {
		console.log(`  ${dim("council")}`);
		for (const [persona, spec] of Object.entries(config.council.backends)) {
			console.log(`    ${dim(persona.padEnd(10))} ${spec}`);
		}
	}
}

// ---------------------------------------------------------------------------
// Pickers — the interactions the wizard needs, injected so production wires the
// real arrow-key / readline versions and tests script them deterministically.
// ---------------------------------------------------------------------------

export interface Pickers {
	/** Arrow-key single choice; the chosen value, or null on cancel. */
	select(header: string, options: { label: string; value: string }[], initial: number): Promise<string | null>;
	/** Type-to-filter over a long list; null = skip (use the default). */
	filterSelect(header: string, items: string[]): Promise<string | null>;
	/** Free-text line with a default. */
	ask(question: string, def: string): Promise<string>;
	/** Yes/no. */
	confirm(question: string, defaultYes: boolean): Promise<boolean>;
	/** A backend's models, or [] when it can't enumerate them. */
	listModels(backend: string): Promise<string[]>;
}

/**
 * Gather the wizard's answers through the injected pickers.
 *
 * Backend and mode are arrow-key selects. The model is a filterable list when
 * the backend can enumerate its models (codex, opencode, anthropic) and a
 * free-text field otherwise. Council stays free-text — it's the advanced path.
 */
export async function gatherAnswers(pickers: Pickers, available: AvailableBackend[], existing: BpxCouncilConfig | undefined): Promise<Answers> {
	// Backend — arrow-key select. Plain labels so width-clipping isn't fooled by ANSI.
	const backendOptions = available.map((b) => ({ label: `${b.name}  (${b.detail})`, value: b.name }));
	const backendDefault = Math.max(0, available.findIndex((b) => b.name === currentBackendName(existing, available)));
	const backendName = (await pickers.select("Advisor backend?", backendOptions, backendDefault)) ?? available[backendDefault].name;

	// Model — a filterable list where the backend supports it, else free text.
	let soloSpec = backendName;
	const models = await pickers.listModels(backendName);
	if (models.length > 0) {
		const picked = await pickers.filterSelect(`Model? (${models.length} available — type to filter, esc for the default)`, models);
		if (picked) soloSpec = `${backendName}:${picked}`;
	} else {
		const model = await pickers.ask("Pin a model? (blank = the backend's own default)", "");
		if (model) soloSpec = `${backendName}:${model}`;
	}

	// Mode — arrow-key select.
	const modeOptions = (MODES as readonly Mode[]).map((m) => ({ label: m, value: m }));
	const modeDefault = Math.max(0, MODES.indexOf(existing?.defaultMode ?? "solo"));
	const mode = ((await pickers.select("Default mode?", modeOptions, modeDefault)) ?? "solo") as Mode;

	// Council — advanced, free-text specs.
	let council: Record<string, string> | undefined;
	if (await pickers.confirm("Set up a multi-model council? (assign a backend per persona)", false)) {
		council = {};
		for (const persona of PERSONAS) {
			const spec = await pickers.ask(`  ${persona} backend[:model]?`, soloSpec);
			const name = spec.split(":")[0];
			if (!available.some((b) => b.name === name)) {
				console.log(`    ${yellow("note")} ${dim(`"${name}" isn't detected right now — keeping it anyway.`)}`);
			}
			if (spec) council[persona] = spec;
		}
	}

	return { mode, soloSpec, council };
}

/**
 * The real pickers — every one raw-mode (arrow-key selects, a filterable model
 * list, a text field, a y/n). All the same input paradigm, so there's no
 * raw↔readline handoff to drop keystrokes on, and the whole wizard is drivable
 * from a single keystroke stream.
 */
const productionPickers: Pickers = {
	select: (header, options, initial) => runSelect(header, options, initial),
	filterSelect: (header, items) => runFilterSelect(header, items, { allowCustom: true }),
	ask: (question, def) => runInput(question, def),
	confirm: (question, defaultYes) => runConfirm(question, defaultYes),
	listModels,
};

/** Show the plan, then write (with an optional confirm). Shared by both paths. */
async function finalize(path: string, config: BpxCouncilConfig, dryRun: boolean, confirmFn?: () => Promise<boolean>): Promise<number> {
	printPlan(path, config);
	if (dryRun) {
		console.log(dim("\nDry run — nothing written."));
		return 0;
	}
	if (confirmFn && !(await confirmFn())) {
		console.log(dim("Cancelled."));
		return 0;
	}
	try {
		writeConfigFile(path, config);
	} catch (e) {
		console.error(red(`Couldn't write ${path}: ${e instanceof Error ? e.message : String(e)}`));
		return 1;
	}
	console.log(`\n${green("✓")} ${bold("Wrote")} ${dim(path)}`);
	console.log(dim("  Change it any time with `bpx-council config`, or edit the file directly."));
	return 0;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

/**
 * Run the config wizard. Interactive unless flags or a non-TTY say otherwise.
 *
 * @returns Process exit code.
 */
export async function runConfig(opts: ConfigOptions): Promise<number> {
	const available = availableBackends();
	if (available.length === 0) {
		console.error(red("No advisor backend found on this machine."));
		console.error(dim("Install a CLI (codex / claude / opencode) or set ANTHROPIC_API_KEY, then re-run."));
		return 1;
	}

	const isTty = process.stdin.isTTY === true;
	if (!isTty && !opts.yes && !opts.dryRun) {
		console.error("bpx-council config: not a terminal. Re-run with --yes (plus --backend/--mode/--scope) or --dry-run.");
		return 1;
	}

	// Interactive only with a terminal and no pre-answering flags.
	const interactive = isTty && !opts.yes && !opts.backend && !opts.mode;

	if (interactive) {
		console.log(`\n${bold(cyan("bpx-council"))} ${dim("· configure your advisor")}\n`);

		// Scope first — it decides which file we read and write. Skip the question
		// when it's already pinned (--scope or an explicit --config).
		let scope = opts.scope;
		if (!scope && !opts.configPath) {
			const picked = await productionPickers.select(
				"Save where?",
				[
					{ label: "This project  (.bpx-council.json in the repo)", value: "project" },
					{ label: "Global  (~/.bpx-council.json)", value: "global" },
				],
				1,
			);
			if (picked === null) {
				console.log(dim("Cancelled."));
				return 0;
			}
			scope = picked === "project" ? "project" : "global";
		}
		const path = targetPath({ ...opts, scope });

		const read = readExisting(path);
		if (!read.ok) return refuseUnparseable(path);

		const answers = await gatherAnswers(productionPickers, available, read.config);
		const config = buildConfig(answers, read.config);
		return await finalize(path, config, opts.dryRun ?? false, () => runConfirm("Write this config?", true));
	}

	// Headless: flags + existing at the chosen scope, no confirm.
	const path = targetPath(opts);
	const read = readExisting(path);
	if (!read.ok) return refuseUnparseable(path);
	const existing = read.config;

	const backendName = opts.backend ?? currentBackendName(existing, available);
	const config = buildConfig(
		{
			mode: opts.mode ?? existing?.defaultMode ?? "solo",
			soloSpec: opts.model ? `${backendName}:${opts.model}` : backendName,
			council: existing?.council?.backends, // headless keeps any existing council
		},
		existing,
	);
	return finalize(path, config, opts.dryRun ?? false);
}

function refuseUnparseable(path: string): number {
	console.error(red(`${path} isn't valid JSON — left untouched.`));
	console.error(dim("Fix or move it, then re-run."));
	return 1;
}
