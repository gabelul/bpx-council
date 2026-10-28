import React, { useEffect, useRef, useState } from "react";
import { WorkbenchInput } from "./workbench-input.js";

/** Transient account input; raw value never leaves component except explicit submission. */
export interface WorkbenchSecretInputProps { width: number; onSubmit(value: string): void }

/** Mask from first character, retain caret on resize, clear on submit and unmount.
 * @param props Cell width and direct account callback. @returns Private single-line editor.
 */
export function WorkbenchSecretInput({ width, onSubmit }: WorkbenchSecretInputProps): React.ReactElement {
	const value = useRef("");
	const [, repaint] = useState(0);
	useEffect(() => () => { value.current = ""; }, []);
	return <WorkbenchInput value={value.current} width={width} secret onChange={next => { value.current = next; repaint(count => count + 1); }} onSubmit={answer => { value.current = ""; repaint(count => count + 1); onSubmit(answer); }} />;
}
