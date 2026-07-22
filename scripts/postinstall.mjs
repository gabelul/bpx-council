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
 * Guarded to a real terminal on a global install, so it stays silent
 * everywhere it would be noise. Never throws: a hint must not fail an install.
 */

try {
	const isGlobal = process.env.npm_config_global === "true";
	if (isGlobal && process.stdout.isTTY) {
		process.stdout.write(
			"\n  bpx-council installed.\n" +
				"  Wire it into your coding agents (Claude Code, Codex, Cursor, …):\n\n" +
				"    bpx-council install\n\n",
		);
	}
} catch {
	// A hint must never fail an install.
}
