/**
 * interactive — the shared raw-mode keyboard driver behind every picker.
 *
 * It owns the fiddly, dangerous parts once: raw-mode setup and teardown, the
 * redraw math (move up N lines, clear, rewrite), cursor hide/show, and ctrl-c.
 * A picker just says what to render and how a key mutates its state; this makes
 * sure the terminal is always restored, on every exit path.
 *
 * Only works on a real TTY. When raw mode isn't available it resolves null so
 * the caller can fall back rather than wedge.
 */

import { emitKeypressEvents, type Key } from "node:readline";

const HIDE_CURSOR = "\x1b[?25l";
const SHOW_CURSOR = "\x1b[?25h";

/** Handed to a key handler so it can redraw or finish. */
export interface KeyCtx<T> {
	/** Repaint the block from the current render(). */
	redraw(): void;
	/** Restore the terminal and resolve with this value (null = cancelled). */
	done(value: T | null): void;
}

export interface RunOpts {
	/**
	 * Erase the block once the picker finishes, instead of leaving it on screen.
	 *
	 * The rail-style wizard replaces each answered prompt with a one-line summary,
	 * so the full option list has to go — otherwise you'd end up with every list
	 * you've ever scrolled still sitting in the scrollback.
	 */
	clearOnDone?: boolean;
}

/**
 * Run a raw-mode key loop over a redrawn text block.
 *
 * @param render - Returns the full block to draw (newline-terminated).
 * @param handle - Called per keypress; mutates picker state and calls ctx.
 * @param opts - See {@link RunOpts}.
 * @returns The value passed to ctx.done, or null on cancel / no raw mode.
 */
export function runKeyLoop<T>(
	render: () => string,
	handle: (str: string | undefined, key: Key | undefined, ctx: KeyCtx<T>) => void,
	opts?: RunOpts,
): Promise<T | null> {
	return new Promise((resolve) => {
		const input = process.stdin;
		const out = process.stderr;

		emitKeypressEvents(input);
		let raw = false;
		try {
			input.setRawMode(true);
			raw = true;
		} catch {
			resolve(null);
			return;
		}
		input.resume();
		out.write(HIDE_CURSOR);

		let lastLines = 0;
		const redraw = () => {
			if (lastLines > 0) out.write(`\x1b[${lastLines}A`); // up to the block's first line
			out.write("\x1b[0J"); // clear from cursor to end of screen
			const text = render();
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
			if (opts?.clearOnDone && lastLines > 0) {
				// Rewind over the block and wipe it, leaving the cursor where the
				// block started so the caller's summary line takes its place.
				out.write(`\x1b[${lastLines}A\x1b[0J${SHOW_CURSOR}`);
				return;
			}
			out.write(`${SHOW_CURSOR}\n`);
		};

		const ctx: KeyCtx<T> = {
			redraw,
			done(value) {
				cleanup();
				resolve(value);
			},
		};

		const onKey = (str: string | undefined, key: Key | undefined) => {
			if (key?.ctrl && key.name === "c") {
				cleanup();
				process.exit(130);
			}
			handle(str, key, ctx);
		};

		input.on("keypress", onKey);
		redraw();
	});
}

/** Clip a plain string to a column budget, appending an ellipsis. */
export function clip(s: string, width: number): string {
	return s.length > width ? `${s.slice(0, Math.max(0, width - 1))}…` : s;
}
