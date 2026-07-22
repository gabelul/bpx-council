/**
 * style — minimal ANSI colour, zero dependency.
 *
 * On only when stdout is a real terminal and NO_COLOR isn't set, so piped or
 * redirected output stays plain and CI/agent captures don't fill with escape
 * codes. Everyone's ANSI, nobody's dependency.
 *
 * Each helper closes with the specific reset (fg → default, bold/dim → normal)
 * rather than a blanket `\x1b[0m`, so the rare nested style doesn't get wiped.
 */

const on = process.stdout.isTTY === true && !process.env.NO_COLOR;

const wrap =
	(open: number, close: number) =>
	(s: string): string =>
		on ? `\x1b[${open}m${s}\x1b[${close}m` : s;

export const bold = wrap(1, 22);
export const dim = wrap(2, 22);
export const red = wrap(31, 39);
export const green = wrap(32, 39);
export const yellow = wrap(33, 39);
export const cyan = wrap(36, 39);
export const magenta = wrap(35, 39);

/** Whether colour is actually being emitted — for callers that adjust layout. */
export const colorOn = on;
