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

import { emitKeypressEvents, type Key } from "node:readline";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

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
	const clip = (s: string) => (s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s);
	const lines = [clip(header)];
	state.items.forEach((label, i) => {
		const pointer = i === state.cursor ? "❯" : " ";
		const box = state.selected.has(i) ? "◉" : "◯";
		lines.push(clip(`  ${pointer} ${box} ${label}`));
	});
	lines.push("");
	lines.push(clip("  ↑↓ move · space toggle · a all · enter confirm · esc cancel"));
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
	return new Promise((resolve) => {
		const input = process.stdin;
		const out = process.stderr;
		const state = initState(items, initial);

		emitKeypressEvents(input);
		let raw = false;
		try {
			input.setRawMode(true);
			raw = true;
		} catch {
			// No raw mode available — the caller shouldn't have reached here, but
			// don't wedge: just resolve with the pre-checked defaults.
			resolve(chosen(state));
			return;
		}
		input.resume();
		out.write(HIDE_CURSOR);

		let lastLines = 0;
		const draw = () => {
			if (lastLines > 0) out.write(`\x1b[${lastLines}A`); // up to the block's first line
			out.write("\x1b[0J"); // clear from cursor to end of screen
			const text = render(state, header, out.columns || 80);
			out.write(text);
			lastLines = (text.match(/\n/g) ?? []).length;
		};

		const cleanup = () => {
			input.removeListener("keypress", onKey);
			if (raw) {
				try {
					input.setRawMode(false);
				} catch {
					// Best-effort — nothing more we can do.
				}
			}
			input.pause();
			out.write(`${SHOW_CURSOR}\n`);
		};

		const onKey = (str: string | undefined, key: Key | undefined) => {
			if (!key) return;
			if (key.ctrl && key.name === "c") {
				cleanup();
				process.exit(130);
			}
			if (key.name === "escape" || key.name === "q") {
				cleanup();
				resolve(null);
				return;
			}
			if (key.name === "return" || key.name === "enter") {
				cleanup();
				resolve(chosen(state));
				return;
			}
			if (key.name === "up" || key.name === "k") move(state, -1);
			else if (key.name === "down" || key.name === "j") move(state, 1);
			else if (str === " " || key.name === "space") toggleCurrent(state);
			else if (key.name === "a") toggleAll(state);
			else return; // ignore keys we don't handle, no redraw
			draw();
		};

		input.on("keypress", onKey);
		draw();
	});
}
