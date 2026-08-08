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
import { listEfforts, listModels } from "./models-list.js";
import { printStarNudge } from "./nudge.js";
import { BAR, railIntro, railNote, railOutro, railStep } from "./rail.js";
import { runConfirm, runFilterSelect, runInput, runSelect, type SelectOption } from "./select.js";
import { bold, cyan, dim, green, red, yellow } from "./style.js";
import { kindBadge, label as themeLabel, MODE_HINTS, modeTone, value as themeValue } from "./theme.js";

/** Council personas, in the order the council assigns backends. */
const PERSONAS = ["architect", "critic", "simplifier"] as const;

export interface ConfigOptions {
	/** Advisor backend name, e.g. "codex" (headless). */
	backend?: string;
	/** Advisor model to pin (headless). */
	model?: string;
	/** Reasoning effort to pin (headless). */
	effort?: string;
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
		if (parsed.effort) backend.effort = parsed.effort;
		return backend;
	}
	// cli (and anything unknown falls here — a custom advisor command)
	const backend: BackendConfig = { type: "cli", command: parsed.command ?? "codex" };
	if (parsed.model) backend.model = parsed.model;
	if (parsed.effort) backend.effort = parsed.effort;
	return backend;
}

/**
 * Merge the wizard's answers into any existing config.
 *
 * Pure and total — the same answers always produce the same object. Preserves
 * keys the wizard doesn't manage (solo.thinkingLevel, custom entries, …); a
 * council step that ran replaces `council` outright, one that was skipped leaves
 * the existing council untouched.
 */
export function buildConfig(answers: Answers, existing?: BpxCouncilConfig): BpxCouncilConfig {
	const solo: BpxCouncilConfig["solo"] = {
		backend: backendConfigFromSpec(answers.soloSpec),
	};
	// Carry a legacy `model` forward if one is already in the file, but never
	// write a new one: it was decoration, and the model belongs on the backend.
	if (existing?.solo?.model) solo.model = existing.solo.model;
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

function printPlan(path: string, config: BpxCouncilConfig, rail = false): void {
	const b = config.solo.backend;
	const model = b?.model ? `  ${themeValue(b.model)}` : dim("  (its own default)");
	const kind = b?.type === "http" || b?.type === "cli" ? ` ${kindBadge(b.type)}` : "";
	const effort = b?.effort ? `  ${dim("effort")} ${themeValue(b.effort)}` : "";
	const label = `${b?.type === "http" ? b.provider : (b?.command ?? "auto-detect")}${kind}${model}${effort}`;

	const rows = [
		`${themeLabel("mode")}     ${modeTone(config.defaultMode)(config.defaultMode)}  ${dim(MODE_HINTS[config.defaultMode] ?? "")}`,
		`${themeLabel("advisor")}  ${label}`,
	];
	if (config.council?.backends) {
		rows.push(dim("council"));
		for (const [persona, spec] of Object.entries(config.council.backends)) {
			rows.push(`  ${dim(persona.padEnd(10))} ${spec}`);
		}
	}

	if (rail) {
		// On the rail the summary is just more rail — no second frame around it.
		console.log(`${dim(BAR)}  ${bold("Config")}  ${dim(prettyPath(path))}`);
		console.log(dim(BAR));
		for (const row of rows) console.log(`${dim(BAR)}  ${row}`);
		console.log(dim(BAR));
		return;
	}

	console.log(`\n  ${dim("┌")} ${bold("Config")}  ${dim(prettyPath(path))}`);
	console.log(`  ${dim("│")}`);
	for (const row of rows) console.log(`  ${dim("│")}  ${row}`);
	console.log(`  ${dim("└")}`);
}

// ---------------------------------------------------------------------------
// Pickers — the interactions the wizard needs, injected so production wires the
// real arrow-key / readline versions and tests script them deterministically.
// ---------------------------------------------------------------------------

/**
 * Wraps a question in the chrome that makes this feel like a wizard rather than
 * a series of unrelated prompts: how far along you are, where the answers are
 * going, and what you've already picked.
 *
 * Injected as a function so `gatherAnswers` stays testable — scripted pickers
 * ignore headers entirely, and without chrome the question passes through bare.
 */
export interface Chrome {
	/** Decorate a question just before it's asked. */
	ask(step: number, question: string): string;
	/** Record an answered step — the rail collapses it to a single line. */
	answered(question: string, answer: string, note?: string): void;
}

/**
 * Shorten a path for display: `./x` inside the current directory, `~/x` under
 * home, absolute otherwise.
 *
 * A project config prints as `./.bpx-council.json` rather than 90 characters of
 * absolute path — and the chrome line has a width budget to keep.
 */
export function prettyPath(path: string): string {
	const cwd = process.cwd();
	if (path.startsWith(`${cwd}/`)) return `./${path.slice(cwd.length + 1)}`;
	const home = process.env.HOME;
	return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
}

/** No chrome — the question, unchanged. Used by tests and the headless path. */
const plainChrome: Chrome = { ask: (_step, question) => question, answered: () => {} };

/**
 * Chrome for a rail-style run.
 *
 * Progress used to be dots and a breadcrumb trail crammed into every header.
 * The rail carries that itself — each answered question stays on screen as one
 * line — so all that is left here is a quiet step counter on the live question,
 * plus the collapsed line that replaces the block once it is answered.
 */
function makeRailChrome(total: number, offset = 0): Chrome {
	return {
		// A step of 0 means "extra question" — the council prompt hangs off the last
		// numbered step, and repeating its number reads like the wizard stalled.
		ask: (step, question) => (step > 0 ? `${bold(question)} ${dim(`· step ${offset + step} of ${total}`)}` : bold(question)),
		answered: (question, answer, note) => railStep(question, answer, note),
	};
}

export interface Pickers {
	/** Arrow-key single choice; the chosen value, or null on cancel. */
	select(header: string, options: SelectOption[], initial: number): Promise<string | null>;
	/** Type-to-filter over a long list; null = skip (use the default). */
	filterSelect(header: string, items: string[]): Promise<string | null>;
	/** Free-text line with a default. */
	ask(question: string, def: string): Promise<string>;
	/** Yes/no. */
	confirm(question: string, defaultYes: boolean): Promise<boolean>;
	/** A backend's models, or [] when it can't enumerate them. */
	listModels(backend: string): Promise<string[]>;
	/** A backend's reasoning levels for a model, or null when it has no such control. */
	listEfforts(backend: string, model?: string): Promise<{ levels: string[]; def?: string } | null>;
}

/**
 * Gather the wizard's answers through the injected pickers.
 *
 * Backend and mode are arrow-key selects. The model is a filterable list when
 * the backend can enumerate its models (codex, opencode, anthropic) and a
 * free-text field otherwise. Council stays free-text — it's the advanced path.
 */
export async function gatherAnswers(
	pickers: Pickers,
	available: AvailableBackend[],
	existing: BpxCouncilConfig | undefined,
	chrome: Chrome = plainChrome,
): Promise<Answers> {
	// Backend — arrow-key select. Plain labels so width-clipping isn't fooled by ANSI.
	const backendOptions = available.map((b) => ({ label: b.name, value: b.name, kind: b.kind, hint: b.detail }));
	const backendDefault = Math.max(0, available.findIndex((b) => b.name === currentBackendName(existing, available)));
	const backendName =
		(await pickers.select(chrome.ask(1, "Advisor backend?"), backendOptions, backendDefault)) ?? available[backendDefault].name;
	chrome.answered("Advisor backend", backendName, available.find((b) => b.name === backendName)?.detail);

	// Model — a filterable list where the backend supports it, else free text.
	let soloSpec = backendName;
	let chosenModel: string | undefined;
	const models = await pickers.listModels(backendName);
	if (models.length > 0) {
		const picked = await pickers.filterSelect(
			chrome.ask(2, `Which model? (${models.length} available — type to filter)`),
			models,
		);
		if (picked) soloSpec = `${backendName}:${picked}`;
		chosenModel = picked ?? undefined;
		chrome.answered("Model", picked ?? `${backendName} default`);
	} else {
		const model = await pickers.ask(chrome.ask(2, "Pin a model? (blank = the backend's own default)"), "");
		if (model) soloSpec = `${backendName}:${model}`;
		chosenModel = model || undefined;
		chrome.answered("Model", model || `${backendName} default`);
	}

	// Reasoning effort — only for backends that have such a control, and only
	// offering the levels this model actually accepts. Unnumbered like the council
	// question: it's conditional, and escape keeps the tool's own default.
	const efforts = await pickers.listEfforts(backendName, chosenModel);
	if (efforts && efforts.levels.length > 0) {
		const options = efforts.levels.map((l) => ({
			label: l,
			value: l,
			hint: l === efforts.def ? "this model's default" : undefined,
		}));
		const initial = Math.max(0, efforts.levels.indexOf(efforts.def ?? ""));
		const picked = await pickers.select(chrome.ask(0, "Reasoning effort? (esc keeps the default)"), options, initial);
		if (picked) {
			soloSpec = `${soloSpec}@${picked}`;
			chrome.answered("Reasoning effort", picked);
		}
	}

	// Mode — arrow-key select.
	const modeOptions = (MODES as readonly Mode[]).map((m) => ({ label: m, value: m, tone: modeTone(m), hint: MODE_HINTS[m] }));
	const modeDefault = Math.max(0, MODES.indexOf(existing?.defaultMode ?? "solo"));
	const mode = ((await pickers.select(chrome.ask(3, "Default mode?"), modeOptions, modeDefault)) ?? "solo") as Mode;
	chrome.answered("Default mode", mode);

	// Council — advanced, free-text specs.
	let council: Record<string, string> | undefined;
	if (await pickers.confirm(chrome.ask(0, "Set up a multi-model council? (assign a backend per persona)"), false)) {
		council = {};
		for (const persona of PERSONAS) {
			const spec = await pickers.ask(`  ${persona} backend[:model]?`, soloSpec);
			const name = spec.split(":")[0];
			if (!available.some((b) => b.name === name)) {
				console.log(`    ${yellow("note")} ${dim(`"${name}" isn't detected right now — keeping it anyway.`)}`);
			}
			if (spec) council[persona] = spec;
		}
		chrome.answered("Council", Object.values(council).join(", ") || "none");
	} else {
		chrome.answered("Council", "no — one advisor");
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
	select: (header, options, initial) => runSelect(header, options, initial, { rail: true }),
	filterSelect: (header, items) => runFilterSelect(header, items, { allowCustom: true, rail: true }),
	ask: (question, def) => runInput(question, def, { rail: true }),
	confirm: (question, defaultYes) => runConfirm(question, defaultYes, { rail: true }),
	listModels,
	listEfforts,
};

/** Show the plan, then write (with an optional confirm). Shared by both paths. */
async function finalize(
	path: string,
	config: BpxCouncilConfig,
	dryRun: boolean,
	confirmFn?: () => Promise<boolean>,
	rail = false,
): Promise<number> {
	printPlan(path, config, rail);
	if (dryRun) {
		if (rail) railOutro([dim("Dry run — nothing written.")]);
		else console.log(dim("\nDry run — nothing written."));
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
	const saved = `${green("✓")} ${bold("Saved")} ${dim(prettyPath(path))}`;
	const tryIt = `${dim("Try it:")} ${cyan('bpx-council "Is this auth flow sane?"')}`;
	if (rail) {
		railOutro([saved, tryIt]);
	} else {
		console.log(`\n  ${saved}`);
		console.log(`  ${tryIt}`);
		console.log(`  ${dim("Change it any time with `bpx-council config`, or edit the file directly.")}`);
	}
	printStarNudge("this saved you some setup");
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
		console.error(dim("Install codex, claude or crush (the three verified working), or set ANTHROPIC_API_KEY, then re-run."));
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
		railIntro(bold(cyan("bpx-council")), "configure your advisor");

		// Scope first — it decides which file we read and write. Skip the question
		// when it's already pinned (--scope or an explicit --config).
		let scope = opts.scope;
		const asksScope = !scope && !opts.configPath;
		// Four questions when we ask about scope, three when it's already pinned.
		const total = asksScope ? 4 : 3;
		const scopeChrome = makeRailChrome(total);
		if (asksScope) {
			const picked = await productionPickers.select(
				scopeChrome.ask(1, "Save where?"),
				[
					{ label: "This project", value: "project", hint: ".bpx-council.json in the repo — commit it for the team" },
					{ label: "Global", value: "global", hint: "~/.bpx-council.json — every repo on this machine" },
				],
				1,
			);
			if (picked === null) {
				railOutro([dim("Cancelled.")]);
				return 0;
			}
			scope = picked === "project" ? "project" : "global";
		}
		const path = targetPath({ ...opts, scope });
		if (asksScope) scopeChrome.answered("Save where", scope === "project" ? "this project" : "global", prettyPath(path));

		const read = readExisting(path);
		if (!read.ok) return refuseUnparseable(path);

		// Re-running? Say what's already there, so it's clear this edits rather
		// than starts from scratch.
		if (read.config) {
			const b = read.config.solo?.backend;
			const current = b?.type === "http" ? b.provider : b?.command;
			railNote(`editing existing config${current ? ` · currently ${current}` : ""}`);
		}

		// The scope question, when asked, shifts everything gatherAnswers numbers.
		const chrome = makeRailChrome(total, asksScope ? 1 : 0);
		const answers = await gatherAnswers(productionPickers, available, read.config, chrome);
		const config = buildConfig(answers, read.config);
		return await finalize(path, config, opts.dryRun ?? false, () => runConfirm(bold("Write this config?"), true, { rail: true }), true);
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
			soloSpec: `${backendName}${opts.model ? `:${opts.model}` : ""}${opts.effort ? `@${opts.effort}` : ""}`,
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
