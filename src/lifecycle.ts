/** Offline host artifact inspection and conservative uninstall. No advisor calls. */
import { lstatSync, readFileSync, readdirSync, realpathSync, rmdirSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AGENTS, findAgent, TEMPLATES_ROOT, type AgentDef, type InstallAction, type Scope } from "./agents.js";
import { runMultiselect } from "./multiselect.js";
import { buildGroups, canonicalSkillDir, detectedHosts, hasLinkedParent, isBundledBlock, isCouncilCommand, planActions, treeDiffers, writeFileAtomic, type ApplyGroup, type InstallOptions } from "./install.js";

const START = "<!-- bpx-council:start -->";
const END = "<!-- bpx-council:end -->";
const SKILL = "skills/bpx-council";
type State = "missing" | "current" | "drifted";
interface Inspection { state: State; reason?: string; remove?: () => void }

/** Inspect path existence, including dangling links.
 * @param path - Candidate artifact path.
 * @returns Whether directory entry exists.
 */
function pathExists(path: string): boolean {
	try { lstatSync(path); return true; } catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
		throw error;
	}
}

/** Inspect marked AGENTS.md block without changing surrounding text.
 * @param text - Existing AGENTS.md bytes.
 * @returns Ownership state and text after exact block removal.
 */
export function inspectBlock(text: string): { state: State; value?: string; reason?: string } {
	const starts = text.split(START).length - 1;
	const ends = text.split(END).length - 1;
	if (starts === 0 && ends === 0) return { state: "missing" };
	if (starts !== 1 || ends !== 1 || text.indexOf(END) < text.indexOf(START))
		return { state: "drifted", reason: "malformed markers — repair manually" };
	const start = text.indexOf(START);
	const end = text.indexOf(END) + END.length;
	const block = text.slice(start, end);
	if (!isBundledBlock(block)) return { state: "drifted", reason: "edited marker block — remove manually" };
	let before = text.slice(0, start);
	let after = text.slice(end);
	if (before.endsWith("\n\n")) before = before.slice(0, -1);
	if (after.startsWith("\n")) after = after.slice(1);
	return { state: "current", value: before + after };
}

/** Plan removal of exact bundled Stop entries without mutating settings.
 * @param value - Parsed Claude settings.
 * @returns State and settings with exact entries removed when owned.
 */
export function removeLegacyHook(value: unknown): { state: State; value?: unknown; reason?: string } {
	if (!value || typeof value !== "object" || Array.isArray(value)) return { state: "drifted", reason: "settings root is not an object" };
	const settings = value as Record<string, unknown>;
	if (settings.hooks === undefined) return { state: "missing" };
	if (!settings.hooks || typeof settings.hooks !== "object" || Array.isArray(settings.hooks)) return { state: "drifted", reason: "hooks is not an object" };
	const hooks = settings.hooks as Record<string, unknown>;
	if (hooks.Stop === undefined) return { state: "missing" };
	if (!Array.isArray(hooks.Stop)) return { state: "drifted", reason: "hooks.Stop is not an array" };
	const exact = (JSON.parse(readFileSync(join(TEMPLATES_ROOT, "claude-code/hooks-settings.json"), "utf8")) as { hooks: { Stop: unknown[] } }).hooks.Stop[0];
	const kept: unknown[] = [];
	let removed = 0;
	for (const entry of hooks.Stop) {
		if (JSON.stringify(entry) === JSON.stringify(exact)) { removed++; continue; }
		// An edited legacy invocation may be someone's hook. Never guess ownership.
		if (JSON.stringify(entry).includes("bpx-council") && containsCouncil(entry))
			return { state: "drifted", reason: "edited council Stop entry — remove manually" };
		kept.push(entry);
	}
	if (!removed) return { state: "missing" };
	const nextHooks = { ...hooks, Stop: kept };
	return { state: "current", value: { ...settings, hooks: nextHooks } };
}

/** Find executable council command inside hook entry, not mere prose.
 * @param node - Hook entry or nested value.
 * @returns Whether entry invokes council.
 */
function containsCouncil(node: unknown): boolean {
	if (Array.isArray(node)) return node.some(containsCouncil);
	if (!node || typeof node !== "object") return false;
	const object = node as Record<string, unknown>;
	return (typeof object.command === "string" && isCouncilCommand(object.command)) || Object.values(object).some(containsCouncil);
}

/** Check symlinks between selected root and artifact.
 * @param dest - Artifact path.
 * @param scope - Selected scope.
 * @param cwd - Project root.
 * @returns Whether ancestor directory is linked.
 */
function linkedParent(dest: string, _scope: Scope, _cwd: string): boolean {
	return hasLinkedParent(dest, _scope === "global" ? homedir() : _cwd);
}

/** Check artifact ownership, including content and link target.
 * @param action - Planned host action.
 * @param scope - Selected scope.
 * @param cwd - Project root.
 * @returns Artifact state and exact-removal operation.
 */
function inspect(action: InstallAction, scope: Scope, cwd: string): Inspection {
	const dest = action.dest;
	if (linkedParent(dest, scope, cwd)) return { state: "drifted", reason: "symlinked parent directory — left untouched" };
	if (!pathExists(dest)) return { state: "missing" };
	if (action.kind === "append-block") {
		if (!lstatSync(dest).isFile()) return { state: "drifted", reason: "AGENTS.md is not a regular file" };
		const result = inspectBlock(readFileSync(dest, "utf8"));
		return result.state === "current" ? { state: "current", remove: () => {
			// Do not delete user-owned AGENTS.md, even if now empty.
			writeOwned(dest, result.value!);
		} } : result;
	}
	if (action.kind !== "copy-dir" && action.kind !== "copy-file" && action.kind !== "link-dir") return { state: "drifted", reason: "unknown action" };
	const stat = lstatSync(dest);
	if (stat.isSymbolicLink()) {
		const canonical = canonicalSkillDir(scope, cwd);
		try {
			if (action.source !== SKILL || dest === canonical || realpathSync(dest) !== realpathSync(canonical) ||
				treeDiffers(join(TEMPLATES_ROOT, SKILL), canonical)) throw new Error("foreign or drifted canonical link");
			return { state: "current", remove: () => unlinkSync(dest) };
		} catch { return { state: "drifted", reason: "foreign or drifted canonical link" }; }
	}
	const source = join(TEMPLATES_ROOT, action.source);
	if (treeDiffers(source, dest)) return { state: "drifted", reason: "edited bytes, extra entries, or foreign link — clean up manually" };
	return { state: "current", remove: () => {
		if (action.kind === "copy-dir") removeTree(source, dest);
		else unlinkSync(dest);
	} };
}

/** Delete verified template-shaped tree, never directory merely named bpx-council.
 * @param source - Bundled template tree.
 * @param dest - Matching installed tree.
 * @returns Nothing; throws when tree changes or removal fails.
 */
function removeTree(source: string, dest: string): void {
	if (treeDiffers(source, dest)) throw new Error("tree changed since inspection — left untouched");
	for (const name of readdirSync(source).filter((entry) => !entry.startsWith("._") && entry !== ".DS_Store")) {
		const child = join(source, name);
		if (lstatSync(child).isDirectory()) removeTree(child, join(dest, name));
		else {
			if (treeDiffers(child, join(dest, name))) throw new Error("file changed since inspection — left untouched");
			unlinkSync(join(dest, name));
		}
	}
	rmdirSync(dest);
}

/** Write user-owned text atomically; symlink destinations are refused.
 * @param dest - Existing regular file.
 * @param text - New text preserving unrelated values.
 * @returns Nothing; throws on write failure.
 */
function writeOwned(dest: string, text: string): void {
	if (!lstatSync(dest).isFile()) throw new Error("file changed since inspection");
	writeFileAtomic(dest, text);
}

/** Inspect optional retired Claude hook without installing one.
 * @param scope - Selected scope.
 * @param cwd - Project root.
 * @returns Hook ownership state and removal operation.
 */
function hookInspection(scope: Scope, cwd: string): Inspection {
	const dest = join(scope === "global" ? homedir() : cwd, ".claude", "settings.json");
	if (linkedParent(dest, scope, cwd)) return { state: "drifted", reason: "symlinked parent directory — left untouched" };
	if (!pathExists(dest)) return { state: "missing" };
	if (!lstatSync(dest).isFile()) return { state: "drifted", reason: "settings.json is not a regular file" };
	let value: unknown;
	try { value = JSON.parse(readFileSync(dest, "utf8")); }
	catch { return { state: "drifted", reason: "settings.json is not valid JSON" }; }
	const result = removeLegacyHook(value);
	if (result.state !== "current") return result;
	return { state: "current", reason: "retired Stop hook present", remove: () => writeOwned(dest, `${JSON.stringify(result.value, null, 2)}\n`) };
}

/** Turn unreadable Claude settings into drift without aborting other hosts.
 * @param scope - Selected scope.
 * @param cwd - Project root.
 * @returns Hook state, including read errors as drift.
 */
function safeHookInspection(scope: Scope, cwd: string): Inspection {
	try { return hookInspection(scope, cwd); }
	catch (error) { return { state: "drifted", reason: error instanceof Error ? error.message : String(error) }; }
}

/** Report legacy paid hook only when present; never alter settings on install.
 * @param scope - Host scope.
 * @param cwd - Project root.
 * @returns Settings path when a council Stop hook is present.
 */
export function inspectRetiredHook(scope: Scope, cwd: string): string | undefined {
	const dest = join(scope === "global" ? homedir() : cwd, ".claude", "settings.json");
	try {
		const value = JSON.parse(readFileSync(dest, "utf8")) as unknown;
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const hooks = (value as Record<string, unknown>).hooks;
		if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) return undefined;
		const stop = (hooks as Record<string, unknown>).Stop;
		return Array.isArray(stop) && stop.some(containsCouncil) ? dest : undefined;
	} catch { return undefined; }
}

/** Turn inaccessible paths into per-action drift, not crash.
 * @param action - Planned host action.
 * @param scope - Selected scope.
 * @param cwd - Project root.
 * @returns Artifact state, including read errors as drift.
 */
function safeInspect(action: InstallAction, scope: Scope, cwd: string): Inspection {
	try { return inspect(action, scope, cwd); }
	catch (error) { return { state: "drifted", reason: error instanceof Error ? error.message : String(error) }; }
}

/** Inspect selected host artifacts offline without mutations or advisor calls.
 * @param groups - Host action groups.
 * @param scope - Selected scope.
 * @param cwd - Project root.
 * @param claude - Whether to check retired Claude hook.
 * @param opencode - Whether OpenCode may discover both native and shared skills.
 * @returns Nonzero if artifact missing, drifted, or duplicated.
 */
export function verifyGroups(groups: ApplyGroup[], scope: Scope, cwd: string, claude: boolean, opencode = false): number {
	let bad = 0;
	const shared = canonicalSkillDir(scope, cwd);
	const native = join(scope === "global" ? join(homedir(), ".config", "opencode") : join(cwd, ".opencode"), "skills", "bpx-council");
	for (const group of groups) for (const action of group.actions) {
		// A shared Codex skill also satisfies OpenCode when its native skill is absent.
		const effective = opencode && action.dest === native && !pathExists(native) && pathExists(shared)
			? { ...action, dest: shared } : action;
		const found = safeInspect(effective, scope, cwd);
		console.log(`${group.label}: ${found.state} ${effective.dest}${found.reason ? ` (${found.reason})` : ""}`);
		if (found.state !== "current") bad++;
	}
	if (opencode && pathExists(native) && pathExists(shared)) {
		console.log(`OpenCode duplicate skill: drifted ${native} and ${shared} are both discoverable`);
		bad++;
	}
	if (claude) {
		const hook = safeHookInspection(scope, cwd);
		console.log(`Claude Code retired Stop hook: ${hook.state === "missing" ? "current (absent)" : hook.state === "current" ? "drifted (retired hook present)" : `drifted (${hook.reason})`}`);
		if (hook.state !== "missing") bad++;
	}
	console.log("Binary availability: not checked (artifact verification only).");
	return bad ? 1 : 0;
}

/** Ask for host and scope when uninstall has no explicit headless selection.
 * @param detected - Hosts inferred from local filesystem/PATH.
 * @param scope - Explicit scope, if supplied.
 * @returns Selected hosts and scope, or undefined on cancellation.
 */
async function chooseUninstall(detected: AgentDef[], scope?: Scope): Promise<{ agents: AgentDef[]; scope: Scope } | undefined> {
	const defaults = AGENTS.map((agent, i) => detected.includes(agent) ? i : -1).filter((i) => i >= 0);
	const picks = await runMultiselect("Which agents should be unwired? (space to toggle, enter to confirm)",
		AGENTS.map((agent) => `${agent.label}${detected.includes(agent) ? "" : "  (not detected)"}`), defaults);
	if (picks === null || picks.length === 0) return undefined;
	const agents = picks.map((index) => AGENTS[index]);
	if (scope || !agents.some((agent) => agent.scopes.length > 1)) return { agents, scope: scope ?? "project" };
	const rl = createInterface({ input: process.stdin, output: process.stdout });
	try {
		const answer = await rl.question("Scope? 1. This project (default)  2. Global > ");
		return { agents, scope: answer.trim() === "2" ? "global" : "project" };
	} finally { rl.close(); }
}

/** Remove only exact owned artifacts in selected hosts and scope.
 * @param opts - Selection, confirmation and dry-run flags.
 * @returns Nonzero if any action fails or drift blocks removal.
 */
export async function runUninstall(opts: InstallOptions): Promise<number> {
	if (opts.withHook) { console.error("--with-hook is retired; uninstall checks exact legacy hook automatically."); return 1; }
	if (opts.link) { console.error("--link is install-only; uninstall detects owned links automatically."); return 1; }
	if (!opts.yes && !opts.dryRun && !process.stdin.isTTY) { console.error("uninstall requires --yes when not a terminal; use --dry-run to inspect."); return 1; }
	const cwd = opts.cwd ?? process.cwd();
	if (opts.agents?.some((id) => !id.trim())) { console.error("--agent needs a nonblank agent id."); return 1; }
	let chosen = opts.agents?.length ? opts.agents.map(findAgent) : detectedHosts(opts.scope ?? "project", cwd);
	if (chosen.some((agent) => !agent)) { console.error(`Unknown agent. Known: ${AGENTS.map((agent) => agent.id).join(", ")}`); return 1; }
	let scope = opts.scope ?? "project";
	if (!opts.agents?.length && !opts.yes && !opts.dryRun && process.stdin.isTTY) {
		const answer = await chooseUninstall(chosen as AgentDef[], opts.scope);
		if (!answer) { console.log("Nothing selected — bailing."); return 0; }
		chosen = answer.agents;
		scope = answer.scope;
	}
	// Installation dedupes OpenCode's skill when Codex is selected. Removal
	// inventories both paths: either one may have been installed separately.
	const { plan, skipped } = planActions(chosen as AgentDef[], scope, cwd, false, false);
	for (const item of skipped) console.error(`skip ${item.agent.label}: ${item.reason}`);
	if (!plan.length) { console.error(`Nothing to uninstall for scope "${scope}".`); return 1; }
	const groups = buildGroups(plan, scope, cwd, false);
	const actions = groups.flatMap((group) => group.actions.map((action) => ({ label: group.label, action })));
	if (chosen.some((agent) => agent?.id === "claude-code")) {
		const dest = join(scope === "global" ? homedir() : cwd, ".claude", "settings.json");
		actions.push({ label: "Claude Code retired Stop hook", action: { kind: "merge-json", source: "claude-code/hooks-settings.json", dest, label: "retired hook" } });
	}
	const status = actions.map(({ label, action }) => ({ label, action, found: action.kind === "merge-json" ? safeHookInspection(scope, cwd) : safeInspect(action, scope, cwd) }));
	const canonical = canonicalSkillDir(scope, cwd);
	const opencode = findAgent("opencode")!.actions(scope, cwd);
	const native = opencode.find((action) => action.kind === "copy-dir")!.dest;
	const command = opencode.find((action) => action.kind === "copy-file")!.dest;
	/** Native skill takes precedence as evidence; a command alone depends on shared copy. */
	const sharedOpenCode = (): boolean => pathExists(command) && !pathExists(native);
	const commandSelected = actions.some(({ action }) => action.dest === command);
	const commandRemovable = commandSelected && status.some(({ action, found }) => action.dest === command && found.state === "current");
	if (sharedOpenCode() && !commandRemovable) for (const item of status) if (item.action.dest === canonical && item.found.state === "current") {
		item.found = { state: "drifted", reason: "OpenCode command still uses shared skill — leave it in place" };
	}
	const otherLinks = AGENTS.flatMap((agent) => agent.scopes.includes(scope) ? agent.actions(scope, cwd) : [])
		.filter((action) => action.source === SKILL && action.dest !== canonical &&
			!actions.some((selected) => selected.action.dest === action.dest))
		.filter((action) => {
			try { return lstatSync(action.dest).isSymbolicLink() && realpathSync(action.dest) === realpathSync(canonical); }
			catch { return false; }
		});
	if (otherLinks.length) for (const item of status) if (item.action.dest === canonical && item.found.state === "current") {
		item.found = { state: "drifted", reason: `canonical still shared by ${otherLinks.map((link) => link.dest).join(", ")} — leave it in place` };
	}
	const selectedLink = status.some(({ action, found }) => action.source === SKILL && action.dest !== canonical &&
		found.state === "current" && (() => { try { return lstatSync(action.dest).isSymbolicLink(); } catch { return false; } })());
	const selectedSharedOpenCode = sharedOpenCode() && commandRemovable;
	for (const { label, action, found } of status) console.log(`${label}: ${found.state} ${action.dest}${found.reason ? ` (${found.reason})` : ""}`);
	if (opts.dryRun) {
		const retained = (selectedLink || selectedSharedOpenCode) && !actions.some(({ action }) => action.dest === canonical) && !otherLinks.length && pathExists(canonical);
		if (retained) console.error(`Canonical skill would remain at ${canonical}; select codex or agents-skills explicitly to remove it.`);
		console.log("Dry run — nothing removed.");
		return status.some(({ found }) => found.state === "drifted") || retained ? 1 : 0;
	}
	if (!opts.yes) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		try { if (!/^y(es)?$/i.test((await rl.question("Remove exact owned artifacts? [y/N] ")).trim())) return 0; }
		finally { rl.close(); }
	}
	let failures = 0;
	for (const { label, action, found } of [...status].sort((a, b) => Number(a.action.dest === canonical) - Number(b.action.dest === canonical))) {
		if (found.state === "missing") continue;
		if (!found.remove) { failures++; console.error(`failed ${label}: ${action.dest} — ${found.reason ?? "not owned"}`); continue; }
		try {
			// Remove canonical last, and never strand a host still linked to it.
			if (action.dest === canonical) {
				const linked = AGENTS.flatMap((agent) => agent.scopes.includes(scope) ? agent.actions(scope, cwd) : [])
					.filter((candidate) => candidate.source === SKILL && candidate.dest !== canonical)
					.some((candidate) => {
						try { return lstatSync(candidate.dest).isSymbolicLink() && realpathSync(candidate.dest) === realpathSync(canonical); }
						catch { return false; }
					});
				if (linked) throw new Error("canonical still shared by a host link — left untouched");
			}
			const fresh = action.kind === "merge-json" ? safeHookInspection(scope, cwd) : safeInspect(action, scope, cwd);
			if (fresh.state !== "current" || !fresh.remove) throw new Error("changed since inspection");
			if (action.dest === canonical && sharedOpenCode()) throw new Error("OpenCode command still uses shared skill — left untouched");
			fresh.remove();
			console.log(`removed ${label}: ${action.dest}`);
		} catch (error) { failures++; console.error(`failed ${label}: ${action.dest} — ${error instanceof Error ? error.message : String(error)}`); }
	}
	// A real canonical skill may belong to Codex/shared users even without a link.
	// A linked host alone cannot authorize its deletion; require explicit selection.
	const canonicalSelected = actions.some(({ action }) => action.dest === canonical);
	const retained = !canonicalSelected && (selectedLink || selectedSharedOpenCode) && pathExists(canonical) && !AGENTS.some((agent) =>
		agent.scopes.includes(scope) && agent.actions(scope, cwd).some((candidate) => candidate.source === SKILL && candidate.dest !== canonical &&
			(() => { try { return lstatSync(candidate.dest).isSymbolicLink() && realpathSync(candidate.dest) === realpathSync(canonical); } catch { return false; } })()));
	if (retained) console.error(`Canonical skill retained at ${canonical}; select codex or agents-skills explicitly to remove it.`);
	if (failures) console.error(`${failures} action(s) failed; other owned files may have been removed.`);
	return failures || retained ? 1 : 0;
}
