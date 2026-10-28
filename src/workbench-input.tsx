import React, { useEffect, useRef, useState } from "react";
import { Text, useInput, useStdin, type Key } from "ink";
import stringWidth from "string-width";

/** Controlled single-line input; width is a terminal-cell budget, not string length. */
export interface WorkbenchInputProps {
	value: string;
	width: number;
	caretHomeEnd?: boolean;
	/** Mask every code point, including the first, without changing edit offsets. */
	secret?: boolean;
	onChange(value: string): void;
	onSubmit(value: string): void;
}

/** Apply one editing event using Unicode code-point offsets.
 * @param value Current single-line value. @param cursor Caret offset.
 * @param input Printable text or paste. @param key Ink key flags.
 * @param forwardDelete Whether raw Delete was CSI 3~, rather than ASCII DEL.
 * @returns New value and caret; unrelated shortcuts leave both unchanged.
 */
export function editWorkbenchInput(value: string, cursor: number, input: string, key: Partial<Key>, forwardDelete = false): { value: string; cursor: number } {
	const chars = Array.from(value);
	let offset = Math.max(0, Math.min(cursor, chars.length));
	if (key.home || (key.ctrl && input === "a")) offset = 0;
	else if (key.end || (key.ctrl && input === "e")) offset = chars.length;
	else if (key.leftArrow) offset = Math.max(0, offset - 1);
	else if (key.rightArrow) offset = Math.min(chars.length, offset + 1);
	else if (key.backspace || key.delete) {
		if (key.delete && forwardDelete) chars.splice(offset, 1);
		else if (offset > 0) chars.splice(--offset, 1);
	} else if (!key.ctrl && !key.meta && !key.escape && !key.tab && !key.return && !key.upArrow && !key.downArrow && !key.pageUp && !key.pageDown) {
		const pasted = Array.from(input.replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
		chars.splice(offset, 0, ...pasted); offset += pasted.length;
	}
	return { value: chars.join(""), cursor: offset };
}

/** Keep caret and surrounding text inside a horizontal terminal-cell viewport.
 * @param value Single-line text. @param cursor Code-point caret. @param width Cell budget.
 * @returns Visible text before/at/after caret, without truncating stored input.
 */
export function workbenchInputWindow(value: string, cursor: number, width: number): { before: string; caret: string; after: string } {
	const chars = Array.from(value);
	const offset = Math.max(0, Math.min(cursor, chars.length));
	const budget = Math.max(1, width);
	const caret = chars[offset] ?? " ";
	let start = offset;
	let cells = stringWidth(caret);
	while (start > 0 && cells + stringWidth(chars[start - 1]) <= budget) cells += stringWidth(chars[--start]);
	let end = offset + 1;
	while (end < chars.length && cells + stringWidth(chars[end]) <= budget) cells += stringWidth(chars[end++]);
	return { before: chars.slice(start, offset).join(""), caret: stringWidth(caret) <= budget ? caret : " ", after: chars.slice(offset + 1, end).join("") };
}

/** Editable field with real Delete, Home/End, Ctrl-A/E and horizontal scrolling.
 * @param props Controlled value, width and edit/submit callbacks.
 * @returns Focused single-line field; global navigation remains with workbench.
 */
export function WorkbenchInput({ value, width, caretHomeEnd = true, secret = false, onChange, onSubmit }: WorkbenchInputProps): React.ReactElement {
	const { stdin } = useStdin();
	const position = useRef(Array.from(value).length);
	const deletes = useRef<boolean[]>([]);
	const partial = useRef("");
	const [, repaint] = useState(0);
	useEffect(() => {
		// Ink maps both ASCII DEL (Backspace) and CSI 3~ (Delete) to key.delete.
		// Raw data is emitted by stdin.read() before Ink dispatches parsed keys.
		/** Remember deletion semantics without consuming or replacing Ink's input stream. */
		const remember = (data: Buffer | string): void => {
			const text = partial.current + data.toString();
			for (const match of text.matchAll(/\x7f|\x08|\x1b\[3(?:;\d+(?::\d+)?)?~/g)) {
				if (!/:3~$/.test(match[0])) deletes.current.push(match[0].startsWith("\x1b"));
			}
			const pending = /\x1b(?:\[3?(?:;\d*(?::\d*)?)?)?$/.exec(text);
			partial.current = pending?.[0] ?? "";
		};
		stdin.prependListener("data", remember);
		return () => { stdin.off("data", remember); };
	}, [stdin]);
	useInput((input, key) => {
		if (key.eventType === "release") return;
		if (key.return) { onSubmit(value); return; }
		if (key.escape || key.tab || (key.ctrl && input === "c")) return;
		if (!caretHomeEnd && (key.home || key.end)) return;
		const forward = key.delete || key.backspace ? deletes.current.shift() ?? false : false;
		const edited = editWorkbenchInput(value, position.current, input, key, forward);
		position.current = edited.cursor;
		if (edited.value !== value) onChange(edited.value);
		else repaint(count => count + 1);
	});
	const visible = workbenchInputWindow(secret ? "*".repeat(Array.from(value).length) : value, position.current, width);
	return <Text wrap="truncate-end">{visible.before}<Text inverse>{visible.caret}</Text>{visible.after}</Text>;
}
