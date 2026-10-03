import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { projectTargetIsGlobal } from "../src/config-target.js";

const tsx = resolve("node_modules/tsx/dist/cli.mjs");
const entry = resolve("src/index.ts");
let root: string;
let home: string;
let oldHome: string | undefined;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bpx-config-target-"));
	home = join(root, "home");
	mkdirSync(home);
	oldHome = process.env.HOME;
	process.env.HOME = home;
});

afterEach(() => {
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	rmSync(root, { recursive: true, force: true });
});

describe("project config write boundary", () => {
	it("recognizes home with lexical normalization and without an existing file", () => {
		expect(projectTargetIsGlobal(`${home}/./.bpx-council.json`)).toBe(true);
		expect(projectTargetIsGlobal(`${home}/unused/../.bpx-council.json`)).toBe(true);
	});

	it("recognizes a home directory alias", () => {
		const alias = join(root, "home-link");
		symlinkSync(home, alias, "dir");
		expect(projectTargetIsGlobal(join(alias, ".bpx-council.json"))).toBe(true);
	});

	it("does not confuse descendants, other filenames, or distinct file symlinks with global", () => {
		const project = join(home, "project");
		mkdirSync(project);
		writeFileSync(join(home, ".bpx-council.json"), "{}");
		symlinkSync(join(home, ".bpx-council.json"), join(project, ".bpx-council.json"));
		expect(projectTargetIsGlobal(join(project, ".bpx-council.json"))).toBe(false);
		expect(projectTargetIsGlobal(join(home, "other.json"))).toBe(false);
	});

	it.each([false, true])("refuses a project write from home (alias=%s), leaving bytes untouched", (alias) => {
		const path = join(home, ".bpx-council.json");
		const contents = '{"defaultMode":"debate","solo":{}}\n';
		writeFileSync(path, contents);
		mkdirSync(join(home, ".git"));
		let cwd = home;
		if (alias) {
			cwd = join(root, "home-link");
			symlinkSync(home, cwd, "dir");
		}
		const result = spawnSync(process.execPath, [tsx, entry, "config", "--yes", "--scope", "project", "--backend", "anthropic"], {
			cwd,
			env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "fake-key-no-network", NO_COLOR: "1" },
			encoding: "utf8",
			timeout: 15_000,
		});
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("Project config would overwrite global settings");
		expect(readFileSync(path, "utf8")).toBe(contents);
	});
});
