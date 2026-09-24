import { chmodSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AGENTS, findAgent } from "../src/agents.js";
import { runInstall, writeFileAtomic } from "../src/install.js";

const fault = vi.hoisted(() => ({ symlink: false, copy: false, rename: false, atomic: false, partialWrite: false, cleanup: false }));
vi.mock("node:fs", async (importOriginal) => {
	const fs = await importOriginal<typeof import("node:fs")>();
	return {
		...fs,
		symlinkSync: ((...args: Parameters<typeof fs.symlinkSync>) => {
			if (fault.symlink && String(args[1]).includes(".bpx-council-stage-")) throw new Error("injected symlink failure");
			return fs.symlinkSync(...args);
		}) as typeof fs.symlinkSync,
		cpSync: ((...args: Parameters<typeof fs.cpSync>) => {
			if (fault.copy && String(args[1]).includes(".bpx-council-stage-")) throw new Error("injected copy failure");
			return fs.cpSync(...args);
		}) as typeof fs.cpSync,
		renameSync: ((...args: Parameters<typeof fs.renameSync>) => {
			if (fault.rename && String(args[0]).includes(".bpx-council-stage-") && String(args[0]).endsWith("/next")) throw new Error("injected rename failure");
			if (fault.atomic && String(args[0]).includes(".bpx-council-") && String(args[0]).endsWith(".tmp")) throw new Error("injected atomic rename failure");
			return fs.renameSync(...args);
		}) as typeof fs.renameSync,
		writeFileSync: ((...args: Parameters<typeof fs.writeFileSync>) => {
			if (fault.partialWrite && typeof args[0] === "number") {
				fs.writeFileSync(args[0], "partial");
				throw new Error("injected partial write failure");
			}
			return fs.writeFileSync(...args);
		}) as typeof fs.writeFileSync,
		rmSync: ((...args: Parameters<typeof fs.rmSync>) => {
			if (fault.cleanup && String(args[0]).includes(".bpx-council-stage-")) throw new Error("injected cleanup failure");
			return fs.rmSync(...args);
		}) as typeof fs.rmSync,
	};
});

const scratch: string[] = [];

/** Make disposable test root without touching real host config. */
function root(): string {
	const dir = mkdtempSync(join(tmpdir(), "bpx-host-install-"));
	scratch.push(dir);
	writeFileSync(join(dir, "package.json"), "{}\n");
	return dir;
}

/** Put detectable, never-executed stub CLI on PATH. */
function fakeCli(dir: string, name: string): void {
	const bin = join(dir, "bin");
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(bin, name), "#!/bin/sh\nexit 77\n");
	chmodSync(join(bin, name), 0o755);
	vi.stubEnv("PATH", bin);
}

afterEach(() => {
	fault.symlink = fault.copy = fault.rename = fault.atomic = fault.partialWrite = fault.cleanup = false;
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("host install without provider calls", () => {
	it("detects first-class hosts via fake executable; never auto-selects shared option", () => {
		const dir = root();
		fakeCli(dir, "opencode");
		expect(findAgent("opencode")!.detect()).toBe(true);
		expect(findAgent("agents-skills")!.detect()).toBe(false);
		expect(AGENTS.filter((agent) => agent.detect()).map((agent) => agent.id)).toContain("opencode");
	});

	it("writes global Codex to new path and reports old path without migrating it", async () => {
		const dir = root();
		vi.stubEnv("HOME", join(dir, "home"));
		fakeCli(dir, "codex");
		const legacy = join(dir, "home", ".codex", "skills", "bpx-council", "SKILL.md");
		mkdirSync(join(dir, "home", ".codex", "skills", "bpx-council"), { recursive: true });
		writeFileSync(legacy, "legacy user copy\n");
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await runInstall({ agents: ["codex"], scope: "global", yes: true, cwd: dir })).toBe(0);
		expect(readFileSync(legacy, "utf8")).toBe("legacy user copy\n");
		expect(existsSync(join(dir, "home", ".agents", "skills", "bpx-council", "SKILL.md"))).toBe(true);
		expect(error.mock.calls.flat().join(" ")).toContain("not migrated or removed");
	});

	it("writes OpenCode project command and skill without running fake CLI", async () => {
		const dir = root();
		vi.stubEnv("HOME", join(dir, "home"));
		fakeCli(dir, "opencode");
		vi.spyOn(console, "log").mockImplementation(() => {});
		expect(await runInstall({ agents: ["opencode"], yes: true, cwd: dir })).toBe(0);
		expect(existsSync(join(dir, ".opencode", "skills", "bpx-council", "SKILL.md"))).toBe(true);
		expect(readFileSync(join(dir, ".opencode", "commands", "council.md"), "utf8")).toContain("$ARGUMENTS");
	});

	it.each(["project", "global"] as const)("refuses duplicate OpenCode skill before any writes in %s scope", async (scope) => {
		const dir = root();
		vi.stubEnv("HOME", join(dir, "home"));
		mkdirSync(join(dir, "home"));
		const base = scope === "global" ? join(dir, "home") : dir;
		const native = join(scope === "global" ? join(base, ".config", "opencode") : join(base, ".opencode"), "skills", "bpx-council");
		const shared = join(base, ".agents", "skills", "bpx-council");
		vi.spyOn(console, "log").mockImplementation(() => {});
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runInstall({ agents: ["opencode"], scope, cwd: dir, yes: true })).toBe(0);
		for (const dryRun of [true, false]) {
			expect(await runInstall({ agents: ["codex", "opencode"], scope, cwd: dir, dryRun, yes: !dryRun })).toBe(1);
			expect(existsSync(shared)).toBe(false);
			expect(existsSync(native)).toBe(true);
		}
		expect(error.mock.calls.flat().join(" ")).toContain("no files written");
		rmSync(native, { recursive: true });
		expect(await runInstall({ agents: ["codex"], scope, cwd: dir, yes: true })).toBe(0);
		const command = join(scope === "global" ? join(base, ".config", "opencode") : join(base, ".opencode"), "commands", "council.md");
		for (const dryRun of [true, false]) {
			expect(await runInstall({ agents: ["opencode"], scope, cwd: dir, dryRun, yes: !dryRun })).toBe(1);
			expect(existsSync(native)).toBe(false);
			expect(existsSync(command)).toBe(true);
		}
	});

	it("refuses global shared skill beside current project's native OpenCode skill", async () => {
		const dir = root();
		const home = join(dir, "home");
		vi.stubEnv("HOME", home);
		mkdirSync(home);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runInstall({ agents: ["opencode"], cwd: dir, yes: true })).toBe(0);
		const globalShared = join(home, ".agents", "skills", "bpx-council");
		for (const dryRun of [true, false]) {
			expect(await runInstall({ agents: ["codex"], scope: "global", cwd: dir, dryRun, yes: !dryRun })).toBe(1);
			expect(existsSync(globalShared)).toBe(false);
		}
		expect(existsSync(join(dir, ".opencode", "skills", "bpx-council", "SKILL.md"))).toBe(true);
	});

	it("refuses project native OpenCode skill beside existing global shared skill", async () => {
		const dir = root();
		const home = join(dir, "home");
		vi.stubEnv("HOME", home);
		mkdirSync(home);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runInstall({ agents: ["codex"], scope: "global", cwd: dir, yes: true })).toBe(0);
		for (const dryRun of [true, false]) {
			expect(await runInstall({ agents: ["opencode"], cwd: dir, dryRun, yes: !dryRun })).toBe(1);
			expect(existsSync(join(dir, ".opencode"))).toBe(false);
		}
		expect(existsSync(join(home, ".agents", "skills", "bpx-council", "SKILL.md"))).toBe(true);
	});

	it("reports installed tree plus cleanup warning when staging cleanup fails", async () => {
		const dir = root();
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const opts = { agents: ["claude-code"], cwd: dir, yes: true };
		expect(await runInstall(opts)).toBe(0);
		const skill = join(dir, ".claude", "skills", "bpx-council");
		writeFileSync(join(skill, "SKILL.md"), "old owned content\n");
		fault.cleanup = true;
		expect(await runInstall(opts)).toBe(0);
		fault.cleanup = false;
		expect(readFileSync(join(skill, "SKILL.md"), "utf8")).not.toBe("old owned content\n");
		expect(log.mock.calls.flat().join(" ")).toContain("installed, but could not clean staging directory");
		const leftovers = readdirSync(join(dir, ".claude", "skills")).filter((name) => name.startsWith(".bpx-council-stage-"));
		expect(leftovers).toHaveLength(1);
		rmSync(join(dir, ".claude", "skills", leftovers[0]), { recursive: true });
	});

	it("copy-file refresh survives partial staged write and preserves mode", async () => {
		const dir = root();
		vi.stubEnv("HOME", join(dir, "home"));
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const opts = { agents: ["opencode"], cwd: dir, yes: true };
		expect(await runInstall(opts)).toBe(0);
		const command = join(dir, ".opencode", "commands", "council.md");
		writeFileSync(command, "prior owned command\n");
		chmodSync(command, 0o600);
		fault.partialWrite = true;
		expect(await runInstall(opts)).toBe(1);
		expect(readFileSync(command, "utf8")).toBe("prior owned command\n");
		expect(statSync(command).mode & 0o777).toBe(0o600);
		expect(readdirSync(join(dir, ".opencode", "commands")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
		fault.partialWrite = false;
		expect(await runInstall(opts)).toBe(0);
		expect(readFileSync(command, "utf8")).toContain("$ARGUMENTS");
		expect(statSync(command).mode & 0o777).toBe(0o600);
	});

	it("refuses foreign command symlink instead of changing its target", async () => {
		const dir = root();
		vi.stubEnv("HOME", join(dir, "home"));
		const commandDir = join(dir, ".opencode", "commands");
		mkdirSync(commandDir, { recursive: true });
		const foreign = join(dir, "foreign.md");
		writeFileSync(foreign, "mine\n");
		const command = join(commandDir, "council.md");
		symlinkSync(foreign, command);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runInstall({ agents: ["opencode"], cwd: dir, dryRun: true })).toBe(1);
		expect(await runInstall({ agents: ["opencode"], cwd: dir, yes: true })).toBe(1);
		expect(lstatSync(command).isSymbolicLink()).toBe(true);
		expect(readFileSync(foreign, "utf8")).toBe("mine\n");
	});

	it("stages link replacement and retains original if symlink and copy both fail", async () => {
		const dir = root();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const opts = { agents: ["claude-code"], cwd: dir, yes: true };
		expect(await runInstall(opts)).toBe(0);
		const skill = join(dir, ".claude", "skills", "bpx-council");
		const original = readFileSync(join(skill, "SKILL.md"));
		fault.symlink = fault.copy = true;
		expect(await runInstall({ ...opts, link: true })).toBe(1);
		expect(lstatSync(skill).isDirectory()).toBe(true);
		expect(readFileSync(join(skill, "SKILL.md"))).toEqual(original);
		fault.copy = false;
		expect(await runInstall({ ...opts, link: true })).toBe(0);
		expect(lstatSync(skill).isDirectory()).toBe(true); // copy fallback
	});

	it("staged copy refresh leaves original unchanged on copy failure", async () => {
		const dir = root();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const opts = { agents: ["claude-code"], cwd: dir, yes: true };
		expect(await runInstall(opts)).toBe(0);
		const skill = join(dir, ".claude", "skills", "bpx-council");
		const file = join(skill, "SKILL.md");
		writeFileSync(file, "older owned copy\n");
		fault.copy = true;
		expect(await runInstall(opts)).toBe(1);
		expect(readFileSync(file, "utf8")).toBe("older owned copy\n");
		expect(readdirSync(join(dir, ".claude", "skills")).filter((name) => name.startsWith(".bpx-council-stage-"))).toEqual([]);
	});

	it("rolls back original when staged symlink rename fails", async () => {
		const dir = root();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		const opts = { agents: ["claude-code"], cwd: dir, yes: true };
		expect(await runInstall(opts)).toBe(0);
		const skill = join(dir, ".claude", "skills", "bpx-council");
		const original = readFileSync(join(skill, "SKILL.md"));
		fault.rename = true;
		expect(await runInstall({ ...opts, link: true })).toBe(1);
		expect(lstatSync(skill).isDirectory()).toBe(true);
		expect(readFileSync(join(skill, "SKILL.md"))).toEqual(original);
		expect(readdirSync(join(dir, ".claude", "skills")).filter((name) => name.startsWith(".bpx-council-stage-"))).toEqual([]);
	});

	it("atomic writes leave fixed sibling untouched, preserve mode and clean owned temp on failure", () => {
		const dir = root();
		const dest = join(dir, "AGENTS.md");
		const sibling = `${dest}.bpx-council-tmp`;
		writeFileSync(dest, "original\n");
		writeFileSync(sibling, "someone else's file\n");
		chmodSync(dest, 0o600);
		writeFileAtomic(dest, "updated\n");
		expect(readFileSync(dest, "utf8")).toBe("updated\n");
		expect(statSync(dest).mode & 0o777).toBe(0o600);
		expect(readFileSync(sibling, "utf8")).toBe("someone else's file\n");
		fault.atomic = true;
		expect(() => writeFileAtomic(dest, "failed\n")).toThrow("injected atomic rename failure");
		expect(readFileSync(dest, "utf8")).toBe("updated\n");
		expect(readFileSync(sibling, "utf8")).toBe("someone else's file\n");
		expect(readdirSync(dir).filter((name) => name.endsWith(".tmp"))).toEqual([]);
	});

	it("refuses retired hook even on dry run and never modifies Claude settings", async () => {
		const dir = root();
		const settings = join(dir, ".claude", "settings.json");
		mkdirSync(join(dir, ".claude"));
		writeFileSync(settings, '{"hooks":{"Stop":[]}}\n');
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		expect(await runInstall({ agents: ["claude-code"], withHook: true, dryRun: true, cwd: dir })).toBe(1);
		expect(readFileSync(settings, "utf8")).toBe('{"hooks":{"Stop":[]}}\n');
		expect(error.mock.calls.flat().join(" ")).toContain("--with-hook is retired");
	});

	it("does not invoke wizard or confirmation on TTY dry run", async () => {
		const dir = root();
		fakeCli(dir, "codex");
		const original = Object.getOwnPropertyDescriptor(process.stdin, "isTTY");
		Object.defineProperty(process.stdin, "isTTY", { configurable: true, value: true });
		const log = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			expect(await runInstall({ dryRun: true, cwd: dir })).toBe(0);
			expect(log.mock.calls.flat().join(" ")).toContain("Dry run");
			expect(existsSync(join(dir, ".agents"))).toBe(false);
		} finally {
			if (original) Object.defineProperty(process.stdin, "isTTY", original);
			else Reflect.deleteProperty(process.stdin, "isTTY");
		}
	});
});
