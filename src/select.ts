/**
 * select — single-choice pickers, the counterparts to the checkbox multiselect.
 *
 * `runSelect` is a short arrow-key list (scope, backend, mode). `runFilterSelect`
 * is a type-to-filter list for when there are too many options to arrow through
 * — the 120-model opencode catalog is the reason it exists. Both ride the shared
 * raw-mode driver, so the terminal handling lives in one place.
 */

import { clip, runKeyLoop, type RunOpts } from "./interactive.js";
import { railed } from "./rail.js";
import { bold, cyan, dim } from "./style.js";
import { dimProvider, highlightMatch, hint, kindBadge } from "./theme.js";

export interface SelectOption {
	label: string;
	value: string;
	/** Dimmed explanation shown after the label (e.g. "Codex CLI · on PATH"). */
	hint?: string;
	/** Backend kind, rendered as a coloured badge so cli and http differ at a glance. */
	kind?: "cli" | "http";
	/** Optional colour for the label itself — used to give each mode its own tone. */
	tone?: (s: string) => string;
}

/**
 * Presentation options shared by every picker.
 *
 * `rail` wraps the block in the wizard's left-hand rail and erases it when the
 * picker finishes, so the caller can replace it with a one-line summary. Off by
 * default — the installer's wizard uses the plain stacked look.
 */
export interface PickerStyle {
	rail?: boolean;
}

/** Translate picker style into the render wrapper and key-loop options. */
function styled(style?: PickerStyle): { wrap: (block: string) => string; run: RunOpts } {
	return style?.rail ? { wrap: railed, run: { clearOnDone: true } } : { wrap: (b) => b, run: {} };
}

/**
 * Render a header that may span several lines.
 *
 * The wizard puts persistent chrome above each question (progress, where it's
 * saving, what you've picked so far), so a header isn't always one line. Each
 * line is clipped on its own — clipping the whole thing would count the newlines
 * as columns and truncate in the wrong place, which desyncs the redraw.
 *
 * An already-styled line (one carrying an ESC sequence) is passed through
 * untouched: `clip` counts raw characters, so measuring a string full of escape
 * codes would both mis-measure its width and risk cutting an escape in half.
 * Styling a line means you've taken responsibility for its width.
 */
function headerLines(header: string, width: number): string[] {
	return header.split("\n").map((line) => (line.includes("[") ? line : dim(clip(line, width))));
}

/** Render the single-select list, cursor row highlighted. */
export function renderSelect(options: SelectOption[], cursor: number, header: string, width = 80): string {
	const labelWidth = Math.max(4, width - 4); // prefix "  ❯ " is 4 columns
	const lines = headerLines(header, width);
	options.forEach((option, i) => {
		const atCursor = i === cursor;
		const pointer = atCursor ? cyan("❯") : " ";

		// Each piece is measured on its plain text and coloured afterwards —
		// clip() counts raw characters, so styling first would corrupt the widths.
		const name = clip(option.label, Math.min(labelWidth, 22));
		const badge = option.kind ?? "";
		const spent = name.length + (badge ? badge.length + 2 : 0) + 4;
		const room = Math.max(0, width - spent - 2);
		const hintText = option.hint && room > 8 ? clip(option.hint, room) : "";

		const toned = option.tone ? option.tone(name) : name;
		const shown = atCursor ? bold(toned) : toned;
		const badgePart = badge ? ` ${kindBadge(option.kind as "cli" | "http")}` : "";
		const hintPart = hintText ? ` ${hint(hintText)}` : "";
		lines.push(`  ${pointer} ${shown}${badgePart}${hintPart}`);
	});
	lines.push("");
	lines.push(dim(clip("  ↑↓ move · enter select · esc cancel", width)));
	return `${lines.join("\n")}\n`;
}

/**
 * Pick one option with the arrow keys. Resolves the chosen `value`, or null on
 * escape / no raw mode.
 */
export function runSelect(header: string, options: SelectOption[], initial = 0, style?: PickerStyle): Promise<string | null> {
	const n = options.length;
	let cursor = Math.min(Math.max(0, initial), Math.max(0, n - 1));
	const { wrap, run } = styled(style);
	return runKeyLoop<string>(
		() => wrap(renderSelect(options, cursor, header, process.stderr.columns || 80)),
		(_str, key, ctx) => {
			if (!key) return;
			if (key.name === "escape" || key.name === "q") return ctx.done(null);
			if (key.name === "return" || key.name === "enter") return ctx.done(options[cursor]?.value ?? null);
			if (key.name === "up" || key.name === "k") cursor = (cursor - 1 + n) % n;
			else if (key.name === "down" || key.name === "j") cursor = (cursor + 1) % n;
			else return;
			ctx.redraw();
		},
		run,
	);
}

/** Render a single-line text input with a cursor and a default hint. */
export function renderInput(header: string, value: string, def: string, width = 80): string {
	const hint = !value && def ? `  ${dim(`(default: ${def})`)}` : "";
	const lines = headerLines(header, width);
	lines.push(`  ${cyan("›")} ${clip(value, Math.max(4, width - 6))}${dim("▏")}${hint}`);
	lines.push("");
	lines.push(dim(clip("  type · enter accept · esc default", width)));
	return `${lines.join("\n")}\n`;
}

/**
 * A single-line text field. Enter (or an empty enter) accepts the typed value or
 * the default; escape takes the default. Always resolves a string.
 */
export function runInput(header: string, def = "", style?: PickerStyle): Promise<string> {
	let value = "";
	const { wrap, run } = styled(style);
	return runKeyLoop<string>(
		() => wrap(renderInput(header, value, def, process.stderr.columns || 80)),
		(str, key, ctx) => {
			if (!key) return;
			if (key.name === "escape") return ctx.done(def);
			if (key.name === "return" || key.name === "enter") return ctx.done(value.trim() || def);
			if (key.name === "backspace") value = value.slice(0, -1);
			else if (str && str.length === 1 && str.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) value += str;
			else return;
			ctx.redraw();
		},
		run,
	).then((v) => v ?? def);
}

/**
 * Render a confirm's header, putting the [Y/n] marker on the question itself.
 *
 * Confirms take the same multi-line chrome as the other pickers — the wizard
 * passes its progress header here too, and clipping that as a single line
 * mangled it into `✓[…`.
 */
function confirmHeader(header: string, defaultYes: boolean): string {
	const lines = headerLines(header, process.stderr.columns || 80);
	const marker = dim(defaultYes ? "[Y/n]" : "[y/N]");
	lines[lines.length - 1] = `${lines[lines.length - 1]} ${marker}`;
	return lines.join("\n");
}

/** A y/n confirm. Enter or escape takes the default; y/n set it. Always a boolean. */
export function runConfirm(header: string, defaultYes: boolean, style?: PickerStyle): Promise<boolean> {
	const { wrap, run } = styled(style);
	return runKeyLoop<boolean>(
		() => wrap(`${confirmHeader(header, defaultYes)}\n`),
		(str, key, ctx) => {
			if (!key) return;
			if (key.name === "return" || key.name === "enter" || key.name === "escape") return ctx.done(defaultYes);
			if (str === "y" || str === "Y") return ctx.done(true);
			if (str === "n" || str === "N") return ctx.done(false);
		},
		run,
	).then((v) => v ?? defaultYes);
}

/** Case-insensitive substring filter, preserving order. */
export function filterItems(items: string[], query: string): string[] {
	if (!query) return items;
	const q = query.toLowerCase();
	return items.filter((item) => item.toLowerCase().includes(q));
}

/** Render the filter box + a window of matches around the cursor. */
export function renderFilter(
	header: string,
	query: string,
	matches: string[],
	cursor: number,
	maxRows: number,
	width = 80,
): string {
	const lines = headerLines(header, width);
	lines.push(`  ${cyan("›")} ${clip(query, Math.max(4, width - 4))}${dim("▏")}`);

	if (matches.length === 0) {
		lines.push(dim("    (no match — enter uses what you typed)"));
	} else {
		// Window the list so the cursor stays visible without scrolling the whole thing.
		const start = Math.max(0, Math.min(cursor - Math.floor(maxRows / 2), matches.length - maxRows));
		const from = Math.max(0, start);
		matches.slice(from, from + maxRows).forEach((match, wi) => {
			const idx = from + wi;
			const atCursor = idx === cursor;
			const pointer = atCursor ? cyan("❯") : " ";
			// Clip on the plain string first, then colour: highlighting injects
			// escapes that clip() would otherwise measure and slice through.
			const plain = clip(match, Math.max(4, width - 4));
			const text = query ? highlightMatch(plain, query) : dimProvider(plain);
			lines.push(`  ${pointer} ${atCursor ? bold(text) : text}`);
		});
		if (matches.length > maxRows) lines.push(dim(`    … ${matches.length} matches`));
	}

	lines.push("");
	lines.push(dim(clip("  type to filter · ↑↓ move · enter select · esc skip (use default)", width)));
	return `${lines.join("\n")}\n`;
}

/**
 * Pick one item from a long list with type-to-filter.
 *
 * Resolves the highlighted match on enter; with `allowCustom`, enter on a query
 * that matches nothing returns the query itself (so you can name a model that
 * isn't in the list). Escape resolves null — "skip, use the default".
 */
export function runFilterSelect(header: string, items: string[], opts?: { allowCustom?: boolean } & PickerStyle): Promise<string | null> {
	let query = "";
	let cursor = 0;
	const maxRows = 8;
	const { wrap, run } = styled(opts);
	return runKeyLoop<string>(
		() => wrap(renderFilter(header, query, filterItems(items, query), cursor, maxRows, process.stderr.columns || 80)),
		(str, key, ctx) => {
			if (!key) return;
			const matches = filterItems(items, query);
			if (key.name === "escape") return ctx.done(null); // skip → default
			if (key.name === "return" || key.name === "enter") {
				if (matches.length > 0) return ctx.done(matches[Math.min(cursor, matches.length - 1)]);
				if (opts?.allowCustom && query.trim()) return ctx.done(query.trim());
				return ctx.done(null);
			}
			if (key.name === "up") cursor = Math.max(0, cursor - 1);
			else if (key.name === "down") cursor = Math.min(matches.length - 1, cursor + 1);
			else if (key.name === "backspace") {
				query = query.slice(0, -1);
				cursor = 0;
			} else if (str && str.length === 1 && str.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) {
				query += str;
				cursor = 0;
			} else return;
			ctx.redraw();
		},
		run,
	);
}
