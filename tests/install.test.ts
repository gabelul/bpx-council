/**
 * Installer tests.
 *
 * The installer writes into two files the user already owns — Claude Code's
 * settings.json and the project's AGENTS.md. Getting that wrong doesn't produce
 * a bad council verdict, it produces a destroyed config. So the merge logic is
 * pure and tested here directly: preserve what's there, stay idempotent, and
 * refuse rather than guess when the file is unparseable.
 */

import { describe, expect, it } from "vitest";
import {
	applyBlock,
	buildGroups,
	canonicalSkillDir,
	isCouncilCommand,
	isPlatformJunk,
	mergeHookSettings,
	parsePicks,
	planActions,
	symlinkSpec,
} from "../src/install.js";
import { AGENTS, findAgent } from "../src/agents.js";

const HOOK_TEMPLATE = {
	hooks: {
		Stop: [{ hooks: [{ type: "command", command: "bpx-council --mode gut-check 'Review' || true" }] }],
	},
};

/** Unwrap a successful edit, failing loudly if it refused. */
function expectOk<T>(result: { ok: true; value: T; changed: boolean } | { ok: false; reason: string }) {
	if (!result.ok) throw new Error(`expected ok, got refusal: ${result.reason}`);
	return result;
}

describe("mergeHookSettings", () => {
	it("creates the hooks block when settings are empty", () => {
		const { value, changed } = expectOk(mergeHookSettings(undefined, HOOK_TEMPLATE));
		expect(changed).toBe(true);
		expect((value.hooks as Record<string, unknown[]>).Stop).toHaveLength(1);
	});

	it("keeps unrelated top-level keys", () => {
		const existing = { model: "opus", permissions: { allow: ["Bash"] } };
		const { value } = expectOk(mergeHookSettings(existing, HOOK_TEMPLATE));
		expect(value.model).toBe("opus");
		expect(value.permissions).toEqual({ allow: ["Bash"] });
	});

	it("appends alongside an existing unrelated Stop hook instead of replacing it", () => {
		const existing = {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "notify-send done" }] }] },
		};
		const { value, changed } = expectOk(mergeHookSettings(existing, HOOK_TEMPLATE));
		expect(changed).toBe(true);
		const stop = (value.hooks as Record<string, unknown[]>).Stop;
		expect(stop).toHaveLength(2);
		expect(JSON.stringify(stop)).toContain("notify-send done");
	});

	it("preserves hook events we don't touch", () => {
		const existing = {
			hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "guard.py" }] }] },
		};
		const { value } = expectOk(mergeHookSettings(existing, HOOK_TEMPLATE));
		expect(JSON.stringify((value.hooks as Record<string, unknown[]>).PreToolUse)).toContain("guard.py");
	});

	it("is idempotent — a second install adds nothing", () => {
		const first = expectOk(mergeHookSettings(undefined, HOOK_TEMPLATE));
		const second = expectOk(mergeHookSettings(first.value, HOOK_TEMPLATE));
		expect(second.changed).toBe(false);
		expect(second.value).toEqual(first.value);
	});

	it("leaves a user-tweaked council command alone rather than adding a second one", () => {
		// The template invites editing the command to fire less often. A re-run
		// must not undo that by bolting the stock version alongside it.
		const existing = {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "bpx-council --mode solo 'my own wording'" }] }] },
		};
		const { value, changed } = expectOk(mergeHookSettings(existing, HOOK_TEMPLATE));
		expect(changed).toBe(false);
		expect(JSON.stringify(value)).toContain("my own wording");
		expect(JSON.stringify(value)).not.toContain("gut-check");
	});

	// --- fail-closed cases: every one of these used to write ---

	it("refuses a settings root that isn't an object", () => {
		// Used to spread an array into an object and write back
		// {"0":1,"1":2,...} over the user's file.
		for (const root of [[1, 2, 3], "abc", 42, null]) {
			const result = mergeHookSettings(root, HOOK_TEMPLATE);
			expect(result.ok).toBe(false);
		}
	});

	it("refuses when hooks itself isn't an object", () => {
		const result = mergeHookSettings({ hooks: [{ matcher: "userHook" }] }, HOOK_TEMPLATE);
		expect(result.ok).toBe(false);
	});

	it("refuses a non-array hooks.Stop instead of deleting it", () => {
		// This silently dropped the user's hook: the ternary substituted [] and
		// the next line overwrote the key.
		const result = mergeHookSettings({ hooks: { Stop: { command: "userStopHook" } } }, HOOK_TEMPLATE);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("hooks.Stop");
	});

	it("installs normally when an unrelated hook merely mentions the repo path", () => {
		// `cd ~/dev/bpx-council && make` used to read as "already installed"
		// via a naive substring match, so the hook was never added.
		const existing = {
			hooks: { Stop: [{ hooks: [{ type: "command", command: "cd ~/dev/bpx-council && make" }] }] },
		};
		const { value, changed } = expectOk(mergeHookSettings(existing, HOOK_TEMPLATE));
		expect(changed).toBe(true);
		expect((value.hooks as Record<string, unknown[]>).Stop).toHaveLength(2);
	});
});

describe("isCouncilCommand", () => {
	it("matches the binary in command position", () => {
		expect(isCouncilCommand("bpx-council --mode gut-check 'x' || true")).toBe(true);
		expect(isCouncilCommand("cd /tmp && bpx-council 'x'")).toBe(true);
		expect(isCouncilCommand("/usr/local/bin/bpx-council 'x'")).toBe(true);
	});

	it("ignores the name appearing as a path argument", () => {
		expect(isCouncilCommand("cd ~/dev/bpx-council && make")).toBe(false);
		expect(isCouncilCommand("echo 'see bpx-council docs'")).toBe(false);
	});

	it("sees through wrappers and env prefixes", () => {
		// False negatives here append a SECOND Stop hook on reinstall, so the
		// user silently pays for two council calls every turn. `npx` is the
		// likely form for anyone who skipped the global install.
		const wrapped = [
			"npx bpx-council --mode gut-check 'x'",
			"npx -y @booplex/bpx-council 'x'",
			"bunx bpx-council 'x'",
			"pnpm dlx bpx-council 'x'",
			"BPX_COUNCIL_MODEL=opus bpx-council 'x'",
			"ANTHROPIC_API_KEY=sk-x BPX_COUNCIL_MODEL=opus bpx-council 'x'",
			'sh -c "bpx-council --mode solo 1"',
			'"bpx-council" --mode solo',
			"C:\\Users\\g\\bin\\bpx-council.cmd --mode solo",
		];
		for (const command of wrapped) {
			expect(isCouncilCommand(command), command).toBe(true);
		}
	});

	it("still ignores wrappers running something else", () => {
		expect(isCouncilCommand("npx eslint .")).toBe(false);
		expect(isCouncilCommand("FOO=bar make build")).toBe(false);
	});

	it("handles npm exec alongside pnpm/yarn dlx", () => {
		expect(isCouncilCommand("npm exec bpx-council 'x'")).toBe(true);
		expect(isCouncilCommand("yarn dlx bpx-council 'x'")).toBe(true);
		expect(isCouncilCommand("npm exec eslint .")).toBe(false);
	});

	it("does not treat a `command -v` existence check as an install", () => {
		// The bad direction: we'd report "hook already present" and add nothing.
		expect(isCouncilCommand("command -v bpx-council >/dev/null")).toBe(false);
		// But a check followed by a real invocation still counts.
		expect(isCouncilCommand("command -v bpx-council >/dev/null && bpx-council --mode gut-check 'x'")).toBe(true);
	});
});

describe("applyBlock", () => {
	const snippet = "<!-- bpx-council:start -->\n## bpx-council\n\nUse it.\n<!-- bpx-council:end -->";

	it("appends to an empty file without leading blank lines", () => {
		const { value, changed } = expectOk(applyBlock("", snippet));
		expect(changed).toBe(true);
		expect(value.startsWith("<!-- bpx-council:start -->")).toBe(true);
	});

	it("appends after existing content with one blank line between", () => {
		const { value } = expectOk(applyBlock("# My project\n\nSome rules.\n", snippet));
		expect(value).toContain("Some rules.\n\n<!-- bpx-council:start -->");
	});

	it("replaces in place on re-run instead of stacking duplicates", () => {
		const once = expectOk(applyBlock("# Project\n", snippet)).value;
		const updated = snippet.replace("Use it.", "Use it wisely.");
		const twice = expectOk(applyBlock(once, updated)).value;
		expect(twice.match(/bpx-council:start/g)).toHaveLength(1);
		expect(twice).toContain("Use it wisely.");
		expect(twice).not.toContain("Use it.\n<!-- bpx-council:end -->");
	});

	it("preserves content on both sides of the block", () => {
		const existing = `# Top\n\n${snippet}\n\n## Bottom section\n\nKeep me.\n`;
		const { value } = expectOk(applyBlock(existing, snippet.replace("Use it.", "Changed.")));
		expect(value).toContain("# Top");
		expect(value).toContain("Keep me.");
		expect(value).toContain("Changed.");
	});

	it("reports no change when the block is already current", () => {
		const once = expectOk(applyBlock("# Project\n", snippet)).value;
		expect(expectOk(applyBlock(once, snippet)).changed).toBe(false);
	});

	// --- fail-closed cases ---

	it("refuses an orphaned start marker instead of appending past it", () => {
		// THE data-loss bug. Appending here left an orphan start marker above
		// the user's content and our new end marker below it. The next run then
		// matched start..end across everything between and deleted it — notes,
		// house rules, the lot. Two runs, no warning, exit 0.
		const halfDeleted = "<!-- bpx-council:start -->\nhalf deleted\n\n# IMPORTANT NOTES\nkeep me\n";
		const result = applyBlock(halfDeleted, snippet);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("1 start and 0 end");
	});

	it("does not lose user content across two runs on a damaged file", () => {
		// The regression as a user would hit it: run, then run again.
		const damaged = "<!-- bpx-council:start -->\nstale\n\n# IMPORTANT NOTES\nkeep me\n";
		const first = applyBlock(damaged, snippet);
		expect(first.ok).toBe(false);
		// Nothing was written, so the second run sees the same file.
		const second = applyBlock(damaged, snippet);
		expect(second.ok).toBe(false);
		expect(damaged).toContain("# IMPORTANT NOTES");
	});

	it("refuses an end marker with no start", () => {
		const result = applyBlock("# Project\n\nnotes\n<!-- bpx-council:end -->\n", snippet);
		expect(result.ok).toBe(false);
	});

	it("refuses when an older install left two blocks", () => {
		// Replacing only the first would leave the second behind forever.
		const doubled = `# Project\n\n${snippet}\n\n${snippet}\n`;
		const result = applyBlock(doubled, snippet);
		expect(result.ok).toBe(false);
	});

	it("refuses the exact file the original bug produced", () => {
		// THE regression that survived the first fix. Run 1 of the broken build
		// left: orphan START, user content, START, BLOCK, END. Guarding with
		// "is there another start *after* the end" passed this — the second
		// start sits before the end — so the replace ran from the orphan
		// straight through and deleted the user's content in the middle.
		//
		// The people holding a file in this state are exactly those who ran the
		// broken build, so this is the shape that matters most.
		const legacyDamage = [
			"<!-- bpx-council:start -->",
			"half deleted",
			"",
			"# IMPORTANT USER NOTES",
			"keep me",
			"",
			snippet,
			"",
		].join("\n");
		const result = applyBlock(legacyDamage, snippet);
		expect(result.ok).toBe(false);
		expect(legacyDamage).toContain("IMPORTANT USER NOTES");
	});

	it("refuses a start marker nested inside an otherwise valid block", () => {
		const nested = `<!-- bpx-council:start -->\nA\n<!-- bpx-council:start -->\nUSERTEXT\n<!-- bpx-council:end -->\n`;
		expect(applyBlock(nested, snippet).ok).toBe(false);
	});

	it("refuses an end marker that appears before the start", () => {
		const inverted = `<!-- bpx-council:end -->\nUSERTEXT\n<!-- bpx-council:start -->\n`;
		expect(applyBlock(inverted, snippet).ok).toBe(false);
	});
});

describe("planActions", () => {
	const cwd = "/tmp/project";

	it("omits opt-in actions unless asked", () => {
		const claude = findAgent("claude-code");
		expect(claude).toBeDefined();
		const without = planActions([claude!], "project", cwd, false);
		const withHook = planActions([claude!], "project", cwd, true);
		expect(without.plan[0].actions).toHaveLength(2);
		expect(withHook.plan[0].actions).toHaveLength(3);
		expect(JSON.stringify(without.plan)).not.toContain("settings.json");
	});

	it("reports scope-incompatible agents instead of dropping them silently", () => {
		// Codex reads skills only from ~/.codex. Naming it explicitly and
		// getting nothing — no plan entry, no message, exit 0 — read as success.
		const codex = findAgent("codex")!;
		const atProject = planActions([codex], "project", cwd, false);
		expect(atProject.plan).toHaveLength(0);
		expect(atProject.skipped).toHaveLength(1);
		expect(atProject.skipped[0].reason).toContain("global");

		const atGlobal = planActions([codex], "global", cwd, false);
		expect(atGlobal.plan).toHaveLength(1);
		expect(atGlobal.skipped).toHaveLength(0);
	});

	it("still reports the skip when mixed with an agent that does install", () => {
		const codex = findAgent("codex")!;
		const claude = findAgent("claude-code")!;
		const { plan, skipped } = planActions([codex, claude], "project", cwd, false);
		expect(plan).toHaveLength(1);
		expect(skipped.map((s) => s.agent.id)).toEqual(["codex"]);
	});

	it("writes project-scoped Claude Code files under the project, not home", () => {
		const claude = findAgent("claude-code")!;
		const { plan } = planActions([claude], "project", cwd, false);
		for (const action of plan[0].actions) {
			expect(action.dest.startsWith(`${cwd}/.claude/`)).toBe(true);
		}
	});

	it("points the same skill template at Claude Code, Codex, and the shared dir", () => {
		// One canonical template, every destination — that's the whole reason
		// the per-agent skill copies were collapsed.
		const claudeSkill = findAgent("claude-code")!.actions("global", cwd).find((a) => a.kind === "copy-dir");
		const codexSkill = findAgent("codex")!.actions("global", cwd)[0];
		const sharedSkill = findAgent("agents-skills")!.actions("project", cwd)[0];
		expect(claudeSkill?.source).toBe(codexSkill.source);
		expect(sharedSkill.source).toBe(codexSkill.source);
	});

	it("writes the shared skill to .agents/skills at project scope only", () => {
		const shared = findAgent("agents-skills")!;
		expect(shared.scopes).toEqual(["project"]);
		const { plan } = planActions([shared], "project", cwd, false);
		expect(plan[0].actions[0].dest).toBe(`${cwd}/.agents/skills/bpx-council`);
		// No global variant — the per-agent global dirs are fragmented.
		expect(planActions([shared], "global", cwd, false).skipped).toHaveLength(1);
	});
});

describe("agent registry", () => {
	it("gives every agent at least one scope and a unique id", () => {
		const ids = AGENTS.map((a) => a.id);
		expect(new Set(ids).size).toBe(ids.length);
		for (const agent of AGENTS) expect(agent.scopes.length).toBeGreaterThan(0);
	});

	it("returns undefined for an unknown id rather than throwing", () => {
		expect(findAgent("emacs")).toBeUndefined();
	});
});

describe("isPlatformJunk", () => {
	// Found the hard way: installing from a repo on an ExFAT drive shipped a
	// `._SKILL.md` sidecar into .claude/skills/ alongside the real one.
	it("catches AppleDouble sidecars and .DS_Store", () => {
		expect(isPlatformJunk("/t/skills/bpx-council/._SKILL.md")).toBe(true);
		expect(isPlatformJunk("/t/.DS_Store")).toBe(true);
	});

	it("leaves real files alone, including dotfiles that aren't junk", () => {
		expect(isPlatformJunk("/t/skills/bpx-council/SKILL.md")).toBe(false);
		expect(isPlatformJunk("/t/.gitkeep")).toBe(false);
		// A legitimate name merely containing "._" mid-string isn't a sidecar.
		expect(isPlatformJunk("/t/version._backup.md")).toBe(false);
	});

	it("handles Windows paths", () => {
		// Splitting on "/" made this a no-op on Windows: the whole backslash
		// path came back as the "basename" and matched nothing.
		expect(isPlatformJunk("C:\\Users\\g\\templates\\skills\\._SKILL.md")).toBe(true);
		expect(isPlatformJunk("C:\\Users\\g\\templates\\skills\\SKILL.md")).toBe(false);
	});
});

describe("parsePicks", () => {
	it("falls back to the default on empty input", () => {
		expect(parsePicks("", [1, 3], 3)).toEqual([1, 3]);
	});

	it("parses a comma-separated list with spaces", () => {
		expect(parsePicks("1, 2", [], 3)).toEqual([1, 2]);
	});

	it("drops out-of-range and non-numeric entries instead of erroring", () => {
		expect(parsePicks("1,9,abc,2", [], 3)).toEqual([1, 2]);
	});

	it("de-dupes repeats", () => {
		expect(parsePicks("2,2,2", [], 3)).toEqual([2]);
	});
});

describe("symlinkSpec", () => {
	it("uses a relative target on POSIX so the pair survives moving the repo", () => {
		const canonical = "/repo/.agents/skills/bpx-council";
		const link = "/repo/.claude/skills/bpx-council";
		const spec = symlinkSpec(canonical, link, "linux");
		expect(spec.type).toBeUndefined();
		expect(spec.target).toBe("../../.agents/skills/bpx-council");
	});

	it("uses a junction with an absolute target on Windows", () => {
		const canonical = "C:\\repo\\.agents\\skills\\bpx-council";
		const link = "C:\\repo\\.claude\\skills\\bpx-council";
		const spec = symlinkSpec(canonical, link, "win32");
		expect(spec.type).toBe("junction");
		// Junctions require an absolute target — hand back canonical unchanged.
		expect(spec.target).toBe(canonical);
	});
});

describe("canonicalSkillDir", () => {
	it("lands in .agents/skills under cwd for project scope", () => {
		expect(canonicalSkillDir("project", "/proj")).toBe("/proj/.agents/skills/bpx-council");
	});
});

describe("buildGroups", () => {
	const cwd = "/proj";
	const claude = findAgent("claude-code")!;
	const shared = findAgent("agents-skills")!;
	const md = findAgent("agents-md")!;

	function planFor(agents: typeof claude[], scope: "project" | "global") {
		return planActions(agents, scope, cwd, false).plan;
	}

	it("copy mode is a straight relabel — no canonical group, no links", () => {
		const groups = buildGroups(planFor([claude], "project"), "project", cwd, false);
		expect(groups.map((g) => g.label)).toEqual(["Claude Code"]);
		expect(groups.every((g) => g.actions.every((a) => a.kind !== "link-dir"))).toBe(true);
	});

	it("link mode hoists a canonical copy to the front and links the rest", () => {
		const groups = buildGroups(planFor([claude], "project"), "project", cwd, true);
		// First group is the canonical real copy...
		expect(groups[0].actions[0].kind).toBe("copy-dir");
		expect(groups[0].actions[0].dest).toBe("/proj/.agents/skills/bpx-council");
		// ...and Claude Code's skill dir is now a link at it.
		const claudeSkill = groups.flatMap((g) => g.actions).find((a) => a.dest.includes("/.claude/skills/"));
		expect(claudeSkill?.kind).toBe("link-dir");
		expect(claudeSkill?.linkTarget).toBe("/proj/.agents/skills/bpx-council");
	});

	it("reuses an existing .agents/skills action as the canonical instead of duplicating", () => {
		// agents-skills already writes .agents/skills/bpx-council — that becomes
		// the source of truth, not a second copy.
		const groups = buildGroups(planFor([claude, shared], "project"), "project", cwd, true);
		const canonicalCopies = groups
			.flatMap((g) => g.actions)
			.filter((a) => a.kind === "copy-dir" && a.dest === "/proj/.agents/skills/bpx-council");
		expect(canonicalCopies).toHaveLength(1);
	});

	it("keeps non-skill actions (the hook, the AGENTS.md block) untouched", () => {
		const plan = planActions([claude, md], "project", cwd, true).plan; // withHook
		const groups = buildGroups(plan, "project", cwd, true);
		const kinds = groups.flatMap((g) => g.actions).map((a) => a.kind);
		expect(kinds).toContain("merge-json"); // the Stop hook
		expect(kinds).toContain("append-block"); // the AGENTS.md block
	});

	it("is a no-op when nothing being installed is a skill", () => {
		// Only the AGENTS.md block — nothing to link, so no canonical group.
		const groups = buildGroups(planFor([md], "project"), "project", cwd, true);
		expect(groups.map((g) => g.label)).toEqual([md.label]);
		expect(groups[0].actions.every((a) => a.kind !== "link-dir")).toBe(true);
	});

	it("links global Claude Code + Codex at a home-level canonical copy", () => {
		const codex = findAgent("codex")!;
		const plan = planActions([claude, codex], "global", cwd, false).plan;
		const groups = buildGroups(plan, "global", cwd, true);
		// Canonical is synthesized (no agents-skills at global scope).
		expect(groups[0].label).toContain("Canonical");
		const links = groups.flatMap((g) => g.actions).filter((a) => a.kind === "link-dir");
		expect(links).toHaveLength(2); // both Claude Code and Codex link
		expect(links.every((a) => a.linkTarget?.endsWith("/.agents/skills/bpx-council"))).toBe(true);
	});

	it("never emits a link whose dest is the canonical itself", () => {
		// A self-link would rmSync the canonical (treeDiffers(x,x) is false) and
		// leave a dangling link. buildGroups must route that dest to the copy.
		const groups = buildGroups(planFor([claude, shared], "project"), "project", cwd, true);
		const canonical = canonicalSkillDir("project", cwd);
		const selfLinks = groups
			.flatMap((g) => g.actions)
			.filter((a) => a.kind === "link-dir" && a.dest === canonical);
		expect(selfLinks).toHaveLength(0);
	});
});
