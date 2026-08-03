/**
 * rail — the connected left-hand rail the config wizard draws down.
 *
 * The look is the one `create-astro` and friends made familiar: a vertical bar
 * threading every step together, answered prompts collapsed to a single line,
 * the live prompt opened with a diamond. It reads as one continuous flow rather
 * than a stack of unrelated questions.
 *
 * Deliberately hand-rolled rather than pulled from a prompts library: the hard
 * part (raw mode, redraw math, restoring the terminal) already lives in
 * `interactive.ts`, and all that's left is which glyph goes where. That's a
 * styling decision, not a reason to take on a dependency — this package ships
 * with none and that's a feature.
 */

import { cyan, dim, green, magenta, yellow } from "./style.js";

/** The rail glyphs. */
export const BAR = "│";
const STEP_ACTIVE = "◆";
const STEP_DONE = "◇";
const RAIL_END = "└";

/** Strip ANSI so we can tell a blank line from one that's only escape codes. */
function visible(line: string): string {
	// biome-ignore lint/suspicious/noControlCharactersInRegex: matching ESC is the job.
	return line.replace(/\x1b\[[0-9;]*m/g, "").trim();
}

/**
 * Wrap a picker's rendered block in the rail.
 *
 * The block's first line is its question and its last is the key hints, which
 * map onto the rail's opening diamond and closing corner; everything between
 * gets the bar. Line *count* is untouched — `runKeyLoop` measures the redraw by
 * counting newlines, so adding or dropping one here would desync every repaint.
 */
export function railed(block: string): string {
	const trailing = block.endsWith("\n");
	const body = trailing ? block.slice(0, -1) : block;
	const lines = body.split("\n");
	const last = lines.length - 1;

	// Only the question line needs padding added: every other line the pickers
	// emit already carries its own two-space indent, so the glyph butts straight
	// up against it. Adding another gap here is what made everything look
	// double-indented under the rail.
	const out = lines.map((line, i) => {
		if (i === 0) return `${magenta(STEP_ACTIVE)}  ${line}`;
		if (i === last) return `${dim(RAIL_END)}${line}`;
		return visible(line) ? `${dim(BAR)}${line}` : dim(BAR);
	});
	return trailing ? `${out.join("\n")}\n` : out.join("\n");
}

/** Open the wizard: a filled diamond, the title, then the rail. */
export function railIntro(title: string, subtitle: string): void {
	console.log();
	console.log(`${green(STEP_ACTIVE)}  ${title} ${dim(`· ${subtitle}`)}`);
	console.log(dim(BAR));
}

/**
 * An answered step, collapsed to its question and the answer.
 *
 * This is what replaces the erased picker block, so the history stays one line
 * per question however long the list you picked from was.
 */
export function railStep(question: string, answer: string, note?: string): void {
	console.log(`${green(STEP_DONE)}  ${dim(question)}`);
	console.log(`${dim(BAR)}  ${cyan(answer)}${note ? ` ${dim(note)}` : ""}`);
	console.log(dim(BAR));
}

/** A plain line hanging off the rail — used for notes between steps. */
export function railNote(text: string): void {
	console.log(`${dim(BAR)}  ${dim(text)}`);
}

/** Close the rail with a final message. */
export function railOutro(lines: string[]): void {
	lines.forEach((line, i) => {
		const glyph = i === lines.length - 1 ? green(RAIL_END) : dim(BAR);
		console.log(`${glyph}  ${line}`);
	});
}

/** The star nudge's leading glyph, kept here so the rail owns its palette. */
export const STAR = yellow("★");
