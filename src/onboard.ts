/**
 * onboard — a one-time "want to set this up?" offer on first real use.
 *
 * The postinstall hint tells you `bpx-council install` exists; this is the
 * gentler follow-through for people who didn't run it. On the first genuine
 * `bpx-council` run — real terminal, nothing wired up yet — it offers to launch
 * the wizard, and never asks again either way.
 *
 * Why here and not in postinstall: this path owns a proper TTY. postinstall
 * runs with npm's constrained, often non-interactive stdio, where a prompt
 * hangs CI and behaves differently across npm/yarn/pnpm. A prompt belongs where
 * the process actually controls the terminal — which is here.
 *
 * It offers only when all of these hold, and stays silent otherwise:
 *   - stdin, stdout, and stderr are all TTYs (a truly interactive session, not
 *     a pipe, redirect, cron job, or agent hook);
 *   - not in CI;
 *   - nothing of ours is installed yet (don't nag someone who's set up);
 *   - we haven't already asked once.
 */

import { existsSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { AGENTS } from "./agents.js";
import { runInstall } from "./install.js";

/** Written once we've offered, so the question fires at most a single time. */
function markerPath(): string {
	return join(homedir(), ".bpx-council-onboarded");
}

function alreadyAsked(): boolean {
	try {
		return existsSync(markerPath());
	} catch {
		return false;
	}
}

function markAsked(): void {
	try {
		writeFileSync(markerPath(), String(Date.now()));
	} catch {
		// If we can't record it we might ask twice — a minor annoyance, not a bug.
	}
}

/**
 * Is any bpx-council skill directory already on disk?
 *
 * Derived from the agent registry rather than a hardcoded list, so it can't
 * drift from where the installer actually writes. Checks every skill copy
 * destination across both scopes for the current cwd.
 */
export function anySkillInstalled(cwd: string): boolean {
	for (const agent of AGENTS) {
		for (const scope of agent.scopes) {
			for (const action of agent.actions(scope, cwd)) {
				if (action.kind === "copy-dir" && existsSync(action.dest)) return true;
			}
		}
	}
	return false;
}

/** A truly interactive terminal — every stream a TTY, and not CI. */
function isInteractiveTerminal(): boolean {
	return (
		process.stdin.isTTY === true &&
		process.stdout.isTTY === true &&
		process.stderr.isTTY === true &&
		!process.env.CI
	);
}

/**
 * Offer to run the wizard, once, on a fresh interactive install.
 *
 * @param cwd - Project root, for scope-aware install-state detection.
 * @returns Whether it prompted this run — the caller skips the update notice
 *          when it did, so two interruptions never stack.
 */
export async function maybeOnboard(cwd: string): Promise<boolean> {
	try {
		if (!isInteractiveTerminal()) return false;
		if (alreadyAsked()) return false;
		if (anySkillInstalled(cwd)) {
			// Already set up — record it so we never consider asking again.
			markAsked();
			return false;
		}

		// First interactive run with nothing installed. Ask exactly once.
		markAsked();

		// Prompt on stderr so the council's answer (already on stdout) stays clean.
		const rl = createInterface({ input: process.stdin, output: process.stderr });
		let yes = false;
		try {
			const answer = (await rl.question("\nWire bpx-council into your coding agents now? [Y/n] ")).trim().toLowerCase();
			yes = answer === "" || answer === "y" || answer === "yes";
		} finally {
			rl.close();
		}

		if (yes) {
			await runInstall({ cwd });
		} else {
			process.stderr.write("No problem — run `bpx-council install` whenever you like.\n");
		}
		return true;
	} catch {
		// Onboarding is a nicety; never let it disrupt the actual command.
		return false;
	}
}
