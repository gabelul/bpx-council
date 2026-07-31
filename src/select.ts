/**
 * select — single-choice pickers, the counterparts to the checkbox multiselect.
 *
 * `runSelect` is a short arrow-key list (scope, backend, mode). `runFilterSelect`
 * is a type-to-filter list for when there are too many options to arrow through
 * — the 120-model opencode catalog is the reason it exists. Both ride the shared
 * raw-mode driver, so the terminal handling lives in one place.
 */

import { clip, runKeyLoop } from "./interactive.js";
import { bold, cyan, dim } from "./style.js";

export interface SelectOption {
	label: string;
	value: string;
}

/** Render the single-select list, cursor row highlighted. */
export function renderSelect(options: SelectOption[], cursor: number, header: string, width = 80): string {
	const labelWidth = Math.max(4, width - 4); // prefix "  ❯ " is 4 columns
	const lines = [dim(clip(header, width))];
	options.forEach((option, i) => {
		const atCursor = i === cursor;
		const pointer = atCursor ? cyan("❯") : " ";
		const text = clip(option.label, labelWidth);
		lines.push(`  ${pointer} ${atCursor ? bold(text) : text}`);
	});
	lines.push("");
	lines.push(dim(clip("  ↑↓ move · enter select · esc cancel", width)));
	return `${lines.join("\n")}\n`;
}

/**
 * Pick one option with the arrow keys. Resolves the chosen `value`, or null on
 * escape / no raw mode.
 */
export function runSelect(header: string, options: SelectOption[], initial = 0): Promise<string | null> {
	const n = options.length;
	let cursor = Math.min(Math.max(0, initial), Math.max(0, n - 1));
	return runKeyLoop<string>(
		() => renderSelect(options, cursor, header, process.stderr.columns || 80),
		(_str, key, ctx) => {
			if (!key) return;
			if (key.name === "escape" || key.name === "q") return ctx.done(null);
			if (key.name === "return" || key.name === "enter") return ctx.done(options[cursor]?.value ?? null);
			if (key.name === "up" || key.name === "k") cursor = (cursor - 1 + n) % n;
			else if (key.name === "down" || key.name === "j") cursor = (cursor + 1) % n;
			else return;
			ctx.redraw();
		},
	);
}

/** Render a single-line text input with a cursor and a default hint. */
export function renderInput(header: string, value: string, def: string, width = 80): string {
	const hint = !value && def ? `  ${dim(`(default: ${def})`)}` : "";
	const lines = [dim(clip(header, width))];
	lines.push(`  ${cyan("›")} ${clip(value, Math.max(4, width - 6))}${dim("▏")}${hint}`);
	lines.push("");
	lines.push(dim(clip("  type · enter accept · esc default", width)));
	return `${lines.join("\n")}\n`;
}

/**
 * A single-line text field. Enter (or an empty enter) accepts the typed value or
 * the default; escape takes the default. Always resolves a string.
 */
export function runInput(header: string, def = ""): Promise<string> {
	let value = "";
	return runKeyLoop<string>(
		() => renderInput(header, value, def, process.stderr.columns || 80),
		(str, key, ctx) => {
			if (!key) return;
			if (key.name === "escape") return ctx.done(def);
			if (key.name === "return" || key.name === "enter") return ctx.done(value.trim() || def);
			if (key.name === "backspace") value = value.slice(0, -1);
			else if (str && str.length === 1 && str.charCodeAt(0) >= 32 && !key.ctrl && !key.meta) value += str;
			else return;
			ctx.redraw();
		},
	).then((v) => v ?? def);
}

/** A y/n confirm. Enter or escape takes the default; y/n set it. Always a boolean. */
export function runConfirm(header: string, defaultYes: boolean): Promise<boolean> {
	return runKeyLoop<boolean>(
		() => `${dim(clip(header, process.stderr.columns || 80))} ${dim(defaultYes ? "[Y/n]" : "[y/N]")}\n`,
		(str, key, ctx) => {
			if (!key) return;
			if (key.name === "return" || key.name === "enter" || key.name === "escape") return ctx.done(defaultYes);
			if (str === "y" || str === "Y") return ctx.done(true);
			if (str === "n" || str === "N") return ctx.done(false);
		},
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
	const lines = [dim(clip(header, width))];
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
			const text = clip(match, Math.max(4, width - 4));
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
export function runFilterSelect(header: string, items: string[], opts?: { allowCustom?: boolean }): Promise<string | null> {
	let query = "";
	let cursor = 0;
	const maxRows = 8;
	return runKeyLoop<string>(
		() => renderFilter(header, query, filterItems(items, query), cursor, maxRows, process.stderr.columns || 80),
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
	);
}
