import React, { useEffect, useRef, useState } from "react";
import { Box, Text, useInput, useStdin, type Key } from "ink";
import stripAnsi from "strip-ansi";
import { editWorkbenchInput, workbenchInputWindow } from "./workbench-input.js";

/** Multiline edit result, using code-point caret offsets. */
export interface MultilineEdit { value: string; cursor: number }
/** Edit multiline content without stripping pasted LF/tab.
 * @param value Stored text. @param cursor Code-point caret. @param input Key/paste.
 * @param key Ink flags. @param forwardDelete CSI Delete marker.
 * @returns Text/caret; Ctrl-S belongs to submit, Esc/Ctrl-C to controller.
 */
export function editMultilineInput(value: string, cursor: number, input: string, key: Partial<Key>, forwardDelete = false): MultilineEdit {
	const chars = Array.from(value);
	const offset = Math.max(0, Math.min(cursor, chars.length));
	const start = offset === 0 ? 0 : chars.lastIndexOf("\n", offset - 1) + 1;
	const nextBreak = chars.indexOf("\n", offset);
	const end = nextBreak < 0 ? chars.length : nextBreak;
	if (key.home || (key.ctrl && input === "a")) return { value, cursor: start };
	if (key.end || (key.ctrl && input === "e")) return { value, cursor: end };
	if (key.upArrow) {
		if (!start) return { value, cursor: offset };
		const previous = start < 2 ? 0 : chars.lastIndexOf("\n", start - 2) + 1;
		return { value, cursor: previous + Math.min(offset - start, start - previous - 1) };
	}
	if (key.downArrow) {
		if (nextBreak < 0) return { value, cursor: offset };
		const nextEnd = chars.indexOf("\n", end + 1);
		return { value, cursor: end + 1 + Math.min(offset - start, (nextEnd < 0 ? chars.length : nextEnd) - end - 1) };
	}
	if (key.return || (!key.ctrl && !key.meta && !key.escape && !key.tab && !key.leftArrow && !key.rightArrow && !key.delete && !key.backspace && !key.pageUp && !key.pageDown)) {
		const paste = key.return ? "\n" : stripAnsi(input).replace(/\r\n?/g, "\n").replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, "");
		const added = Array.from(paste); chars.splice(offset, 0, ...added);
		return { value: chars.join(""), cursor: offset + added.length };
	}
	return editWorkbenchInput(value, offset, input, key, forwardDelete);
}

/** Controlled LF-preserving editor. Enter inserts newline, Ctrl-S applies.
 * @param props Exact value, terminal bounds and callbacks. @returns Scrollable logical lines with caret.
 */
export function WorkbenchMultilineInput({ value, width, height, onChange, onSubmit }: { value: string; width: number; height: number; onChange(value: string): void; onSubmit(value: string): void }): React.ReactElement {
	const { stdin } = useStdin();
	const cursor = useRef(Array.from(value).length);
	const deletes = useRef<boolean[]>([]);
	const partial = useRef("");
	const [, repaint] = useState(0);
	useEffect(() => {
		/** Preserve physical Backspace versus forward Delete before Ink parses bytes. */
		const remember = (data: Buffer | string): void => {
			const raw = partial.current + data.toString();
			for (const match of raw.matchAll(/\x7f|\x08|\x1b\[3(?:;\d+(?::\d+)?)?~/g)) if (!/:3~$/.test(match[0])) deletes.current.push(match[0].startsWith("\x1b"));
			partial.current = /\x1b(?:\[3?(?:;\d*(?::\d*)?)?)?$/.exec(raw)?.[0] ?? "";
		};
		stdin.prependListener("data", remember);
		return () => { stdin.off("data", remember); };
	}, [stdin]);
	useInput((input, key) => {
		if (key.eventType === "release" || key.escape || key.tab || (key.ctrl && input === "c")) return;
		if (key.ctrl && input === "s") { onSubmit(value); return; }
		const edit = editMultilineInput(value, cursor.current, input, key, key.delete || key.backspace ? deletes.current.shift() ?? false : false);
		cursor.current = edit.cursor;
		if (edit.value !== value) onChange(edit.value); else repaint(count => count + 1);
	});
	const before = Array.from(value).slice(0, cursor.current).join("");
	const lineIndex = before.split("\n").length - 1;
	const offset = Array.from(before.split("\n").at(-1) ?? "").length;
	const lines = value.split("\n");
	const start = Math.max(0, Math.min(lines.length - Math.max(1, height), lineIndex - Math.floor(height / 2)));
	return <Box flexDirection="column" height={Math.max(1, height)} overflow="hidden">{lines.slice(start, start + Math.max(1, height)).map((line, i) => {
		const active = i + start === lineIndex;
		// Sanitize each visible logical line, not stored value: LF survives edits and acceptance.
		const safe = stripAnsi(line).replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
		const visible = workbenchInputWindow(safe, active ? offset : 0, width);
		return <Text key={i} wrap="truncate-end">{active ? <>{visible.before}<Text inverse>{visible.caret}</Text>{visible.after}</> : safe}</Text>;
	})}</Box>;
}
