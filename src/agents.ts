/**
 * agents — the registry of coding agents bpx-council can wire itself into.
 *
 * A CLI on your PATH teaches a human that bpx-council exists. It teaches the
 * *agent* nothing. Agents learn from files in their own config tree — a skill
 * with a description they match against, a slash command, an AGENTS.md block.
 * This module is the one place that knows where those files go for each host.
 *
 * Claude Code, Codex, and OpenCode read host-specific skill paths. Codex and
 * OpenCode also read project `.agents/skills`; duplicate destinations are
 * removed when someone selects the shared option alongside a host.
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
 * Merge support stays for legacy hook detection/removal work; new installs
 * only copy host-owned files and append the marked AGENTS.md block.
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
	/** Retained for legacy installer action compatibility; no new hooks emitted. */
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
	/** Scopes this agent supports. */
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
			];
		},
	},
	{
		id: "codex",
		label: "Codex",
		detect: () => isOnPath("codex") || existsSync(join(homedir(), ".codex")),
		scopes: ["project", "global"],
		actions: (scope, cwd) => [{
			kind: "copy-dir",
			source: "skills/bpx-council",
			dest: join(scope === "global" ? homedir() : cwd, ".agents", "skills", "bpx-council"),
			label: "Codex skill",
		}],
	},
	{
		id: "opencode",
		label: "OpenCode",
		detect: () => isOnPath("opencode") || existsSync(join(homedir(), ".config", "opencode")),
		scopes: ["project", "global"],
		actions: (scope, cwd) => {
			const root = scope === "global" ? join(homedir(), ".config", "opencode") : join(cwd, ".opencode");
			return [
				{ kind: "copy-dir", source: "skills/bpx-council", dest: join(root, "skills", "bpx-council"), label: "OpenCode skill" },
				{ kind: "copy-file", source: "opencode/commands/council.md", dest: join(root, "commands", "council.md"), label: "/council command" },
			];
		},
	},
	{
		id: "agents-skills",
		label: "Shared project skill — .agents/skills (manual)",
		// Optional compatibility path; never inferred from installed CLIs.
		detect: () => false,
		scopes: ["project"],
		actions: (_scope, cwd) => [
			{
				kind: "copy-dir",
				source: "skills/bpx-council",
				dest: join(cwd, ".agents", "skills", "bpx-council"),
				label: "shared project skill (host support varies)",
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
