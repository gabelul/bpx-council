/**
 * config resolution tests.
 *
 * The layering — defaults ← global ← project, project overriding key-by-key — is
 * the part a user's config depends on. A wrong merge either ignores their
 * project override or franken-merges two backends into a broken one.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type BpxCouncilConfig, DEFAULT_CONFIG, mergeConfigs, projectConfigPath, projectConfigWritePath, resolveConfig } from "../src/config.js";

const BASE: BpxCouncilConfig = {
	defaultMode: "solo",
	solo: { model: "auto", thinkingLevel: "medium", backend: { type: "cli", command: "codex" } },
	contextWindow: 200_000,
};

describe("mergeConfigs", () => {
	it("overrides only the keys the top layer sets", () => {
		const merged = mergeConfigs(BASE, { defaultMode: "council" });
		expect(merged.defaultMode).toBe("council");
		expect(merged.solo.backend).toEqual({ type: "cli", command: "codex" }); // inherited
		expect(merged.contextWindow).toBe(200_000); // inherited
	});

	it("replaces solo.backend atomically (no franken-merge of cli + http)", () => {
		const merged = mergeConfigs(BASE, { solo: { model: "auto", backend: { type: "http", provider: "anthropic" } } });
		expect(merged.solo.backend).toEqual({ type: "http", provider: "anthropic" });
		// no leftover `command` from the cli backend
		expect((merged.solo.backend as { command?: string }).command).toBeUndefined();
	});

	it("merges council backends per-persona", () => {
		const withCouncil: BpxCouncilConfig = {
			...BASE,
			council: { backends: { architect: "codex", critic: "codex", simplifier: "codex" } },
		};
		const merged = mergeConfigs(withCouncil, { council: { backends: { critic: "anthropic:claude-opus-4-8" } } });
		expect(merged.council?.backends).toEqual({
			architect: "codex",
			critic: "anthropic:claude-opus-4-8", // overridden
			simplifier: "codex",
		});
	});
});

describe("projectConfigPath / resolveConfig discovery", () => {
	let dir: string;
	let prevHome: string | undefined;
	let home: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bpx-proj-"));
		home = mkdtempSync(join(tmpdir(), "bpx-home-"));
		prevHome = process.env.HOME;
		process.env.HOME = home; // so configPath() (global) points into the sandbox
	});
	afterEach(() => {
		if (prevHome === undefined) delete process.env.HOME;
		else process.env.HOME = prevHome;
		rmSync(dir, { recursive: true, force: true });
		rmSync(home, { recursive: true, force: true });
	});

	it("finds a project config walking up to the git root, and stops there", () => {
		mkdirSync(join(dir, ".git"));
		mkdirSync(join(dir, "src", "deep"), { recursive: true });
		writeFileSync(join(dir, ".bpx-council.json"), "{}");
		// found from a nested subdir
		expect(projectConfigPath(join(dir, "src", "deep"))).toBe(join(dir, ".bpx-council.json"));
		// write path resolves to the git root too
		expect(projectConfigWritePath(join(dir, "src", "deep"))).toBe(join(dir, ".bpx-council.json"));
	});

	it("returns undefined when there's no project config in the repo", () => {
		mkdirSync(join(dir, ".git"));
		expect(projectConfigPath(dir)).toBeUndefined();
	});

	it("layers a project config over the global one", () => {
		// global: council mode
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ defaultMode: "council" }));
		// project: pins an http advisor, inherits the council mode
		mkdirSync(join(dir, ".git"));
		writeFileSync(
			join(dir, ".bpx-council.json"),
			JSON.stringify({ solo: { model: "auto", backend: { type: "http", provider: "anthropic", model: "claude-opus-4-8" } } }),
		);

		const cfg = resolveConfig(undefined, dir);
		expect(cfg.defaultMode).toBe("council"); // from global
		expect(cfg.solo.backend).toEqual({ type: "http", provider: "anthropic", model: "claude-opus-4-8" }); // from project
	});

	it("an explicit --config path replaces discovery", () => {
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ defaultMode: "council" }));
		const explicit = join(dir, "custom.json");
		writeFileSync(explicit, JSON.stringify({ defaultMode: "debate" }));
		const cfg = resolveConfig(explicit, dir);
		expect(cfg.defaultMode).toBe("debate"); // explicit file, not global
	});
});

describe("retired config keys", () => {
	it("no longer ships solo.model or contextWindow as defaults", () => {
		// Both were written into every config and read by nothing. Old files still
		// parse (the keys stay optional on the type); new ones just don't get them.
		expect(DEFAULT_CONFIG.solo.model).toBeUndefined();
		expect(DEFAULT_CONFIG.contextWindow).toBeUndefined();
	});

	it("still preserves them when a user's existing file has them", () => {
		const merged = mergeConfigs({ defaultMode: "solo", solo: {}, contextWindow: 300_000 }, { defaultMode: "council", solo: {} });
		expect(merged.contextWindow).toBe(300_000);
	});
});
