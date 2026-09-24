import { cpSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync, existsSync, lstatSync, readlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { runInstall } from "../src/install.js";
import { inspectBlock, removeLegacyHook, runUninstall } from "../src/lifecycle.js";
import { TEMPLATES_ROOT } from "../src/agents.js";

const roots: string[] = [];

/** Isolate every host path under disposable HOME and project root. */
function sandbox(): string {
	const dir = mkdtempSync(join(tmpdir(), "bpx-lifecycle-"));
	roots.push(dir);
	vi.stubEnv("HOME", join(dir, "home"));
	vi.stubEnv("PATH", join(dir, "bin"));
	mkdirSync(join(dir, "home"));
	writeFileSync(join(dir, "package.json"), "{}\n");
	vi.spyOn(console, "log").mockImplementation(() => {});
	vi.spyOn(console, "error").mockImplementation(() => {});
	return dir;
}

/** Read captured diagnostics across stdout and stderr. */
function output(): string {
	return [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].flat().join(" ");
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Phase B lifecycle", () => {
	it("parses verify and uninstall without widening invalid selection", () => {
		expect(parseArgs(["install", "--verify", "--agent", "codex"]).install.verify).toBe(true);
		expect(parseArgs(["uninstall", "--agent", "codex,claude-code", "--dry-run"]).command).toBe("uninstall");
		expect(parseArgs(["uninstall", "--verify"]).unknown).toContain("--verify");
		expect(parseArgs(["install", "--verify", "--yes"]).unknown).not.toHaveLength(0);
		expect(parseArgs(["uninstall", "--agent"]).unknown).toContain("--agent (missing value)");
		for (const command of ["install", "uninstall"]) for (const value of [",", " , ", "codex,", ",codex"]) {
			const parsed = parseArgs([command, "--agent", value]);
			expect(parsed.unknown).toContain("--agent (blank agent)");
		}
	});

	it("verifies missing, current, drifted without writing or calling a CLI", async () => {
		const dir = sandbox();
		const opts = { agents: ["codex"], cwd: dir };
		expect(await runInstall({ ...opts, verify: true })).toBe(1);
		expect(output()).toContain("missing");
		expect(existsSync(join(dir, ".agents"))).toBe(false);
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		expect(await runInstall({ ...opts, verify: true })).toBe(0);
		const file = join(dir, ".agents", "skills", "bpx-council", "SKILL.md");
		writeFileSync(file, "edited\n");
		expect(await runInstall({ ...opts, verify: true })).toBe(1);
		expect(output()).toContain("drifted");
	});

	it("verify finds duplicate OpenCode discovery even when install planning dedupes it", async () => {
		const dir = sandbox();
		expect(await runInstall({ agents: ["opencode"], cwd: dir, yes: true })).toBe(0);
		// Simulate historical duplicate: new installer refuses to create it.
		const shared = join(dir, ".agents", "skills", "bpx-council");
		mkdirSync(join(dir, ".agents", "skills"), { recursive: true });
		cpSync(join(TEMPLATES_ROOT, "skills", "bpx-council"), shared, { recursive: true, filter: (path) => !path.split(/[\\/]/).pop()!.startsWith("._") });
		writeFileSync(join(dir, ".opencode", "skills", "bpx-council", "SKILL.md"), "edited native skill\n");
		expect(await runInstall({ agents: ["opencode", "codex"], cwd: dir, verify: true })).toBe(1);
		expect(output()).toContain("OpenCode duplicate skill: drifted");
	});

	it("accepts one shared skill as OpenCode's only discoverable copy", async () => {
		const dir = sandbox();
		expect(await runInstall({ agents: ["codex"], cwd: dir, yes: true })).toBe(0);
		// Native command is installed while the shared skill is reused.
		expect(await runInstall({ agents: ["opencode", "codex"], cwd: dir, yes: true })).toBe(0);
		expect(await runInstall({ agents: ["opencode"], cwd: dir, verify: true })).toBe(0);
		expect(output()).toContain("OpenCode: current");
	});

	it("refuses extra skill files on reinstall and uninstall; never calls tree owned by name", async () => {
		const dir = sandbox();
		const opts = { agents: ["codex"], cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		const skill = join(dir, ".agents", "skills", "bpx-council");
		writeFileSync(join(skill, "notes.md"), "mine\n");
		expect(await runInstall({ ...opts, dryRun: true })).toBe(1);
		expect(await runInstall({ ...opts, yes: true })).toBe(1);
		expect(await runUninstall({ ...opts, dryRun: true })).toBe(1);
		expect(await runUninstall({ ...opts, yes: true })).toBe(1);
		expect(readFileSync(join(skill, "notes.md"), "utf8")).toBe("mine\n");
		expect(output()).toContain("clean up manually");
	});

	it("refuses foreign symlink, including broken nested link, on install and uninstall", async () => {
		const dir = sandbox();
		const skill = join(dir, ".agents", "skills", "bpx-council");
		mkdirSync(skill, { recursive: true });
		symlinkSync(join(dir, "absent"), join(skill, "SKILL.md"));
		const opts = { agents: ["codex"], cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(1);
		expect(await runUninstall({ ...opts, yes: true })).toBe(1);
		expect(readFileSync(join(TEMPLATES_ROOT, "skills", "bpx-council", "SKILL.md"), "utf8").length).toBeGreaterThan(0);
	});

	it("removes exact block only, keeping user text and refusing edited/malformed blocks", async () => {
		const dir = sandbox();
		const file = join(dir, "AGENTS.md");
		writeFileSync(file, "# User\n");
		const opts = { agents: ["agents-md"], cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		expect(await runUninstall({ ...opts, yes: true })).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("# User\n");
		const legacy = readFileSync(join(TEMPLATES_ROOT, "agents-md", "AGENTS.md.legacy.snippet"), "utf8");
		writeFileSync(file, `# User\n\n${legacy}`);
		expect(await runUninstall({ ...opts, yes: true })).toBe(0);
		expect(readFileSync(file, "utf8")).toBe("# User\n");
		for (const value of ["<!-- bpx-council:start -->\nuser", legacy.replace("second opinions", "my opinions")]) {
			writeFileSync(file, `# User\n\n${value}`);
			expect(await runUninstall({ ...opts, yes: true })).toBe(1);
			expect(readFileSync(file, "utf8")).toBe(`# User\n\n${value}`);
		}
		expect(inspectBlock("plain").state).toBe("missing");
	});

	it("removes only exact retired hook and preserves unrelated settings and hooks", async () => {
		const dir = sandbox();
		const file = join(dir, ".claude", "settings.json");
		mkdirSync(join(dir, ".claude"));
		const exact = JSON.parse(readFileSync(join(TEMPLATES_ROOT, "claude-code", "hooks-settings.json"), "utf8")).hooks.Stop[0];
		const other = { hooks: [{ type: "command", command: "notify-send done" }] };
		const settings = { model: "opus", hooks: { PreToolUse: [{ matcher: "Bash" }], Stop: [other, exact] } };
		writeFileSync(file, JSON.stringify(settings));
		const opts = { agents: ["claude-code"], cwd: dir };
		expect(await runInstall({ ...opts, verify: true })).toBe(1);
		expect(await runUninstall({ ...opts, dryRun: true })).toBe(0);
		expect(readFileSync(file, "utf8")).toBe(JSON.stringify(settings));
		expect(await runUninstall({ ...opts, yes: true })).toBe(0);
		expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ model: "opus", hooks: { PreToolUse: [{ matcher: "Bash" }], Stop: [other] } });
		expect(removeLegacyHook({ hooks: { Stop: [exact] } }).state).toBe("current");
	});

	it("refuses malformed or edited similar Stop entry without touching settings", async () => {
		const dir = sandbox();
		const file = join(dir, ".claude", "settings.json");
		mkdirSync(join(dir, ".claude"));
		const exact = JSON.parse(readFileSync(join(TEMPLATES_ROOT, "claude-code", "hooks-settings.json"), "utf8")).hooks.Stop[0];
		for (const settings of [{ hooks: { Stop: {} } }, { hooks: { Stop: [exact, { hooks: [{ type: "command", command: "bpx-council --mode solo 'mine'" }] }] } }, { hooks: [] }]) {
			const original = JSON.stringify(settings);
			writeFileSync(file, original);
			expect(await runUninstall({ agents: ["claude-code"], cwd: dir, yes: true })).toBe(1);
			expect(readFileSync(file, "utf8")).toBe(original);
		}
	});

	it("removes canonical only after selected links and protects it when unselected host shares it", async () => {
		const dir = sandbox();
		const canonical = join(dir, ".agents", "skills", "bpx-council");
		const claude = join(dir, ".claude", "skills", "bpx-council");
		expect(await runInstall({ agents: ["codex", "claude-code"], cwd: dir, link: true, yes: true })).toBe(0);
		expect(await runUninstall({ agents: ["codex"], cwd: dir, yes: true })).toBe(1);
		expect(existsSync(canonical)).toBe(true);
		expect(existsSync(claude)).toBe(true);
		expect(await runUninstall({ agents: ["codex", "claude-code"], cwd: dir, yes: true })).toBe(0);
		expect(existsSync(canonical)).toBe(false);
		expect(existsSync(claude)).toBe(false);
	});

	it("reports partial removal and nonzero when one selected action is edited", async () => {
		const dir = sandbox();
		const opts = { agents: ["claude-code"], cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		const skill = join(dir, ".claude", "skills", "bpx-council");
		writeFileSync(join(skill, "notes.md"), "mine\n");
		expect(await runUninstall({ ...opts, yes: true })).toBe(1);
		expect(existsSync(skill)).toBe(true);
		expect(existsSync(join(dir, ".claude", "commands", "council.md"))).toBe(false);
		expect(output()).toContain("action(s) failed");
	});

	it("refuses linked parent directories and dangling command symlinks", async () => {
		const dir = sandbox();
		const real = join(dir, "foreign");
		mkdirSync(join(real, "commands"), { recursive: true });
		symlinkSync(real, join(dir, ".claude"));
		const opts = { agents: ["claude-code"], cwd: dir };
		expect(await runUninstall({ ...opts, yes: true })).toBe(1);
		expect(output()).toContain("symlinked parent directory");
		rmSync(join(dir, ".claude"));
		mkdirSync(join(dir, ".claude", "commands"), { recursive: true });
		symlinkSync(join(dir, "absent"), join(dir, ".claude", "commands", "council.md"));
		expect(await runInstall({ ...opts, yes: true })).toBe(1);
		expect(await runUninstall({ ...opts, yes: true })).toBe(1);
	});

	it.each(["project", "global"] as const)("refuses linked parent and dangling AGENTS.md without writing in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const foreign = join(dir, "foreign");
		mkdirSync(foreign);
		symlinkSync(foreign, join(base, ".claude"));
		const opts = { agents: ["claude-code"], scope, cwd: dir };
		expect(await runInstall({ ...opts, dryRun: true })).toBe(1);
		expect(await runInstall({ ...opts, yes: true })).toBe(1);
		expect(existsSync(join(foreign, "skills"))).toBe(false);
		expect(output()).toContain("symlinked parent directory");
		if (scope === "project") {
			const file = join(dir, "AGENTS.md");
			symlinkSync(join(dir, "missing-target"), file);
			expect(await runInstall({ agents: ["agents-md"], cwd: dir, dryRun: true })).toBe(1);
			expect(await runInstall({ agents: ["agents-md"], cwd: dir, yes: true })).toBe(1);
			expect(lstatSync(file).isSymbolicLink()).toBe(true);
			expect(readlinkSync(file)).toBe(join(dir, "missing-target"));
			rmSync(file);
			const target = join(dir, "user-notes.md");
			writeFileSync(target, "# Keep these notes\n");
			symlinkSync(target, file);
			expect(await runInstall({ agents: ["agents-md"], cwd: dir, dryRun: true })).toBe(1);
			expect(await runInstall({ agents: ["agents-md"], cwd: dir, yes: true })).toBe(1);
			expect(lstatSync(file).isSymbolicLink()).toBe(true);
			expect(readFileSync(target, "utf8")).toBe("# Keep these notes\n");
		}
	});

	it.each(["project", "global"] as const)("stops links if canonical copy fails in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const canonical = join(base, ".agents", "skills", "bpx-council");
		const linked = join(base, ".claude", "skills", "bpx-council");
		mkdirSync(canonical, { recursive: true });
		writeFileSync(join(canonical, "personal.md"), "do not delete\n");
		const opts = { agents: ["claude-code"], scope, cwd: dir, link: true };
		expect(await runInstall({ ...opts, dryRun: true })).toBe(1);
		expect(output()).toContain("[blocked]");
		expect(await runInstall({ ...opts, yes: true })).toBe(1);
		expect(existsSync(linked)).toBe(false);
		expect(readFileSync(join(canonical, "personal.md"), "utf8")).toBe("do not delete\n");
		expect(output()).toContain("canonical copy failed — link not created");
	});

	it.each(["project", "global"] as const)("inventories deduped host skills and removes last link canonical in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const opencode = join(scope === "global" ? join(base, ".config", "opencode") : join(base, ".opencode"), "skills", "bpx-council");
		const canonical = join(base, ".agents", "skills", "bpx-council");
		expect(await runInstall({ agents: ["opencode"], scope, cwd: dir, yes: true })).toBe(0);
		// Existing historical duplicate stays inspectable/removable, but cannot
		// be produced by a fresh Codex install beside a native OpenCode skill.
		const source = join(TEMPLATES_ROOT, "skills", "bpx-council");
		mkdirSync(join(base, ".agents", "skills"), { recursive: true });
		cpSync(source, canonical, { recursive: true, filter: (path) => !path.split(/[\\/]/).pop()!.startsWith("._") });
		expect(await runUninstall({ agents: ["opencode", "codex"], scope, cwd: dir, yes: true })).toBe(0);
		expect(existsSync(opencode)).toBe(false);
		expect(existsSync(canonical)).toBe(false);
		expect(await runInstall({ agents: ["claude-code"], scope, cwd: dir, link: true, yes: true })).toBe(0);
		expect(await runUninstall({ agents: ["claude-code"], scope, cwd: dir, yes: true })).toBe(1);
		expect(existsSync(canonical)).toBe(true);
		expect(output()).toContain("Canonical skill retained");
		expect(await runUninstall({ agents: ["codex"], scope, cwd: dir, yes: true })).toBe(0);
		expect(existsSync(canonical)).toBe(false);
	});

	it.each(["project", "global"] as const)("previews link replacement using template before canonical exists in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const skill = join(base, ".claude", "skills", "bpx-council");
		const opts = { agents: ["claude-code"], scope, cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		expect(await runInstall({ ...opts, link: true, dryRun: true })).toBe(0);
		expect(output()).toContain(`[overwrite] ${skill}`);
		expect(await runInstall({ ...opts, link: true, yes: true })).toBe(0);
		expect(lstatSync(skill).isSymbolicLink()).toBe(true);
	});

	it.each(["project", "global"] as const)("warns about paid retired Stop hook during ordinary Claude install in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const settings = join(base, ".claude", "settings.json");
		mkdirSync(join(base, ".claude"), { recursive: true });
		const legacy = readFileSync(join(TEMPLATES_ROOT, "claude-code", "hooks-settings.json"), "utf8");
		writeFileSync(settings, legacy);
		expect(await runInstall({ agents: ["claude-code"], scope, cwd: dir, yes: true })).toBe(0);
		expect(readFileSync(settings, "utf8")).toBe(legacy);
		expect(output()).toContain("Retired Claude Stop hook remains");
	});

	it.each(["project", "global"] as const)("keeps shared canonical until final registered linked consumer leaves in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const canonical = join(base, ".agents", "skills", "bpx-council");
		const opts = { scope, cwd: dir };
		expect(await runInstall({ ...opts, agents: ["claude-code", "opencode"], link: true, yes: true })).toBe(0);
		expect(await runUninstall({ ...opts, agents: ["claude-code"], yes: true })).toBe(1);
		expect(existsSync(canonical)).toBe(true);
		expect(await runUninstall({ ...opts, agents: ["opencode"], yes: true })).toBe(1);
		expect(existsSync(canonical)).toBe(true);
		expect(await runUninstall({ ...opts, agents: ["codex"], yes: true })).toBe(0);
		expect(existsSync(canonical)).toBe(false);
	});

	it.each(["project", "global"] as const)("defaults to installed artifacts without a host binary in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home", ".config", "opencode") : join(dir, ".opencode");
		expect(await runInstall({ agents: ["opencode"], scope, cwd: dir, yes: true })).toBe(0);
		const verify = await runInstall({ scope, cwd: dir, verify: true });
		expect(verify).toBe(scope === "project" ? 1 : 0); // Project AGENTS.md remains uninstalled.
		expect(output()).toContain("OpenCode: current");
		expect(await runUninstall({ scope, cwd: dir, yes: true })).toBe(0);
		expect(existsSync(join(base, "skills", "bpx-council"))).toBe(false);
	});

	it.each(["project", "global"] as const)("keeps canonical while OpenCode command depends on it in %s scope", async (scope) => {
		const dir = sandbox();
		const base = scope === "global" ? join(dir, "home") : dir;
		const canonical = join(base, ".agents", "skills", "bpx-council");
		const native = join(scope === "global" ? join(base, ".config", "opencode") : join(base, ".opencode"), "skills", "bpx-council");
		const command = join(scope === "global" ? join(base, ".config", "opencode") : join(base, ".opencode"), "commands", "council.md");
		const opts = { scope, cwd: dir };
		expect(await runInstall({ ...opts, agents: ["codex", "opencode"], yes: true })).toBe(0);
		expect(existsSync(native)).toBe(false);
		expect(existsSync(command)).toBe(true);
		expect(await runUninstall({ ...opts, agents: ["codex"], dryRun: true })).toBe(1);
		expect(await runUninstall({ ...opts, agents: ["codex"], yes: true })).toBe(1);
		expect(existsSync(canonical)).toBe(true);
		expect(readFileSync(command, "utf8")).toContain("$ARGUMENTS");
		expect(output()).toContain("OpenCode command still uses shared skill");
		expect(await runUninstall({ ...opts, agents: ["codex", "opencode"], dryRun: true })).toBe(0);
		expect(await runUninstall({ ...opts, agents: ["codex", "opencode"], yes: true })).toBe(0);
		expect(existsSync(canonical)).toBe(false);
		expect(existsSync(command)).toBe(false);
	});

	it("migrates exact legacy marked block without disturbing surrounding notes", async () => {
		const dir = sandbox();
		const file = join(dir, "AGENTS.md");
		const legacy = readFileSync(join(TEMPLATES_ROOT, "agents-md/AGENTS.md.legacy.snippet"), "utf8").trim();
		writeFileSync(file, `# Keep\n\n${legacy}\n\n## Keep this too\n`);
		const opts = { agents: ["agents-md"], cwd: dir };
		expect(await runInstall({ ...opts, dryRun: true })).toBe(0);
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		const result = readFileSync(file, "utf8");
		expect(result).toContain("# Keep\n");
		expect(result).toContain("## Keep this too\n");
		expect(result).toContain("Ask a narrow question.");
		expect(result).not.toContain("## bpx-council — second opinions");
	});

	it("refuses reinstall over an edited marked AGENTS.md block", async () => {
		const dir = sandbox();
		const file = join(dir, "AGENTS.md");
		const opts = { agents: ["agents-md"], cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		const changed = readFileSync(file, "utf8").replace("Ask a narrow question.", "Send every file.");
		writeFileSync(file, changed);
		expect(await runInstall({ ...opts, dryRun: true })).toBe(1);
		expect(await runInstall({ ...opts, yes: true })).toBe(1);
		expect(readFileSync(file, "utf8")).toBe(changed);
	});

	it("never deletes an unselected Codex skill when removing a Claude link", async () => {
		const dir = sandbox();
		const canonical = join(dir, ".agents", "skills", "bpx-council");
		expect(await runInstall({ agents: ["codex", "claude-code"], cwd: dir, link: true, yes: true })).toBe(0);
		expect(await runUninstall({ agents: ["claude-code"], cwd: dir, dryRun: true })).toBe(1);
		expect(await runUninstall({ agents: ["claude-code"], cwd: dir, yes: true })).toBe(1);
		expect(existsSync(canonical)).toBe(true);
		expect(await runInstall({ agents: ["codex"], cwd: dir, verify: true })).toBe(0);
	});

	it("requires explicit yes when headless; dry run does not prompt or mutate", async () => {
		const dir = sandbox();
		const opts = { agents: ["codex"], cwd: dir };
		expect(await runInstall({ ...opts, yes: true })).toBe(0);
		expect(await runUninstall(opts)).toBe(1);
		expect(await runUninstall({ ...opts, dryRun: true })).toBe(0);
		expect(existsSync(join(dir, ".agents", "skills", "bpx-council"))).toBe(true);
	});
});
