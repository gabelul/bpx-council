/**
 * onboard tests.
 *
 * The interactive prompt itself is thin glue over runInstall (already heavily
 * tested), so what's worth pinning down is the decision that gates it —
 * specifically anySkillInstalled, since it's registry-derived and an inversion
 * there would either nag people who are set up or skip the offer for people who
 * aren't.
 */

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { anySkillInstalled } from "../src/onboard.js";

describe("anySkillInstalled", () => {
	let dir: string;

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "bpx-onboard-"));
	});
	afterEach(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("is false in a fresh project with nothing installed", () => {
		expect(anySkillInstalled(dir)).toBe(false);
	});

	it("is true once a project-scope skill dir exists", () => {
		// The shape the installer writes: .claude/skills/bpx-council.
		mkdirSync(join(dir, ".claude", "skills", "bpx-council"), { recursive: true });
		expect(anySkillInstalled(dir)).toBe(true);
	});

	it("is true for the shared .agents/skills location too", () => {
		mkdirSync(join(dir, ".agents", "skills", "bpx-council"), { recursive: true });
		expect(anySkillInstalled(dir)).toBe(true);
	});

	it("ignores an unrelated .claude dir with no bpx-council skill", () => {
		mkdirSync(join(dir, ".claude", "skills", "something-else"), { recursive: true });
		expect(anySkillInstalled(dir)).toBe(false);
	});
});
