/**
 * theme — what each colour *means*, in one place.
 *
 * `style.ts` gives raw colours; this decides where they go. Keeping the mapping
 * here is what stops the wizard reading as one grey block: a backend name, the
 * kind of backend it is, the model it runs, and the hint explaining it are four
 * different kinds of information, so they get four different weights.
 *
 * The palette, and what each colour is reserved for:
 *   cyan     a value you chose, and CLI backends
 *   magenta  the live prompt, and HTTP backends
 *   green    done / saved
 *   yellow   a filter match, and the star
 *   dim      labels, hints, structure
 *   bold     the thing you're being asked right now
 */

import { bold, cyan, dim, green, magenta, yellow } from "./style.js";

/** A chosen value — the answer to a question. */
export const value = cyan;
/** A field label in a summary. */
export const label = dim;
/** Explanatory text hanging off an option. */
export const hint = dim;
/** The question being asked right now. */
export const question = bold;
/** Something finished successfully. */
export const done = green;

/** Colour a backend kind badge: CLI and HTTP shouldn't look alike. */
export function kindBadge(kind: "cli" | "http"): string {
	return kind === "cli" ? cyan(kind) : magenta(kind);
}

/**
 * A tone per mode, so a mode reads as itself at a glance rather than as another
 * word in a list. Council and debate are the multi-model ones and get the warmer
 * colours; solo and gut-check are the quick single calls.
 */
export function modeTone(mode: string): (s: string) => string {
	switch (mode) {
		case "council":
			return magenta;
		case "debate":
			return yellow;
		case "gut-check":
			return green;
		default:
			return cyan; // solo
	}
}

/** One-line explanation per mode — more use than colour alone in the picker. */
export const MODE_HINTS: Record<string, string> = {
	solo: "one strong second opinion · seconds",
	council: "three personas in parallel, then a verdict",
	debate: "advocate vs critic over rounds, then a verdict",
	"gut-check": "terse — does this smell off?",
};

/**
 * Highlight the matched slice of a filter result.
 *
 * Typing `sol` into 120 models and getting back a list with no indication of
 * *why* each line matched is the thing that makes long lists feel like a wall.
 * Case-insensitive, first occurrence only.
 *
 * Call this AFTER clipping: it injects escape sequences, and `clip` counts raw
 * characters, so clipping afterwards would measure the escapes and cut one in half.
 */
export function highlightMatch(text: string, query: string): string {
	if (!query) return text;
	const at = text.toLowerCase().indexOf(query.toLowerCase());
	if (at === -1) return text;
	return `${text.slice(0, at)}${yellow(text.slice(at, at + query.length))}${text.slice(at + query.length)}`;
}

/**
 * Dim the `provider/` prefix on a qualified model id.
 *
 * opencode and crush both list as `provider/model`, and with 120 of them the
 * provider repeats endlessly — dimming it lets the eye land on the model.
 * Skipped when a filter is active, since highlighting owns the styling then.
 */
export function dimProvider(text: string): string {
	const slash = text.indexOf("/");
	return slash === -1 ? text : `${dim(text.slice(0, slash + 1))}${text.slice(slash + 1)}`;
}
