/**
 * nudge — the quiet "a star helps" line.
 *
 * Lives on its own because both the installer and the config wizard end with it,
 * and two copies would drift the moment one gets reworded. One star, warm, not
 * naggy; the whole tool is free.
 */

import { cyan, dim, yellow } from "./style.js";

const REPO = "gabelul/bpx-council";

/**
 * Print the star line after a successful interactive run.
 *
 * Terminal only — a scripted install or a piped `config --yes` shouldn't get
 * marketing in its logs.
 *
 * @param reason - The half-sentence after "If…", so each command can nudge in
 *   its own words instead of sharing one generic line.
 */
export function printStarNudge(reason = "the council saved you a bad call"): void {
	if (!process.stdout.isTTY) return;
	console.log();
	console.log(`  ${yellow("★")} ${dim(`If ${reason}, a star helps others find it:`)}`);
	console.log(`    ${cyan(`https://github.com/${REPO}`)}`);
	console.log(`    ${dim(`gh repo star ${REPO}`)}`);
}
