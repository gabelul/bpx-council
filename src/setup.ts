/**
 * setup — the one-command onboarding. Configure the advisor, then offer to wire
 * bpx-council into your coding agents.
 *
 * It's a thin orchestrator, not a third implementation: it runs `config` and
 * then `install`, both of which stay independently runnable. This is the
 * pi-style single entry point without coupling the two flows together.
 */

import { createInterface } from "node:readline/promises";
import { runConfig, type ConfigOptions } from "./config-wizard.js";
import { runInstall } from "./install.js";
import { bold, cyan, dim } from "./style.js";

/**
 * Run config, then (interactively) offer to run the agent installer.
 *
 * The agent-install offer is interactive only — a headless `setup --yes` writes
 * the config but won't silently write into ~/.claude etc. Run `install --yes`
 * for that, deliberately.
 *
 * @returns Process exit code.
 */
export async function runSetup(opts: ConfigOptions): Promise<number> {
	console.log(`\n${bold(cyan("bpx-council setup"))} ${dim("· configure, then wire into your agents")}`);

	const configCode = await runConfig(opts);
	if (configCode !== 0) return configCode;

	// Offer the agent installer, only when we can actually prompt.
	if (process.stdin.isTTY === true && !opts.yes) {
		const rl = createInterface({ input: process.stdin, output: process.stdout });
		let wire = false;
		try {
			const answer = (await rl.question("\nAlso wire bpx-council into your coding agents now? [Y/n] ")).trim().toLowerCase();
			wire = answer === "" || answer === "y" || answer === "yes";
		} finally {
			rl.close();
		}
		if (wire) return runInstall({});
		console.log(dim("Skipped — run `bpx-council install` whenever you like."));
	}

	return 0;
}
