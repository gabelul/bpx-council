/**
 * multiselect — a zero-dependency checkbox picker for the install wizard.
 *
 * "Type 1,3,4" works but it's clumsy; this is the arrow-keys-and-space
 * experience people expect — the same shape vercel-labs/skills uses. Built on
 * node:readline's keypress events plus raw mode, so it stays dependency-free.
 *
 * Two things it's careful about:
 *   - The terminal is ALWAYS restored — cooked mode back on, cursor shown,
 *     listener removed — on every exit path (confirm, cancel, ctrl-c). A
 *     raw-mode prompt that dies without cleanup leaves the user's shell wedged.
 *   - Each line is truncated to the terminal width, so a long label (the shared
 *     .agents/skills entry is a mouthful) can't wrap and desync the redraw math,
 *     which counts newlines to know how far up to move.
 *
 * Only usable on a real TTY. The caller falls back to comma-separated entry
 * when stdin isn't one.
 */

import { runKeyLoop } from "./interactive.js";
import { bold, cyan, dim, green } from "./style.js";

export interface MultiselectState {
	items: string[];
	selected: Set<number>;
	cursor: number;
}

/** Fresh state with `initial` indices pre-checked and the cursor at the top. */
export function initState(items: string[], initial: number[]): MultiselectState {
	return { items, selected: new Set(initial.filter((i) => i >= 0 && i < items.length)), cursor: 0 };
}

/** Move the cursor by `delta`, wrapping top-to-bottom. */
export function move(state: MultiselectState, delta: number): void {
	const n = state.items.length;
	if (n === 0) return;
	state.cursor = (state.cursor + delta + n) % n;
}

/** Toggle the item under the cursor. */
export function toggleCurrent(state: MultiselectState): void {
	if (state.selected.has(state.cursor)) state.selected.delete(state.cursor);
	else state.selected.add(state.cursor);
}

/** Select all if any are unselected; otherwise clear. */
export function toggleAll(state: MultiselectState): void {
	if (state.selected.size === state.items.length) state.selected.clear();
	else state.items.forEach((_, i) => state.selected.add(i));
}

/** Selected indices, ascending. */
export function chosen(state: MultiselectState): number[] {
	return [...state.selected].sort((a, b) => a - b);
}

/**
 * Render the picker to a string.
 *
 * @param width - Column budget; each line is clipped to it so nothing wraps.
 */
export function render(state: MultiselectState, header: string, width = 80): string {
	const clip = (s: string, w: number) => (s.length > w ? `${s.slice(0, Math.max(0, w - 1))}…` : s);
	// Clip the plain label BEFORE colouring — ANSI codes would throw off a
	// length-based clip. The fixed prefix "  ❯ ◉ " is 6 visible columns.
	const labelWidth = Math.max(4, width - 6);

	const lines = [dim(clip(header, width))];
	state.items.forEach((label, i) => {
		const atCursor = i === state.cursor;
		const pointer = atCursor ? cyan("❯") : " ";
		const box = state.selected.has(i) ? green("◉") : "◯";
		const text = clip(label, labelWidth);
		lines.push(`  ${pointer} ${box} ${atCursor ? bold(text) : text}`);
	});
	lines.push("");
	lines.push(dim(clip("  ↑↓ move · space toggle · a all · enter confirm · esc cancel", width)));
	return `${lines.join("\n")}\n`;
}

/**
 * Run the interactive picker. Resolves with the selected indices, or null if
 * the user cancels with escape. Ctrl-C exits the process (130), the shell's
 * usual expectation.
 *
 * @returns Selected indices (ascending) or null on cancel.
 */
export function runMultiselect(header: string, items: string[], initial: number[]): Promise<number[] | null> {
	const state = initState(items, initial);
	return runKeyLoop<number[]>(
		() => render(state, header, process.stderr.columns || 80),
		(str, key, ctx) => {
			if (!key) return;
			if (key.name === "escape" || key.name === "q") return ctx.done(null);
			if (key.name === "return" || key.name === "enter") return ctx.done(chosen(state));
			if (key.name === "up" || key.name === "k") move(state, -1);
			else if (key.name === "down" || key.name === "j") move(state, 1);
			else if (str === " " || key.name === "space") toggleCurrent(state);
			else if (key.name === "a") toggleAll(state);
			else return; // ignore keys we don't handle, no redraw
			ctx.redraw();
		},
	);
}
