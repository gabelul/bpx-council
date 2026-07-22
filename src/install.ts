/**
 * install — wire bpx-council into the coding agents on this machine.
 *
 * The gap this closes: `npm i -g @booplex/bpx-council` gives you a binary and
 * teaches your agent nothing. Agents discover capabilities from files in their
 * own config tree. This walks those files into place.
 *
 * Interactive by default — detects what's installed, asks what to wire up,
 * shows the plan, waits for a yes. Flags turn it headless for CI.
 *
 * ## The one rule
 *
 * Two destinations are files the user already owns and may have edited by
 * hand: Claude Code's `settings.json` and the project's `AGENTS.md`. For those,
 * **anything we don't recognise is a refusal, never a rewrite.** A settings
 * root that isn't an object, a `hooks.Stop` that isn't an array, an AGENTS.md
 * with a start marker and no end — every one of those returns a `failed`
 * outcome that names the file and leaves it byte-for-byte untouched.
 *
 * That rule exists because the alternative was measured, not imagined: an
 * earlier cut of this file normalised odd shapes and wrote them back, which
 * silently deleted a user's unrelated Stop hook and, given a half-deleted
 * block, ate the rest of their AGENTS.md on the second run. See
 * docs/dev-docs/troubleshooting.md.
 *
 * The skill and command files are different — those are ours, and a reinstall
 * replaces them. The plan output says `overwrite` when it's about to.
 */

import {
	accessSync,
	chmodSync,
	constants,
	cpSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	statSync,
	symlinkSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { createInterface } from "node:readline/promises";
import { AGENTS, findAgent, TEMPLATES_ROOT, type AgentDef, type InstallAction, type Scope } from "./agents.js";
import { runMultiselect } from "./multiselect.js";

/** Markers that make the AGENTS.md block replaceable instead of duplicable. */
const BLOCK_START = "<!-- bpx-council:start -->";
const BLOCK_END = "<!-- bpx-council:end -->";

/**
 * Junk macOS leaves next to real files on non-HFS volumes (external drives,
 * SMB shares): AppleDouble `._name` sidecars and `.DS_Store`.
 *
 * Caught in testing — installing from a repo on an ExFAT drive dropped a
 * `._SKILL.md` into `.claude/skills/`, which is noise at best and a file the
 * host might try to parse as a second skill at worst.
 *
 * Splits on both separators rather than using `basename`, which is
 * platform-native: on macOS it wouldn't split a Windows path at all, so the
 * filter quietly became a no-op there and every sidecar copied through. Doing
 * it manually also means the behaviour is testable from any host.
 */
export function isPlatformJunk(path: string): boolean {
	const name = path.split(/[\\/]/).pop() ?? "";
	return name.startsWith("._") || name === ".DS_Store";
}

export interface InstallOptions {
	/** Agent ids to install. Empty/undefined means ask (or use all detected with --yes). */
	agents?: string[];
	scope?: Scope;
	/** Include opt-in actions like the Stop hook. */
	withHook?: boolean;
	/** Skip prompts — take the defaults and write. */
	yes?: boolean;
	/** Show the plan, write nothing. */
	dryRun?: boolean;
	/**
	 * Symlink each agent's skill dir at one canonical copy instead of
	 * duplicating it. Update once, every agent sees it. Opt-in, because
	 * symlinks are fragile across Windows, git clones, and Docker copies — copy
	 * mode (the default) is the safe universal choice.
	 */
	link?: boolean;
	cwd?: string;
}

/** What happened to one action, for the summary line. */
export type ActionOutcome = "created" | "updated" | "unchanged" | "failed";

export interface ActionResult {
	action: InstallAction;
	outcome: ActionOutcome;
	detail?: string;
}

/** What an action would do, computed before anything is written. */
export type ActionPreview = "create" | "overwrite" | "merge" | "current" | "blocked";

// ---------------------------------------------------------------------------
// Shape guards — the difference between merging and mangling
// ---------------------------------------------------------------------------

/** A JSON object, as opposed to an array, null, or a primitive. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Outcome of a merge or block edit.
 *
 * `ok: false` means "we didn't understand the file, so we didn't touch it" —
 * never "we tried and it broke". The caller surfaces `reason` to the user.
 */
export type EditResult<T> = { ok: true; value: T; changed: boolean } | { ok: false; reason: string };

// ---------------------------------------------------------------------------
// Pure logic — no I/O, so the fiddly bits are testable
// ---------------------------------------------------------------------------

/**
 * Merge our hook config into a user's existing settings.
 *
 * Preserves every key we didn't put there. Within each hook event our entry is
 * appended to the existing array rather than replacing it, so an unrelated
 * Stop hook keeps working.
 *
 * Refuses (rather than normalising) when the settings root isn't an object,
 * `hooks` isn't an object, or `hooks.<Event>` isn't an array. Each of those
 * used to fall through to a write that dropped the user's value on the floor.
 *
 * @param existing - Parsed contents of the user's settings.json, or undefined.
 * @param incoming - Parsed contents of our hooks template.
 * @returns The merged object, or a refusal naming the offending shape.
 */
export function mergeHookSettings(
	existing: unknown,
	incoming: Record<string, unknown>,
): EditResult<Record<string, unknown>> {
	if (existing !== undefined && !isPlainObject(existing)) {
		return { ok: false, reason: "settings root is not a JSON object" };
	}

	const base: Record<string, unknown> = { ...(existing ?? {}) };
	const incomingHooks = incoming.hooks;
	if (!isPlainObject(incomingHooks)) return { ok: true, value: base, changed: false };

	if (base.hooks !== undefined && !isPlainObject(base.hooks)) {
		return { ok: false, reason: '"hooks" is not an object' };
	}
	const currentHooks: Record<string, unknown> = { ...((base.hooks as Record<string, unknown>) ?? {}) };
	let changed = false;

	for (const [event, entries] of Object.entries(incomingHooks)) {
		const existingEntries = currentHooks[event];
		if (existingEntries !== undefined && !Array.isArray(existingEntries)) {
			return { ok: false, reason: `hooks.${event} is not an array` };
		}
		const list = (existingEntries as unknown[]) ?? [];
		if (invokesCouncil(list)) continue; // already wired — leave it be
		currentHooks[event] = [...list, ...(entries as unknown[])];
		changed = true;
	}

	if (!changed) return { ok: true, value: base, changed: false };
	base.hooks = currentHooks;
	return { ok: true, value: base, changed: true };
}

/**
 * Does any hook entry here actually *run* bpx-council?
 *
 * Deliberately not a substring search. `JSON.stringify(entries).includes(
 * "bpx-council")` also matched an unrelated hook like `cd ~/dev/bpx-council &&
 * make`, so anyone with the repo checked out got a clean-looking install of a
 * hook that was never added.
 *
 * Checks command position instead: split each command at shell separators and
 * look at the first token of each segment.
 */
function invokesCouncil(entries: unknown[]): boolean {
	return collectCommands(entries).some(isCouncilCommand);
}

/** Every string `command` field anywhere in a hook-entry tree. */
function collectCommands(node: unknown, out: string[] = []): string[] {
	if (Array.isArray(node)) {
		for (const child of node) collectCommands(child, out);
		return out;
	}
	if (isPlainObject(node)) {
		if (typeof node.command === "string") out.push(node.command);
		for (const value of Object.values(node)) {
			if (typeof value === "object" && value !== null) collectCommands(value, out);
		}
	}
	return out;
}

/**
 * Wrappers that run another command, so the real one is a token or two later.
 *
 * `npx bpx-council …` is the likely form for anyone who didn't install
 * globally, and an env-var prefix is what someone following the
 * BPX_COUNCIL_MODEL docs would write. Missing those meant a reinstall appended
 * a second hook and the user paid for two council calls every turn.
 */
const COMMAND_WRAPPERS = new Set(["npx", "bunx", "pnpx", "dlx", "sh", "bash", "zsh", "env", "command", "nohup", "time"]);

/** Two-token runners: `pnpm dlx <pkg>`, `npm exec <pkg>`. */
const TWO_TOKEN_RUNNERS: Record<string, string> = { pnpm: "dlx", yarn: "dlx", npm: "exec" };

/** Strip surrounding quotes from a shell token. */
function stripQuotes(token: string): string {
	return token.replace(/^['"]+/, "").replace(/['"]+$/, "");
}

/** The bare command name: no directory, no Windows extension. */
function commandName(token: string): string {
	const base = token.split(/[\\/]/).pop() ?? "";
	return base.replace(/\.(cmd|exe|ps1|bat)$/i, "");
}

/** Does this token name our binary? */
function isCouncilToken(token: string): boolean {
	if (token === "@booplex/bpx-council") return true;
	return commandName(token) === "bpx-council";
}

/**
 * Is bpx-council the command being *run* here, rather than a path that merely
 * mentions it?
 *
 * Both naive approaches fail in opposite directions. A substring match treats
 * `cd ~/dev/bpx-council && make` as an existing install and skips a hook the
 * user asked for. Checking only the first token misses `npx bpx-council` and
 * appends a duplicate. So: walk each shell segment past env assignments and
 * known wrappers, then check what's actually in command position.
 *
 * Not a shell parser, and doesn't try to be — a command exotic enough to fool
 * it produces a duplicate hook, which is visible and reversible, rather than a
 * skipped install or a lost file.
 */
export function isCouncilCommand(command: string): boolean {
	return command.split(/[;&|]+/).some(segmentRunsCouncil);
}

function segmentRunsCouncil(segment: string): boolean {
	const tokens = segment.trim().split(/\s+/).map(stripQuotes).filter(Boolean);
	let i = 0;

	// Leading VAR=value assignments belong to the environment, not the command.
	while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i])) i++;

	// Step past wrappers and their own flags until we reach a real command.
	while (i < tokens.length) {
		const name = commandName(tokens[i]);
		if (COMMAND_WRAPPERS.has(name)) {
			const wrapper = name;
			i++;
			let looksUpOnly = false;
			while (i < tokens.length && tokens[i].startsWith("-")) {
				// `command -v bpx-council` asks whether the binary exists; it
				// doesn't run it. Reading that as an existing install is the
				// bad direction — we'd report "already present" and add nothing.
				if (wrapper === "command" && /^-[vV]$/.test(tokens[i])) looksUpOnly = true;
				i++;
			}
			if (looksUpOnly) return false;
			continue;
		}
		if (TWO_TOKEN_RUNNERS[name] === tokens[i + 1]) {
			i += 2;
			continue;
		}
		break;
	}

	return i < tokens.length && isCouncilToken(tokens[i]);
}

/**
 * Insert or refresh our marker-delimited block in a Markdown file.
 *
 * Re-running replaces what's between the markers. Content outside them is
 * never touched.
 *
 * Refuses on any malformed marker state — a start with no end after it, an end
 * with no start, or more than one block. Those are exactly the states where
 * "just append" silently sets up the next run to swallow everything between an
 * orphaned marker and our new one. Repairing that automatically means guessing
 * which text was the user's; refusing means they keep it.
 *
 * @param existing - Current file contents ("" if the file is new).
 * @param snippet - The block to insert, markers included.
 * @returns The new text, or a refusal naming the marker problem.
 */
export function applyBlock(existing: string, snippet: string): EditResult<string> {
	const block = snippet.trim();
	const starts = countOccurrences(existing, BLOCK_START);
	const ends = countOccurrences(existing, BLOCK_END);

	// Nothing of ours in the file — clean append, one blank line before it.
	if (starts === 0 && ends === 0) {
		const prefix = existing.trim().length > 0 ? `${existing.trimEnd()}\n\n` : "";
		const text = `${prefix}${block}\n`;
		return { ok: true, value: text, changed: text !== existing };
	}

	// Anything other than exactly one well-formed pair is a refusal.
	//
	// Counting is the point. An earlier fix checked "is there a start, is there
	// an end after it, is there another start after *that* end" — which passes
	// the exact file the original bug produced: START, user content, START,
	// BLOCK, END. The second start sits *before* the end, so the guard missed
	// it and the replace ran from the first start straight through, deleting
	// the user's content in the middle. The people most exposed to that were
	// the ones who'd already run the broken build.
	if (starts !== 1 || ends !== 1) {
		return {
			ok: false,
			reason: `expected one bpx-council block, found ${starts} start and ${ends} end marker(s) — repair by hand`,
		};
	}

	const start = existing.indexOf(BLOCK_START);
	const end = existing.indexOf(BLOCK_END);
	if (end < start) {
		return { ok: false, reason: "bpx-council:end appears before :start — repair by hand" };
	}

	const text = existing.slice(0, start) + block + existing.slice(end + BLOCK_END.length);
	return { ok: true, value: text, changed: text !== existing };
}

/** How many times `needle` appears in `haystack`. */
function countOccurrences(haystack: string, needle: string): number {
	let count = 0;
	let from = 0;
	for (;;) {
		const at = haystack.indexOf(needle, from);
		if (at === -1) return count;
		count++;
		from = at + needle.length;
	}
}

/** An agent the user asked for that can't be installed at the chosen scope. */
export interface SkippedAgent {
	agent: AgentDef;
	reason: string;
}

/**
 * Build the full action list for the chosen agents and scope.
 *
 * Agents that don't support the requested scope come back in `skipped` rather
 * than vanishing — naming codex and silently getting nothing was worse than
 * either installing or erroring.
 */
export function planActions(
	agents: AgentDef[],
	scope: Scope,
	cwd: string,
	withHook: boolean,
): { plan: { agent: AgentDef; actions: InstallAction[] }[]; skipped: SkippedAgent[] } {
	const plan: { agent: AgentDef; actions: InstallAction[] }[] = [];
	const skipped: SkippedAgent[] = [];

	for (const agent of agents) {
		if (!agent.scopes.includes(scope)) {
			const supported = agent.scopes.join(", ");
			skipped.push({ agent, reason: `${supported}-only — re-run with --scope ${agent.scopes[0]}` });
			continue;
		}
		const actions = agent.actions(scope, cwd).filter((a) => withHook || !a.optIn);
		if (actions.length > 0) plan.push({ agent, actions });
	}
	return { plan, skipped };
}

// ---------------------------------------------------------------------------
// Applying — the I/O half
// ---------------------------------------------------------------------------

/**
 * Write a file without a window where it exists but is truncated.
 *
 * Both owned-file destinations go through here. A crash or SIGINT partway
 * through a plain writeFileSync leaves a truncated settings.json — which the
 * next run correctly refuses to merge, but by then the content is already
 * gone. Write beside it, then rename, which is atomic within a filesystem.
 */
function writeFileAtomic(dest: string, text: string): void {
	// Resolve symlinks first. Dotfiles setups routinely symlink settings.json
	// and AGENTS.md into a tracked repo, and `rename` replaces the *directory
	// entry* — so renaming onto the link would swap it for a regular file and
	// silently detach the user's canonical copy. Writing through the link the
	// way plain writeFileSync did is the behaviour to preserve.
	let target = dest;
	if (existsSync(dest)) {
		try {
			target = realpathSync(dest);
		} catch {
			// Broken link or unreadable — fall back to the path as given.
			target = dest;
		}
	}

	// `rename` only needs write permission on the *directory*, so a chmod 444
	// target would be silently replaced — the plain writeFileSync this replaced
	// would have failed with EACCES. Read-only is an explicit "leave this
	// alone", and this module's whole contract is that unrecognised situations
	// refuse rather than write.
	if (existsSync(target)) {
		try {
			accessSync(target, constants.W_OK);
		} catch {
			// Phrased like the other refusals rather than surfacing a raw
			// EACCES with the full path repeated twice.
			throw new Error(`${basename(target)} is read-only — left untouched`);
		}
	}

	const tmp = `${target}.bpx-council-tmp`;
	try {
		writeFileSync(tmp, text);
		// Carry the destination's permissions across. A fresh temp file gets
		// 0666 & ~umask, so a deliberate `chmod 600` on a settings.json holding
		// API keys would quietly come back world-readable after an install.
		if (existsSync(target)) {
			try {
				chmodSync(tmp, statSync(target).mode);
			} catch {
				// Non-fatal: better to write with default perms than not at all.
			}
		}
		renameSync(tmp, target);
	} catch (e) {
		try {
			if (existsSync(tmp)) unlinkSync(tmp);
		} catch {
			// Best-effort cleanup — the original write error is what matters.
		}
		throw e;
	}
}

/** Does the destination tree differ from the template tree? */
function treeDiffers(source: string, dest: string): boolean {
	if (!existsSync(dest)) return true;
	try {
		if (statSync(source).isDirectory()) {
			if (!statSync(dest).isDirectory()) return true;
			const names = readdirSync(source).filter((n) => !isPlatformJunk(n));
			const destNames = readdirSync(dest).filter((n) => !isPlatformJunk(n));
			if (names.length !== destNames.length) return true;
			return names.some((n) => treeDiffers(join(source, n), join(dest, n)));
		}
		return readFileSync(source, "utf-8") !== readFileSync(dest, "utf-8");
	} catch {
		// Unreadable either side — treat as different so we don't claim a
		// no-op we can't actually verify.
		return true;
	}
}

// ---------------------------------------------------------------------------
// Link mode — one canonical skill copy, symlinked into each agent's dir
// ---------------------------------------------------------------------------

/** The single source of truth all agent skill dirs link at, in link mode. */
export function canonicalSkillDir(scope: Scope, cwd: string): string {
	const base = scope === "global" ? homedir() : cwd;
	return join(base, ".agents", "skills", "bpx-council");
}

/** Is this the skill-directory copy — the thing that's shareable via a link? */
function isSkillCopy(action: InstallAction): boolean {
	return action.kind === "copy-dir" && action.source === "skills/bpx-council";
}

/**
 * How to point `linkPath` at `canonical`, per platform.
 *
 * POSIX gets a *relative* link so the pair survives moving the repo (both live
 * inside it). Windows gets a `junction` with an *absolute* target: junctions
 * don't need admin or developer mode the way real symlinks do, and they only
 * accept absolute paths. This is the same split vercel-labs/skills uses.
 *
 * Pure, so the path math is unit-tested without a filesystem or a second OS.
 */
export function symlinkSpec(
	canonical: string,
	linkPath: string,
	plat: NodeJS.Platform = platform(),
): { target: string; type: "junction" | undefined } {
	if (plat === "win32") return { target: canonical, type: "junction" };
	return { target: relative(dirname(linkPath), canonical), type: undefined };
}

/** A plan group ready to apply: a display label and its actions, in order. */
export interface ApplyGroup {
	label: string;
	actions: InstallAction[];
}

const CANONICAL_LABEL = "Canonical skill (.agents/skills — the one real copy)";

/**
 * Turn the scope-resolved plan into ordered apply groups.
 *
 * Copy mode is a straight relabel. Link mode rewrites every skill copy into a
 * link at one canonical copy, and hoists that canonical copy to the front so
 * it exists before anything links to it. If no skill is being installed (say
 * the user picked only the AGENTS.md block), link mode is a no-op.
 */
export function buildGroups(
	plan: { agent: AgentDef; actions: InstallAction[] }[],
	scope: Scope,
	cwd: string,
	link: boolean,
): ApplyGroup[] {
	if (!link) return plan.map((p) => ({ label: p.agent.label, actions: p.actions }));

	const canonical = canonicalSkillDir(scope, cwd);
	const rest: ApplyGroup[] = [];
	let canonicalAction: InstallAction | undefined;
	let canonicalOwner: string | undefined;
	let sawSkill = false;

	for (const { agent, actions } of plan) {
		const out: InstallAction[] = [];
		for (const action of actions) {
			if (isSkillCopy(action)) {
				sawSkill = true;
				if (action.dest === canonical) {
					// This agent already targets the canonical dir — let it be the
					// real copy, and don't emit a duplicate group for it.
					canonicalAction = action;
					canonicalOwner = agent.label;
					continue;
				}
				out.push({
					...action,
					kind: "link-dir",
					linkTarget: canonical,
					label: `${action.label} (symlink → .agents/skills)`,
				});
			} else {
				out.push(action);
			}
		}
		if (out.length > 0) rest.push({ label: agent.label, actions: out });
	}

	if (!sawSkill) return plan.map((p) => ({ label: p.agent.label, actions: p.actions }));

	const canonicalGroup: ApplyGroup = {
		label: canonicalOwner ? `${canonicalOwner} + canonical` : CANONICAL_LABEL,
		actions: [
			canonicalAction ?? {
				kind: "copy-dir",
				source: "skills/bpx-council",
				dest: canonical,
				label: "the one real copy every agent links to",
			},
		],
	};
	return [canonicalGroup, ...rest];
}

/**
 * Point `dest` at `canonical` with a symlink, falling back to a copy.
 *
 * Idempotent: an existing link already resolving to canonical is a no-op. Safe:
 * a real directory at `dest` is only replaced when it *matches* canonical — an
 * edited copy is refused, not clobbered, same as every other owned-path rule in
 * this module. Any symlink failure (Windows without privileges, a filesystem
 * that doesn't support links) degrades to a plain copy.
 */
function linkDir(canonical: string, dest: string): ActionResult {
	const action: InstallAction = { kind: "link-dir", source: "skills/bpx-council", dest, linkTarget: canonical, label: "" };
	try {
		// Never link a path to itself. buildGroups already routes dest===canonical
		// to a copy, so this is unreachable today — but this function is the one
		// thing here that can rmSync a real directory, and treeDiffers(x, x) is
		// false, so without this guard a self-link would delete the canonical
		// copy and leave a dangling link. Refuse rather than trust the caller.
		if (dest === canonical) {
			return { action, outcome: "unchanged", detail: "already the canonical copy" };
		}
		if (!existsSync(canonical)) {
			return { action, outcome: "failed", detail: "canonical skill copy missing — nothing to link to" };
		}
		mkdirSync(dirname(dest), { recursive: true });

		let existed = false;
		try {
			const st = lstatSync(dest);
			existed = true;
			if (st.isSymbolicLink()) {
				try {
					if (realpathSync(dest) === realpathSync(canonical)) {
						return { action, outcome: "unchanged", detail: "already linked" };
					}
				} catch {
					// Dangling or unresolvable link — fall through and replace it.
				}
				rmSync(dest, { force: true });
			} else if (treeDiffers(canonical, dest)) {
				// A real dir whose contents differ from canonical is an edit we
				// won't silently discard.
				return { action, outcome: "failed", detail: "an edited copy is here — remove it or use copy mode" };
			} else {
				rmSync(dest, { recursive: true, force: true });
			}
		} catch {
			// lstat threw → nothing at dest.
		}

		const spec = symlinkSpec(canonical, dest);
		try {
			symlinkSync(spec.target, dest, spec.type);
			return { action, outcome: existed ? "updated" : "created", detail: "symlink" };
		} catch {
			cpSync(canonical, dest, { recursive: true, filter: (s) => !isPlatformJunk(s) });
			return { action, outcome: existed ? "updated" : "created", detail: "copied (symlinks unsupported here)" };
		}
	} catch (e) {
		return { action, outcome: "failed", detail: e instanceof Error ? e.message : String(e) };
	}
}

/** What this action would do, without doing it. Drives the plan output. */
export function previewAction(action: InstallAction): ActionPreview {
	if (action.kind === "link-dir") {
		if (!existsSync(action.dest)) return "create";
		try {
			const st = lstatSync(action.dest);
			if (st.isSymbolicLink()) {
				// A link already resolving to canonical is a no-op; one pointing
				// elsewhere gets replaced.
				try {
					if (realpathSync(action.dest) === realpathSync(action.linkTarget ?? "")) return "current";
				} catch {
					// Dangling link — will be replaced.
				}
				return "overwrite";
			}
			// A real dir is only swapped for a link when it matches canonical.
			// An edited one is refused, so the plan must not promise overwrite.
			if (action.linkTarget && treeDiffers(action.linkTarget, action.dest)) return "blocked";
		} catch {
			// Fall through to overwrite.
		}
		return "overwrite";
	}
	const source = join(TEMPLATES_ROOT, action.source);
	if (!existsSync(action.dest)) return "create";
	if (action.kind === "copy-dir" || action.kind === "copy-file") {
		return treeDiffers(source, action.dest) ? "overwrite" : "current";
	}
	return "merge";
}

/** Execute one action. Never throws; failures come back as an outcome. */
export function applyAction(action: InstallAction): ActionResult {
	// Link actions point at the canonical copy, not a template, so they skip the
	// template-existence check the copy/merge kinds start with.
	if (action.kind === "link-dir") {
		return linkDir(action.linkTarget ?? "", action.dest);
	}
	const source = join(TEMPLATES_ROOT, action.source);
	try {
		if (!existsSync(source)) {
			return { action, outcome: "failed", detail: `template missing: ${source}` };
		}
		mkdirSync(dirname(action.dest), { recursive: true });

		switch (action.kind) {
			case "copy-dir": {
				if (!treeDiffers(source, action.dest)) return { action, outcome: "unchanged" };
				const existed = existsSync(action.dest);
				cpSync(source, action.dest, { recursive: true, filter: (src) => !isPlatformJunk(src) });
				return { action, outcome: existed ? "updated" : "created" };
			}
			case "copy-file": {
				if (!treeDiffers(source, action.dest)) return { action, outcome: "unchanged" };
				const existed = existsSync(action.dest);
				cpSync(source, action.dest);
				return { action, outcome: existed ? "updated" : "created" };
			}
			case "merge-json": {
				const incoming = JSON.parse(readFileSync(source, "utf-8")) as Record<string, unknown>;
				const existed = existsSync(action.dest);
				let current: unknown;
				if (existed) {
					try {
						current = JSON.parse(readFileSync(action.dest, "utf-8"));
					} catch {
						return { action, outcome: "failed", detail: `${basename(action.dest)} is not valid JSON — left untouched` };
					}
				}
				const merged = mergeHookSettings(current, incoming);
				if (!merged.ok) {
					return { action, outcome: "failed", detail: `${merged.reason} — left untouched` };
				}
				if (!merged.changed) return { action, outcome: "unchanged", detail: "hook already present" };
				writeFileAtomic(action.dest, `${JSON.stringify(merged.value, null, 2)}\n`);
				return { action, outcome: existed ? "updated" : "created" };
			}
			case "append-block": {
				const snippet = readFileSync(source, "utf-8");
				const existed = existsSync(action.dest);
				const current = existed ? readFileSync(action.dest, "utf-8") : "";
				const block = applyBlock(current, snippet);
				if (!block.ok) {
					return { action, outcome: "failed", detail: `${block.reason} — left untouched` };
				}
				if (!block.changed) return { action, outcome: "unchanged", detail: "block already current" };
				writeFileAtomic(action.dest, block.value);
				return { action, outcome: existed ? "updated" : "created" };
			}
		}
	} catch (e) {
		return { action, outcome: "failed", detail: e instanceof Error ? e.message : String(e) };
	}
}

// ---------------------------------------------------------------------------
// The wizard
// ---------------------------------------------------------------------------

/** Markers that suggest cwd is actually a project root. */
const PROJECT_MARKERS = [".git", "package.json", "pyproject.toml", "go.mod", "Cargo.toml", "AGENTS.md"];

function looksLikeProjectRoot(cwd: string): boolean {
	return PROJECT_MARKERS.some((marker) => existsSync(join(cwd, marker)));
}

/**
 * Run the installer. Interactive unless flags or a non-TTY say otherwise.
 *
 * @returns Process exit code — non-zero if any action failed.
 */
export async function runInstall(opts: InstallOptions): Promise<number> {
	const cwd = opts.cwd ?? process.cwd();
	const detected = AGENTS.filter((a) => a.detect());
	const isTty = process.stdin.isTTY === true;

	// Writing without a terminal and without explicit consent is how a stray
	// `install < /dev/null` from $HOME creates ~/AGENTS.md. --yes is the
	// consent gate, so make it actually gate.
	if (!isTty && !opts.yes && !opts.dryRun) {
		console.error("bpx-council install: not a terminal, so there's nobody to confirm with.");
		console.error("Re-run with --yes to write, or --dry-run to see the plan.");
		return 1;
	}

	// Interactive only when we have a terminal and the user hasn't pre-answered.
	const interactive = isTty && !opts.yes && !opts.agents?.length;

	let chosen: AgentDef[];
	let scope: Scope;
	let withHook = opts.withHook ?? false;
	let link = opts.link ?? false;

	if (opts.agents?.length) {
		const resolved: AgentDef[] = [];
		for (const id of opts.agents) {
			const agent = findAgent(id);
			if (!agent) {
				console.error(`Unknown agent "${id}". Known: ${AGENTS.map((a) => a.id).join(", ")}`);
				return 1;
			}
			resolved.push(agent);
		}
		chosen = resolved;
		scope = opts.scope ?? "project";
	} else if (interactive) {
		const answers = await promptWizard(detected);
		if (!answers) {
			console.log("Nothing selected — bailing.");
			return 0;
		}
		chosen = answers.agents;
		scope = answers.scope;
		withHook = answers.withHook;
		link = answers.link;
	} else {
		// Headless with no --agent: everything we detected, project scope.
		chosen = detected;
		scope = opts.scope ?? "project";
	}

	const { plan, skipped } = planActions(chosen, scope, cwd, withHook);

	// Report what we're not doing before what we are.
	for (const { agent, reason } of skipped) {
		console.error(`Skipping ${agent.label}: ${reason}`);
	}
	if (plan.length === 0) {
		console.error(`Nothing to install for scope "${scope}".`);
		return 1;
	}

	const touchesProjectFiles = plan.some(({ agent }) => agent.scopes.includes("project") && scope === "project");
	if (touchesProjectFiles && !looksLikeProjectRoot(cwd)) {
		console.error(`\nWarning: ${cwd} doesn't look like a project root (no .git, package.json, …).`);
	}

	// One canonical copy + symlinks, or a copy per agent. Built once, so the
	// plan the user sees is exactly what gets applied.
	const groups = buildGroups(plan, scope, cwd, link);

	// Show the plan before touching anything.
	const mode = link ? " · link mode" : "";
	console.log(`\nInstalling bpx-council (${scope} scope${mode})\n`);
	let anyBlocked = false;
	for (const { label, actions } of groups) {
		console.log(`  ${label}`);
		for (const a of actions) {
			const preview = previewAction(a);
			if (preview === "blocked") anyBlocked = true;
			console.log(`    [${preview}] ${a.dest}`);
			console.log(`      ${a.label}`);
		}
	}
	if (anyBlocked) {
		console.log("\n  [blocked] = an edited copy is already there; it'll be left alone, not replaced.");
	}
	console.log();

	if (opts.dryRun) {
		console.log("Dry run — nothing written.");
		return 0;
	}

	if (interactive) {
		const ok = await confirm("Write these files?", true);
		if (!ok) {
			console.log("Cancelled.");
			return 0;
		}
		console.log();
	}

	let failures = 0;
	for (const { label, actions } of groups) {
		for (const a of actions) {
			const result = applyAction(a);
			if (result.outcome === "failed") failures++;
			const mark = result.outcome === "failed" ? "!" : result.outcome === "unchanged" ? "=" : "+";
			const detail = result.detail ? ` (${result.detail})` : "";
			console.log(`  ${mark} ${label}: ${a.dest}${detail}`);
		}
	}

	console.log();
	if (failures > 0) {
		console.error(`${failures} action(s) failed — those files were left untouched.`);
		return 1;
	}

	console.log("Done. Restart your agent so it picks up the new files.");
	if (!withHook) {
		console.log("Tip: `bpx-council install --with-hook` adds a Stop hook that gut-checks every turn.");
	}
	return 0;
}

interface WizardAnswers {
	agents: AgentDef[];
	scope: Scope;
	withHook: boolean;
	link: boolean;
}

/** The interactive flow. Returns undefined if the user picked nothing. */
async function promptWizard(detected: AgentDef[]): Promise<WizardAnswers | undefined> {
	console.log("\nbpx-council install\n");

	const agents = await selectAgents(detected);
	if (agents === null) return undefined; // cancelled
	if (agents.length === 0) return undefined;

	// The rest are simple yes/no and one/two questions — a plain readline is the
	// right tool. Raw mode from the multiselect is already restored by now.
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		// Only ask about scope if something we picked can actually vary.
		const scopeVaries = agents.some((a) => a.scopes.length > 1);
		let scope: Scope = "project";
		if (scopeVaries) {
			const answer = await rl.question(
				"\nScope?\n  1. This project only (default)\n  2. Global — every project on this machine\n\n> ",
			);
			scope = answer.trim() === "2" ? "global" : "project";
		}

		const withHook = agents.some((a) => a.id === "claude-code")
			? await confirmOn(rl, "\nAdd the Stop hook? Gut-checks after every turn — costs a model call each time.", false)
			: false;

		// Only worth asking when more than one skill dir would be written —
		// linking is about sharing one copy across several. A single skill dir
		// has nothing to share, so don't clutter the flow.
		const skillDirs = agents.filter((a) => a.actions(scope, "").some((act) => act.kind === "copy-dir")).length;
		const link =
			skillDirs > 1
				? await confirmOn(
						rl,
						"\nSymlink skill dirs at one canonical copy? Update once, all see it — but symlinks are fragile on Windows and in git clones (copy is the safe default).",
						false,
					)
				: false;

		return { agents, scope, withHook, link };
	} finally {
		rl.close();
	}
}

/**
 * Pick which agents to install into.
 *
 * A real terminal gets the checkbox multiselect (arrows + space); anything else
 * falls back to comma-separated entry. Detected agents are pre-checked either
 * way. Returns null if the user cancelled, or the chosen AgentDefs.
 */
async function selectAgents(detected: AgentDef[]): Promise<AgentDef[] | null> {
	const initial = AGENTS.map((a, i) => (detected.includes(a) ? i : -1)).filter((i) => i >= 0);
	const labels = AGENTS.map((a) => `${a.label}${detected.includes(a) ? "" : "  (not detected)"}`);

	if (process.stdin.isTTY) {
		const picked = await runMultiselect("Which agents? (space to toggle, enter to confirm)", labels, initial);
		if (picked === null) return null;
		return picked.map((i) => AGENTS[i]).filter(Boolean);
	}

	// Non-TTY fallback: the old comma-separated prompt.
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		console.log("Found on this machine:\n");
		AGENTS.forEach((agent, i) => {
			console.log(`  ${i + 1}. ${agent.label} (${detected.includes(agent) ? "detected" : "not detected"})`);
		});
		const defaults = initial.map((i) => i + 1);
		const answer = await rl.question(`\nWhich? (comma-separated, default: ${defaults.join(",")}) `);
		return parsePicks(answer, defaults, AGENTS.length)
			.map((n) => AGENTS[n - 1])
			.filter(Boolean);
	} finally {
		rl.close();
	}
}

/**
 * Parse a comma-separated selection like "1,3".
 *
 * Empty input takes the default. Out-of-range and non-numeric entries are
 * dropped rather than erroring — a typo shouldn't restart the wizard.
 */
export function parsePicks(answer: string, fallback: number[], max: number): number[] {
	const trimmed = answer.trim();
	if (trimmed === "") return fallback;
	const picked = trimmed
		.split(",")
		.map((s) => Number(s.trim()))
		.filter((n) => Number.isInteger(n) && n >= 1 && n <= max);
	return [...new Set(picked)];
}

async function confirm(question: string, defaultYes: boolean): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		return await confirmOn(rl, question, defaultYes);
	} finally {
		rl.close();
	}
}

async function confirmOn(
	rl: { question: (q: string) => Promise<string> },
	question: string,
	defaultYes: boolean,
): Promise<boolean> {
	const hint = defaultYes ? "Y/n" : "y/N";
	const answer = (await rl.question(`${question} [${hint}] `)).trim().toLowerCase();
	if (answer === "") return defaultYes;
	return answer === "y" || answer === "yes";
}
