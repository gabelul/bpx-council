#!/usr/bin/env node
/**
 * postinstall — a one-line "next step" hint after a global install.
 *
 * It ONLY prints. It never runs the wizard and never writes config, because
 * doing either from an npm lifecycle script is a trap: installs run
 * non-interactively in CI/Docker/`npm ci`, run again when bpx-council is a
 * dependency of something else, and are skipped entirely under
 * --ignore-scripts. The wizard is something you choose to run — this just makes
 * sure you know it's there.
 *
 * Gated to global installs only (never fires for a dependency install or in a
 * project's `npm ci`). It does NOT check `process.stdout.isTTY`: npm pipes
 * lifecycle-script stdio, so isTTY is never true here — that guard silently
 * suppressed the hint everywhere, which is the whole reason it didn't show.
 *
 * Honest caveat: default npm (v7+) buffers and hides postinstall output unless
 * you pass `--foreground-scripts`, so this reliably surfaces only on package
 * managers that show it (yarn classic, pnpm in some modes, `npm
 * --foreground-scripts`). The dependable nudge is the first-run prompt inside
 * the CLI itself — see src/onboard.ts. This is a best-effort bonus on top.
 *
 * Never throws: a hint must not fail an install.
 */

try {
	if (process.env.npm_config_global === "true") {
		process.stdout.write(
			"\n  bpx-council installed.\n" +
				"  Wire it into your coding agents (Claude Code, Codex, Cursor, …):\n\n" +
				"    bpx-council install\n\n",
		);
	}
} catch {
	// A hint must never fail an install.
}
