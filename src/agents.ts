/**
 * agents — the registry of coding agents bpx-council can wire itself into.
 *
 * A CLI on your PATH teaches a human that bpx-council exists. It teaches the
 * *agent* nothing. Agents learn from files in their own config tree — a skill
 * with a description they match against, a slash command, an AGENTS.md block.
 * This module is the one place that knows where those files go for each host.
 *
 * Every host convention here was verified against a real installation rather
 * than inferred. Claude Code and Codex both read `skills/<name>/SKILL.md` with
 * `name` + `description` frontmatter, which is why one template feeds both.
 */

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isOnPath } from "./detect.js";

/**
 * Where the bundled templates live.
 *
 * Resolved relative to this module rather than cwd, because the installer runs
 * from wherever the user happens to be. `src/` and `dist/` sit at the same
 * depth under the package root, so this one path works in dev and after build.
 */
export const TEMPLATES_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "templates");

/** Project scope writes into the repo; global scope into the user's home config. */
export type Scope = "project" | "global";

/**
 * How a single template gets applied.
 *
 * The three non-copy kinds exist because two of the destinations are files the
 * user already owns — clobbering someone's settings.json to add one hook would
 * be a hostile way to install a second-opinion tool.
 */
export type ActionKind =
	/** Recursively copy a template directory (a skill and any support files). */
	| "copy-dir"
	/** Copy one template file. */
	| "copy-file"
	/** Merge our keys into an existing JSON file, preserving everything else. */
	| "merge-json"
	/** Append (or replace) a marker-delimited block in a Markdown file. */
	| "append-block"
	/**
	 * Symlink this destination at a canonical skill copy instead of duplicating
	 * it. Never emitted by the registry — the installer rewrites `copy-dir`
	 * skill actions into this when link mode is on, so one real copy backs every
	 * agent's skill dir. See `src/install.ts`.
	 */
	| "link-dir";

export interface InstallAction {
	kind: ActionKind;
	/** Path inside `templates/`. */
	source: string;
	/** Absolute destination path. */
	dest: string;
	/** One line shown in the install plan, e.g. "skill (auto-triggers on 'second opinion')". */
	label: string;
	/**
	 * Opt-in actions are skipped unless the user asks for them. The Stop hook
	 * fires a council call after *every* turn — useful, but it costs a model
	 * call each time and nobody should get that by accident.
	 */
	optIn?: boolean;
	/**
	 * link-dir only: absolute path to the canonical skill copy this destination
	 * should point at. Set by the installer's link-mode transform.
	 */
	linkTarget?: string;
}

export interface AgentDef {
	id: string;
	label: string;
	/** True when this agent looks installed on the machine. */
	detect: () => boolean;
	/** Scopes this agent supports. Codex has no per-project skills dir. */
	scopes: Scope[];
	/** What to write for a given scope. `cwd` is the project root. */
	actions: (scope: Scope, cwd: string) => InstallAction[];
}

/** Root of an agent's config tree for the given scope. */
function claudeRoot(scope: Scope, cwd: string): string {
	return scope === "global" ? join(homedir(), ".claude") : join(cwd, ".claude");
}

export const AGENTS: AgentDef[] = [
	{
		id: "claude-code",
		label: "Claude Code",
		detect: () => isOnPath("claude") || existsSync(join(homedir(), ".claude")),
		scopes: ["project", "global"],
		actions: (scope, cwd) => {
			const root = claudeRoot(scope, cwd);
			return [
				{
					kind: "copy-dir",
					source: "skills/bpx-council",
					dest: join(root, "skills", "bpx-council"),
					label: "skill — auto-triggers on \"second opinion\", \"council\", \"gut check\"",
				},
				{
					kind: "copy-file",
					source: "claude-code/commands/council.md",
					dest: join(root, "commands", "council.md"),
					label: "/council slash command",
				},
				{
					kind: "merge-json",
					source: "claude-code/hooks-settings.json",
					dest: join(root, "settings.json"),
					label: "Stop hook — gut-checks every turn (costs a model call each time)",
					optIn: true,
				},
			];
		},
	},
	{
		id: "codex",
		label: "Codex (global)",
		// This entry covers Codex's *global* skills dir. Its project-scoped
		// skills live in the shared `.agents/skills/` dir — see the
		// "agents-skills" entry below, which reaches Codex-in-a-project along
		// with the rest of that cluster.
		detect: () => isOnPath("codex") || existsSync(join(homedir(), ".codex")),
		scopes: ["global"],
		actions: () => [
			{
				kind: "copy-dir",
				source: "skills/bpx-council",
				dest: join(homedir(), ".codex", "skills", "bpx-council"),
				label: "skill — same format Claude Code uses",
			},
		],
	},
	{
		id: "agents-skills",
		label: "Shared skills dir — .agents/skills (Cursor, Codex, Gemini CLI, Copilot, OpenCode, Zed, …)",
		// `.agents/skills/` is the emerging cross-agent convention for
		// project-scoped skills: a single copy here is read by a whole cluster
		// of agents instead of one. Reuses the exact same skill template as
		// Claude Code and Codex.
		//
		// Project scope only. The *global* skills dirs are per-agent and
		// fragmented (~/.cursor/skills, ~/.gemini/skills, ~/.copilot/skills, …)
		// with no shared target, so there's nothing to write once at that level.
		//
		// The agent list is vercel-labs/skills' published path table, not
		// something verified per-agent here — hence "convention", not a promise.
		detect: () => ["cursor", "codex", "opencode", "gemini"].some(isOnPath),
		scopes: ["project"],
		actions: (_scope, cwd) => [
			{
				kind: "copy-dir",
				source: "skills/bpx-council",
				dest: join(cwd, ".agents", "skills", "bpx-council"),
				label: "skill — one copy, read by the whole .agents/skills cluster",
			},
		],
	},
	{
		id: "agents-md",
		label: "AGENTS.md instruction block (any agent that reads AGENTS.md)",
		// Always offered: it's the universal fallback, and a project can want
		// the block whether or not any particular agent CLI is on this machine.
		detect: () => true,
		scopes: ["project"],
		actions: (_scope, cwd) => [
			{
				kind: "append-block",
				source: "agents-md/AGENTS.md.snippet",
				dest: join(cwd, "AGENTS.md"),
				label: "instruction block appended to AGENTS.md",
			},
		],
	},
];

export function findAgent(id: string): AgentDef | undefined {
	return AGENTS.find((a) => a.id === id);
}
