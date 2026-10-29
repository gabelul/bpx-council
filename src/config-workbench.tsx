import React, { useEffect, useState } from "react";
import { Box, Text, render, useApp, useInput, useStdout, type Key } from "ink";
import { WorkbenchInput } from "./workbench-input.js";
import { WorkbenchSecretInput } from "./workbench-secret-input.js";
import type { SdkAccountView } from "./sdk-account-controller.js";
import type { SdkProviderService } from "./sdk-types.js";
import { WorkbenchMultilineInput } from "./workbench-multiline-input.js";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import type { BackendConfig, BpxCouncilConfig } from "./config.js";
import { backendLabel, backendName, configRoute, type EditorOptions } from "./config-editor.js";
import { ConfigDraft, SECTIONS, confirmationChoices, draftFields, modalChoices, type DraftDiscovery, type DraftField, type DraftModal, type WorkbenchResult } from "./config-draft.js";
import type { AvailableBackend } from "./detect.js";
import { workbenchGeometry, type WorkbenchGeometry, type WorkbenchSize } from "./workbench-layout.js";
export { workbenchFrame, workbenchGeometry, type WorkbenchFrame, type WorkbenchGeometry, type WorkbenchSize } from "./workbench-layout.js";

const AMBER = "#ffd787";
const BLUE = "#000080";
const SURROUND = "#151820";
const BORDER = "#c0c0c0";
/** View props: controller owns draft/focus, size bounds rendered output. */
export interface WorkbenchViewProps { controller: ConfigDraft; size: WorkbenchSize }

/** Clip untrusted display text by terminal cells, stripping ANSI/control sequences.
 * @param text Display label. @param width Maximum cells. @returns Single safe line.
 */
export function fitWorkbenchText(text: string, width: number): string {
	const plain = stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, " ");
	if (width <= 0) return "";
	if (stringWidth(plain) <= width) return plain;
	let out = "";
	for (const char of plain) { if (stringWidth(out + char) > width - 1) break; out += char; }
	return `${out}…`;
}

/** Calculate bounded viewport containing selection. @param length List length. @param selected Focus. @param height Visible rows. @returns Start/end indices. */
export function workbenchWindow(length: number, selected: number, height: number): { start: number; end: number } {
	const count = Math.max(1, height);
	const start = Math.max(0, Math.min(length - count, selected - Math.floor(count / 2)));
	return { start, end: Math.min(length, start + count) };
}

/** Suppress only color props: Ink still owns styling, cursor control and raw mode.
 * @param color Requested foreground/background/border color. @param noColor NO_COLOR value; empty permits color.
 * @returns Color unless NO_COLOR is nonempty, regardless of FORCE_COLOR.
 */
export function workbenchColor(color: string | undefined, noColor: string | undefined = process.env.NO_COLOR): string | undefined {
	return noColor ? undefined : color;
}

/** One row fragment; Row applies explicit NO_COLOR opt-out before passing colors to Ink. */
export interface WorkbenchSegment { text: string; color?: string }

/** Accent exact backend identity, never model IDs or persona names.
 * @param name Route's backendName or detected backend name. @returns Accent, or neutral fallback.
 */
export function backendAccent(name?: string): string | undefined {
	switch (name) {
		case "codex": case "openai": case "sdk:openai": return "#87ffd7";
		case "claude": case "anthropic": case "sdk:anthropic": return "#ffaf87";
		case "pi": return "#d7afff";
		case "opencode": return "#87ffff";
		case "gemini": case "google": return "#d7d7af";
		default: return undefined;
	}
}

/** Clip all fragments against one cell budget, with neutral ellipsis and no incoming ANSI.
 * @param segments Plain/accent fragments. @param width Total row cells. @returns Safe clipped fragments.
 */
export function fitWorkbenchSegments(segments: WorkbenchSegment[], width: number): WorkbenchSegment[] {
	const safe = segments.map(segment => ({ ...segment, text: fitWorkbenchText(segment.text, Number.MAX_SAFE_INTEGER) }));
	const plain = safe.map(segment => segment.text).join("");
	const line = fitWorkbenchText(plain, width);
	const truncated = line !== plain && width > 0;
	let remaining = line.length - (truncated ? 1 : 0);
	const clipped = safe.map(segment => {
		const text = segment.text.slice(0, Math.max(0, remaining));
		remaining -= text.length;
		return { ...segment, text };
	}).filter(segment => segment.text);
	if (truncated) clipped.push({ text: "…" });
	return clipped;
}

/** One terminal row; amber focus overrides every identity accent.
 * @param props Text/fragments, cell budget and focus. @returns Non-wrapping Ink row.
 */
function Row({ text = "", segments, width, active = false, muted = false, color = "white" }: { text?: string; segments?: WorkbenchSegment[]; width: number; active?: boolean; muted?: boolean; color?: string }): React.ReactElement {
	if (!segments) {
		const line = fitWorkbenchText(text, width);
		return <Text wrap="truncate-end" color={workbenchColor(active ? "black" : muted ? "#afafd7" : color)} backgroundColor={workbenchColor(active ? AMBER : undefined)} bold={active}>{line + " ".repeat(Math.max(0, width - stringWidth(line)))}</Text>;
	}
	const parts = fitWorkbenchSegments(segments, width);
	const cells = stringWidth(parts.map(part => part.text).join(""));
	return <Text wrap="truncate-end" color={workbenchColor(active ? "black" : muted ? "#afafd7" : color)} backgroundColor={workbenchColor(active ? AMBER : undefined)} bold={active}>{parts.map((part, index) => <Text key={index} color={workbenchColor(active ? "black" : part.color)} backgroundColor={workbenchColor(active ? AMBER : undefined)}>{part.text}</Text>)}{" ".repeat(Math.max(0, width - cells))}</Text>;
}

/** Read selected or inherited route without creating config keys.
 * @param controller Draft context. @param field Editable row. @returns Effective backend, if pinned.
 */
function fieldRoute(controller: ConfigDraft, field: DraftField): BackendConfig | undefined {
	return field.target ? configRoute(controller.draft, field.target) ?? (field.target.section !== "advisor" ? controller.draft.solo?.backend : undefined) : undefined;
}

/** Keep inheritance/default labels neutral; color only pinned backend/model values.
 * @param controller Draft context. @param field Editable row. @returns Value fragments.
 */
function fieldValueSegments(controller: ConfigDraft, field: DraftField): WorkbenchSegment[] {
	const route = fieldRoute(controller, field);
	const inherited = field.target && field.target.section !== "advisor" && !configRoute(controller.draft, field.target);
	if (field.kind === "action" && field.target) {
		const label = backendLabel(route);
		const offset = field.value.lastIndexOf(label);
		if (offset >= 0) return [{ text: field.value.slice(0, offset) }, { text: label, color: route ? backendAccent(backendName(route)) : undefined }];
	}
	const prefix = inherited && field.kind === "backend" ? "Inherit Advisor → " : inherited && field.kind === "model" ? "Advisor → " : "";
	const color = route && (field.kind === "backend" || (field.kind === "model" && route.model)) ? backendAccent(backendName(route)) : undefined;
	return [{ text: prefix }, { text: field.value.slice(prefix.length), color }];
}

/** Show selected backend/model rather than repeating sidebar section.
 * @param controller Draft context. @param modal Active editor. @returns Safe title fragments.
 */
function modalTitle(controller: ConfigDraft, modal: DraftModal): WorkbenchSegment[] {
	if (!modal.field.target) return [{ text: `Edit ${modal.field.label}` }];
	const target = modal.field.target;
	const role = target.role === "synthesizer" ? "Verdict" : target.member && target.role === "Verdict" ? "Verdict (member)" : target.role;
	const context = process.env.NO_COLOR && (target.section === "council" || target.section === "debate") ? `${target.section === "council" ? "Council" : "Debate"} / ${role} · ` : "";
	const route = fieldRoute(controller, modal.field);
	if (!route) return [{ text: `Edit ${modal.field.label} · ${context}Auto-detect` }];
	const name = backendName(route);
	const names: Record<string, string> = { codex: "Codex", openai: "OpenAI", claude: "Claude", anthropic: "Anthropic", pi: "Pi", opencode: "OpenCode", gemini: "Gemini", google: "Google" };
	const display = Object.hasOwn(names, name) ? names[name] : name;
	return [{ text: `Edit ${modal.field.label} · ${context}` }, { text: display, color: backendAccent(name) }, ...(route.model ? [{ text: " · " }, { text: route.model, color: backendAccent(name) }] : [])];
}

/** Compact review with explicit route identities, independent of shortened field labels.
 * @param controller Draft context. @returns Rows excluding secrets, args and persona prompts.
 */
export function reviewRows(controller: ConfigDraft): WorkbenchSegment[][] {
	return [
		[{ text: "Advisor: " }, { text: backendLabel(controller.draft.solo?.backend), color: controller.draft.solo?.backend ? backendAccent(backendName(controller.draft.solo.backend)) : undefined }],
		...(["Gut-check", "Council", "Debate"] as const).flatMap(section => draftFields(controller.draft, section).filter(f => f.kind === "backend").map(field => {
			const target = field.target!;
			const role = target.member ? `${target.role}${target.role === "Verdict" ? " (member)" : ""}` : target.role === "synthesizer" ? "Verdict" : target.role;
			return [{ text: `${section === "Gut-check" ? section : `${section} / ${role}`}: ` }, ...fieldValueSegments(controller, field)];
		})),
		[{ text: `Output tokens: ${controller.draft.gutCheck?.maxOutputTokens ?? "default"}` }],
		[{ text: `Default mode: ${controller.draft.defaultMode ?? "solo (default)"}` }],
	];
}

/** Fixed-height DOS workbench; narrow terminals show active pane only.
 * @param props Controller and current output dimensions. @returns Workbench frame.
 */
export function WorkbenchView({ controller: c, size }: WorkbenchViewProps): React.ReactElement {
	const geometry = workbenchGeometry(c, size);
	const { width: terminalWidth, height: terminalHeight, main, dialog, narrow, tiny, sideWidth } = geometry;
	const width = main.width, height = main.height;
	const contentHeight = c.modal ? dialog.innerHeight - 1 : geometry.contentHeight;
	const detailWidth = c.modal ? dialog.innerWidth : geometry.detailWidth;
	if (c.account?.view) return <AccountOverlay controller={c} geometry={geometry} />;
	if (c.operation) return <BusyOverlay controller={c} geometry={geometry} />;
	const modal = c.modal;
	const advisor = c.draft.solo?.backend;
	const diagnostic = c.screen.type === "backend-detail" ? c.backendDiagnostics.find(row => row.name === (c.screen as { name: string }).name) : undefined;
	const receipt = diagnostic && c.advisorMatches(diagnostic.name) ? c.connectionReceipt({ section: "advisor", role: "Advisor" }) : undefined;
	const routeNotice = c.section === "Backends"
		? receipt ? ` ${c.testStatus(receipt)} · Requested: ${receipt.result.route} · ${receipt.result.elapsedMs}ms`
			: diagnostic?.detail ? ` ${diagnostic.detail}` : " Local versions only, not login/model checks. CLI startup may migrate its global settings."
		: advisor?.type === "cli" && advisor.command === "pi" && advisor.args !== undefined
			? " Pi rejects custom args. Use Auto-detect then choose Pi to reset."
			: advisor?.type === "cli" && advisor.args?.length
				? " Advisor custom args override model/effort flags; kept unchanged."
				: " Stored values stay unchanged until explicit edit.";
	const rows: React.ReactNode[] = [];
	const detailActive = c.pane === "detail" && !modal && !c.confirmation && !c.operation;
	const parentFocus = !modal && !c.confirmation && !c.operation;
	if (modal) {
		const choices = modalChoices(modal);
		const viewport = workbenchWindow(choices.length, modal.index, geometry.modalItems);
		rows.push(<Row key="dialog" segments={modalTitle(c, modal)} width={detailWidth} />);
		if (c.multiline) rows.push(<WorkbenchMultilineInput key={modal.field.id} value={modal.text} width={Math.max(1, detailWidth)} height={Math.max(1, contentHeight - 2)} onChange={value => c.text(value)} onSubmit={value => c.submit(value)} />);
		else rows.push(<Box key="input" width={Math.max(1, detailWidth)} overflow="hidden"><Text color={workbenchColor(AMBER)}>{modal.type === "text" ? "Value: " : "Find: "}</Text><WorkbenchInput key={`${modal.field.id}:${modal.type}`} value={fitWorkbenchText(modal.text, Number.MAX_SAFE_INTEGER)} width={Math.max(1, detailWidth - (modal.type === "text" ? 7 : 6))} caretHomeEnd={modal.type === "text"} onChange={value => c.text(value)} onSubmit={value => modal.type === "text" ? c.submit(value) : c.choose()} /></Box>);
		if (modal.type === "choices") {
			for (let i = viewport.start; i < viewport.end; i++) {
				const choice = choices[i];
				const name = choice.accentText ?? "";
				rows.push(<Row key={`choice:${i}`} segments={[{ text: `${i === modal.index ? "►" : " "} ` }, { text: name, color: backendAccent(choice.backend) }, { text: choice.label.slice(name.length) }]} active={i === modal.index} width={detailWidth} />);
			}
		}
		if (contentHeight > 3) rows.push(<Row key="lookup" text={modal.loading ? "Loading catalog… Esc cancels lookup" : modal.notice} width={detailWidth} muted />);
		const route = modal.field.target ? configRoute(c.draft, modal.field.target) : undefined;
		if (route?.command === "pi") rows.push(<Row key="pi" text={modal.field.kind === "effort" ? "Pi: static thinking choices, not model capabilities." : "Pi: auth-filtered catalog; extensions disabled; no extension-only models."} width={detailWidth} muted />);
	} else if (c.screen.type === "preview") {
		const candidate = c.candidate!;
		const actionHeight = geometry.detailItems;
		const summaryHeight = contentHeight - actionHeight;
		if (summaryHeight) rows.push(<Row key="candidate-name" text={`Name: ${candidate.value.name} · ${candidate.value.stance} (bias, not verdict)`} width={detailWidth} />);
		const promptLines = candidate.value.systemPrompt.split("\n");
		const promptBudget = Math.max(0, summaryHeight - 1);
		const clipped = promptLines.length > promptBudget || promptLines.some(line => stringWidth(line) > detailWidth);
		const visibleLines = Math.max(0, promptBudget - (clipped ? 1 : 0));
		for (const [index, line] of promptLines.slice(0, visibleLines).entries()) rows.push(<Row key={`prompt:${index}`} text={line} width={detailWidth} />);
		if (clipped && promptBudget) rows.push(<Row key="prompt-more" text="Prompt clipped: Edit candidate > System prompt" width={detailWidth} muted />);
		const viewport = workbenchWindow(c.fields.length, c.index, actionHeight);
		for (let i = viewport.start; i < viewport.end; i++) { const field = c.fields[i]; rows.push(<Row key={field.id} text={`${i === c.index && detailActive ? "►" : " "} ${field.label} · ${field.value}`} width={detailWidth} active={detailActive && i === c.index} />); }
	} else if (c.screen.type === "backend-detail") {
		const name = c.screen.name;
		const diagnostic = c.backendDiagnostics.find(row => row.name === name);
		if (diagnostic && contentHeight > 1) {
			rows.push(<Row key="local-state" text={`${c.backendStatus(diagnostic)} · Version: ${c.backendVersion(diagnostic)}`} width={detailWidth} />);
			if (contentHeight > 2) rows.push(<Row key="local-path" text={`Path: ${diagnostic.path ?? (diagnostic.kind === "http" ? "HTTP; no CLI" : "not found")}`} width={detailWidth} muted />);
		}
		const viewport = workbenchWindow(c.fields.length, c.index, geometry.detailItems);
		for (let i = viewport.start; i < viewport.end; i++) rows.push(<Row key={c.fields[i].id} text={`${i === c.index && detailActive ? "►" : " "} ${c.fields[i].label}`} width={detailWidth} active={detailActive && i === c.index} />);
	} else if (c.screen.type === "results") {
		const selected = c.testResults[c.index];
		const listHeight = geometry.detailItems;
		const viewport = workbenchWindow(c.fields.length, c.index, listHeight);
		for (let i = viewport.start; i < viewport.end; i++) rows.push(<Row key={c.fields[i].id} text={`${i === c.index && detailActive ? "►" : " "} ${c.fields[i].label} · ${c.fields[i].value}`} width={detailWidth} active={detailActive && i === c.index} />);
		if (selected && contentHeight > 1) {
			rows.push(<Row key="result-route" text={`Requested: ${selected.result.route} · ${selected.result.elapsedMs}ms`} width={detailWidth} />);
			if (contentHeight > 2) rows.push(<Row key="result-text" text={selected.result.error ?? selected.result.text} width={detailWidth} />);
		}
	} else if (c.section === "Review") {
		const summary = reviewRows(c);
		const limit = Math.max(0, contentHeight - 3);
		for (const [i, segments] of summary.slice(0, limit).entries()) rows.push(<Row key={`review:${i}`} segments={segments} width={detailWidth} />);
		if (summary.length > limit && limit > 0) rows[limit - 1] = <Row key="more" text={`${summary.length - limit + 1} more routes; inspect Council/Debate sections`} width={detailWidth} muted />;
		if (contentHeight > 2) rows.push(<Row key="validation" text={c.error ? `Cannot save: ${c.error}` : "Draft validated. Only Save writes file."} width={detailWidth} muted={!c.error} />);
		rows.push(<Row key="back" text={`${parentFocus ? "►" : " "} Back to editing`} width={detailWidth} active={detailActive && (c.focus.Review ?? 0) === 0} />);
		if (!c.error) rows.push(<Row key="save" text={`${parentFocus ? "►" : " "} Save`} width={detailWidth} active={detailActive && c.focus.Review === 1} />);
	} else if (c.section === "Discard") {
		if (contentHeight > 2) rows.push(<Row key="prompt" text={c.dirty ? "Discard unsaved changes? File stays untouched." : "No changes. Exit without writing."} width={detailWidth} />);
		rows.push(<Row key="keep" text={`${parentFocus ? "►" : " "} Keep editing`} width={detailWidth} active={detailActive && (c.focus.Discard ?? 0) === 0} />);
		rows.push(<Row key="discard" text={`${parentFocus ? "►" : " "} ${c.dirty ? "Discard & exit" : "Exit"}`} width={detailWidth} active={detailActive && c.focus.Discard === 1} />);
	} else if (c.section === "Backends") {
		const viewport = workbenchWindow(c.fields.length, c.index, contentHeight);
		for (let i = viewport.start; i < viewport.end; i++) {
			const field = c.fields[i];
			const segments: WorkbenchSegment[] = [{ text: `${i === c.index && detailActive ? "►" : " "} ` }, { text: field.label, ...(field.action === "backend-detail" ? { color: backendAccent(field.name) } : {}) }, { text: field.action === "backend-detail" ? `: ${field.value}` : "" }];
			rows.push(<Row key={field.id} segments={segments} width={detailWidth} active={detailActive && i === c.index} />);
		}
	} else {
		const viewport = workbenchWindow(c.fields.length, c.index, contentHeight);
		for (let i = viewport.start; i < viewport.end; i++) {
			const field = c.fields[i];
			const labelWidth = Math.min(28, Math.max(8, Math.floor(detailWidth * 0.42)));
			const label = fitWorkbenchText(field.label, labelWidth);
			const marker = i === c.index && detailActive ? "►" : " ";
			const segments = narrow && field.kind === "action" ? [{ text: `${marker} ${field.label}` }, ...(field.value ? [{ text: " · " }, ...fieldValueSegments(c, field)] : [])]
				: [{ text: `${marker} ${label}${" ".repeat(Math.max(0, labelWidth - stringWidth(label)))} ` }, ...fieldValueSegments(c, field)];
			rows.push(<Row key={field.id} segments={segments} width={detailWidth} active={detailActive && i === c.index} />);
		}
	}
	const sidebarWindow = workbenchWindow(SECTIONS.length, SECTIONS.indexOf(c.section), geometry.contentHeight);
	const sidebar = <Box flexDirection="column" width={Math.max(1, sideWidth)}>
		{SECTIONS.slice(sidebarWindow.start, sidebarWindow.end).map(section => <Row key={section} text={`${section === c.section && parentFocus ? "►" : " "} ${SECTIONS.indexOf(section) + 1} ${section}`} width={Math.max(1, sideWidth)} active={c.pane === "sidebar" && parentFocus && section === c.section} />)}
	</Box>;
	const detail = <Box flexDirection="column" width={Math.max(1, detailWidth)} height={contentHeight} overflow="hidden">{rows.slice(0, contentHeight)}</Box>;
	const actionPane = c.section === "Review" || c.section === "Discard";
	const selectedField = c.fields[c.index];
	const enterOnly = selectedField?.kind === "action" && !["route", "persona", "library", "generator", "candidate-edit", "backend-detail", "direct-providers", "installed-clis"].includes(selectedField.action ?? "");
	const hint = c.multiline ? "Enter newline · Ctrl-S apply · Esc cancel · Ctrl-C exit"
		: tiny || narrow
		? modal ? "←→ caret Enter apply Esc ^C" : c.pane === "sidebar" ? "→ open ← stay Tab ↑↓ Enter Esc ^C" : actionPane ? "← back → pane Enter Tab ↑↓ Esc ^C" : enterOnly ? "Enter action ← back Tab ↑↓ Esc ^C" : "→ open ← back Enter Tab ↑↓ Esc ^C"
		: modal?.type === "text" ? "←→ caret  Enter apply  Esc cancel  Ctrl-C exit"
			: modal ? "←→ caret  ↑↓ Home End PgUp/PgDn choose  Enter apply  Esc cancel  Ctrl-C exit"
				: c.pane === "sidebar" ? "→/Enter open  ← stay  Tab panes  ↑↓ move  1–8 sections  Esc asks exit  Ctrl-C abort"
					: actionPane ? "← sidebar  Enter action  → pane only  Tab panes  ↑↓ move  Esc back  Ctrl-C abort"
						: enterOnly ? "Enter action  ← back  Tab panes  ↑↓ move  1–8 sections  Esc back  Ctrl-C abort"
							: "→/Enter open  ← back  Tab panes  ↑↓ move  1–8 sections  Esc back  Ctrl-C abort";
	const chromeWidth = width - (main.inset ? 2 : 0);
	const workspace = <Box position="absolute" marginLeft={main.left} marginTop={main.top} flexDirection="column" width={width} height={height} backgroundColor={workbenchColor(BLUE)} borderStyle={main.inset ? "double" : undefined} borderColor={workbenchColor(BORDER)} overflow="hidden">
		<Row text={tiny ? `${c.dirty ? "*" : "="} bpx-council | ${c.breadcrumb}` : ` ${c.dirty ? "UNSAVED" : "unchanged"} · bpx-council  CONFIG WORKBENCH`} width={chromeWidth} color={AMBER} />
		<Row text={`${tiny ? "" : " "}${c.options.scope}: ${c.options.path}`} width={chromeWidth} muted />
		{!tiny && <Row text={` ${c.breadcrumb}${modal ? ` > ${modal.field.label}` : ""}`} width={chromeWidth} />}
		<Box paddingX={Math.max(0, main.inset - 1)} height={geometry.contentHeight}>
			{narrow ? (c.pane === "sidebar" && !modal ? sidebar : modal ? <Box height={geometry.contentHeight} /> : detail) : <>{sidebar}<Box borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor={workbenchColor(detailActive ? AMBER : BORDER)} marginX={1} />{modal ? <Box width={geometry.detailWidth} height={geometry.contentHeight} /> : detail}</>}
		</Box>
		{!tiny && <Row text={c.error && c.section !== "Review" ? ` ${c.error}` : routeNotice} width={chromeWidth} muted={!c.error} />}
		<Row text={`${tiny ? "" : " "}${hint}`} width={chromeWidth} color={AMBER} />
	</Box>;
	return <Box position="relative" width={terminalWidth} height={terminalHeight} overflow="hidden" backgroundColor={workbenchColor(SURROUND)}>
		{!((modal || c.confirmation) && process.env.NO_COLOR) && workspace}
		{modal && <Box position="absolute" marginLeft={dialog.left} marginTop={dialog.top} width={dialog.width} height={dialog.height} paddingX={Math.max(0, dialog.inset - 1)} flexDirection="column" borderStyle={dialog.inset ? "double" : undefined} borderColor={workbenchColor(BORDER)} backgroundColor={workbenchColor(BLUE)} overflow="hidden">
			{detail}
			<Row text={hint} width={detailWidth} color={AMBER} />
		</Box>}
		{c.confirmation && <Confirmation controller={c} geometry={geometry} />}
	</Box>;
}

/** Wrap safe display text by real cells, preserving complete manual URLs. @param text Safe display copy. @param width Cell budget. @returns Reachable lines. */
export function wrapAccountText(text: string, width: number): string[] {
	const lines: string[] = [];
	for (const paragraph of text.split("\n")) {
		let line = "";
		for (const char of fitWorkbenchText(paragraph, Number.MAX_SAFE_INTEGER)) {
			if (line && stringWidth(line + char) > Math.max(1, width)) { lines.push(line); line = ""; }
			line += char;
		}
		lines.push(line);
	}
	return lines;
}

/** Share account rendering and keyboard page budgets, including complete safety copy. @param c Controller. @param geometry Cell bounds. @returns Account row/page budgets. */
function accountLayout(c: ConfigDraft, geometry: WorkbenchGeometry) {
	const account = c.account!; const view = account.view!;
	const { dialog } = geometry; const cells = dialog.innerWidth;
	const input = !view.cancelling && (view.phase === "key" && !view.busy || Boolean(view.prompt));
	const choices = !view.busy && (view.phase === "methods" || view.phase === "logout") ? account.choices : [];
	const choiceRows = Math.min(choices.length, Math.max(1, dialog.innerHeight - 4));
	const bodyHeight = Math.max(1, dialog.innerHeight - 2 - Number(input) - choiceRows - Number(view.phase === "receipt"));
	const warning = "Account changes persist immediately. Discard cannot undo them.";
	const shared = c.draft.sharePiAuth === true ? "Shared with pi: logins, removals and quota apply to pi too." : "";
	const copy = view.cancelling ? "Cancelling; awaiting SDK and account storage cleanup."
		: view.phase === "methods" ? `Account: ${view.provider.account.state}. Stored does not mean authenticated.\nCLI logins are separate.\n${shared}\n${warning}`
		: view.phase === "logout" ? `${shared ? "Removes the shared login; pi loses it too. " : ""}Remove Council's local account only; not provider-side revocation. Cancel keeps it.\n${warning}`
		: view.phase === "key" && !view.busy ? "Enter saves NOW.\nNo draft undo.\nAPI key: Enter saves literal input."
		: view.phase === "key" && view.busy ? "Saving account now. Discard cannot undo it.\nWaiting for SDK and account storage cleanup."
		: view.phase === "receipt" ? `${view.receipt?.changed ? "Account change saved." : view.receipt?.cancelled ? "Cancelled; no account change reported." : view.receipt?.ok ? "Account unchanged." : "Account action failed."}${view.receipt?.cancelled && view.receipt.changed ? " Cancellation arrived after account change; no rollback." : ""}\n${view.receipt?.error ?? "Stored account is not a connection test."}\n${warning}`
		: `${warning}\n${view.events.map(event => event.type === "url" ? `Open manually (no browser launch):\n${event.url}\n${event.instructions ?? ""}` : event.message).join("\n")}\n${view.prompt ? view.prompt.label : "Waiting for provider login/polling; Esc aborts."}`;
	const lines = wrapAccountText(copy, cells);
	const maxPage = Math.max(0, Math.ceil(lines.length / bodyHeight) - 1);
	return { cells, input, choices, choiceRows, bodyHeight, lines, maxPage };
}

/** Render transient account fields with shared pagination budgets. @param props Controller and geometry. @returns Account overlay. */
function AccountOverlay({ controller: c, geometry }: { controller: ConfigDraft; geometry: WorkbenchGeometry }): React.ReactElement {
	const account = c.account!; const view = account.view!;
	const { dialog, width, height } = geometry;
	const { cells, input, choices, choiceRows, bodyHeight, lines, maxPage } = accountLayout(c, geometry);
	const page = Math.min(view.page, maxPage); const start = page * bodyHeight;
	const window = workbenchWindow(choices.length, view.index, choiceRows);
	const title = view.cancelling ? "Cleanup" : view.busy
		? view.phase === "key" ? "Saving account" : view.phase === "logout" ? "Removing account" : "Signing in"
		: { methods: "Account", key: "API key", login: "Sign in", logout: "Remove account", receipt: "Result" }[view.phase];
	return <Box position="relative" width={width} height={height} overflow="hidden" backgroundColor={workbenchColor(SURROUND)}>
		<Box position="absolute" marginLeft={dialog.left} marginTop={dialog.top} width={dialog.width} height={dialog.height} paddingX={Math.max(0, dialog.inset - 1)} flexDirection="column" borderStyle={dialog.inset ? "double" : undefined} borderColor={workbenchColor(BORDER)} backgroundColor={workbenchColor(BLUE)} overflow="hidden">
			<Row text={`${view.provider.label} / ${title}`} width={cells} color={AMBER} />
			<Box flexDirection="column" height={bodyHeight} overflow="hidden">{lines.slice(start, start + bodyHeight).map((line, index) => <Row key={index} text={line} width={cells} />)}</Box>
			{input && <WorkbenchSecretInput key={view.phase === "key" ? "api-key" : "callback-answer"} width={cells} onSubmit={value => account.submit(value)} />}
			{choices.slice(window.start, window.end).map((choice, index) => <Row key={window.start + index} text={`${window.start + index === view.index ? "►" : " "} ${choice.label}`} width={cells} active={window.start + index === view.index} />)}
			{view.phase === "receipt" && <Row text="► Return to editing" width={cells} active />}
			<Row text={`Pg↑↓ ${page + 1}/${maxPage + 1} Esc ^C`} width={cells} color={AMBER} />
		</Box>
	</Box>;
}

/** Show one blocking operation; only app-owned metadata reaches this panel.
 * @param props Controller and terminal cell bounds. @returns Busy panel until transport cleanup settles.
 */
function BusyOverlay({ controller: c, geometry }: { controller: ConfigDraft; geometry: WorkbenchGeometry }): React.ReactElement {
	const [tick, setTick] = useState(0);
	useEffect(() => {
		const timer = setInterval(() => setTick(value => value + 1), 120);
		return () => clearInterval(timer);
	}, []);
	const operation = c.operation!;
	const { dialog, width, height } = geometry;
	const innerWidth = dialog.innerWidth;
	const local = operation.type === "local-check";
	const table = local && innerWidth >= 44 && dialog.innerHeight >= 10;
	const note = local && dialog.innerHeight >= 8;
	const logHeight = Math.max(1, dialog.innerHeight - 5 - Number(local) - Number(note) - (table ? 2 : 0));
	const logs = operation.rows ?? [];
	const current = logs.findIndex(row => ["Checking", "Testing", "Generating"].includes(row.status));
	const viewport = workbenchWindow(logs.length, current >= 0 ? current : Math.min(operation.completed, logs.length - 1), logHeight);
	const title = local ? "Local backend check" : operation.type === "generate" ? "Generating persona" : "Testing connection";
	const blocks = Math.min(Math.max(1, operation.total), Math.max(1, Math.floor(innerWidth / 2)));
	const filled = operation.total ? Math.floor(blocks * operation.completed / operation.total) : 0;
	const progress = Array.from({ length: blocks }, (_, index) => index < filled ? "█" : "░").join(" ");
	return <Box position="relative" width={width} height={height} overflow="hidden" backgroundColor={workbenchColor(SURROUND)}>
		<Box position="absolute" marginLeft={dialog.left} marginTop={dialog.top} width={dialog.width} height={dialog.height} paddingX={Math.max(0, dialog.inset - 1)} flexDirection="column" overflow="hidden" backgroundColor={workbenchColor(BLUE)} borderStyle={dialog.inset ? "double" : undefined} borderColor={workbenchColor(BORDER)}>
			<Row text={title} width={innerWidth} color={AMBER} />
			<Row text={operation.cancelling ? "Awaiting cleanup" : `${local ? "Checked" : "Done"} ${operation.completed}/${operation.total} ${local ? "steps" : "calls"} ${"-\\|/"[tick % 4]}`} width={innerWidth} />
			{local && <Row text={progress} width={innerWidth} color={AMBER} />}
			<Row text={`${local ? "CLI" : "Now"}: ${operation.current ?? "Preparing"}`} width={innerWidth} />
			{table && <><Row text={"Backend".padEnd(18) + " │ Status"} width={innerWidth} /><Row text={"─".repeat(19) + "┼" + "─".repeat(Math.max(0, innerWidth - 20))} width={innerWidth} muted /></>}
			<Box flexDirection="column" height={logHeight} overflow="hidden">
				{logs.slice(viewport.start, viewport.end).map((row, index) => <Row key={index} segments={table ? [{ text: fitWorkbenchText(row.label, 18).padEnd(18), color: backendAccent(row.label) }, { text: " │ " }, { text: row.status, color: row.status === "Version found" ? "#87ffd7" : row.status === "Check failed" ? "#ff8787" : row.status.includes("warning") ? AMBER : undefined }] : [{ text: `${row.label}: `, color: backendAccent(row.label) }, { text: row.status }]} active={viewport.start + index === current} width={innerWidth} />)}
			</Box>
			{note && <Row text="Local versions only. No model calls." width={innerWidth} muted />}
			<Row text={operation.cancelling ? "Cancelling" : "Esc cancel"} width={innerWidth} color={AMBER} />
			<Row text="^C cancel + exit" width={innerWidth} color={AMBER} />
		</Box>
	</Box>;
}

/** Center a bounded DOS confirmation, keeping safety copy above safe-default actions. @param props Draft and geometry. @returns Confirmation overlay. */
function Confirmation({ controller: c, geometry }: { controller: ConfigDraft; geometry: WorkbenchGeometry }): React.ReactElement {
	const confirmation = c.confirmation!;
	const choices = confirmationChoices(confirmation);
	const { dialog } = geometry;
	if (confirmation.type === "cost") {
		const bordered = dialog.inset > 0;
		const innerWidth = dialog.innerWidth;
		const panelHeight = dialog.height;
		const warningLines = (confirmation.warnings ?? []).flatMap(warning => {
			const text = /codex|read-only/i.test(warning) ? "Codex read-only; tools may remain." : fitWorkbenchText(warning, Number.MAX_SAFE_INTEGER);
			const lines: string[] = [];
			let line = "";
			for (const word of text.split(/\s+/)) {
				if (line && stringWidth(`${line} ${word}`) > innerWidth) { lines.push(fitWorkbenchText(line, innerWidth)); line = ""; }
				line = line ? `${line} ${word}` : word;
			}
			if (line) lines.push(fitWorkbenchText(line, innerWidth));
			return lines;
		});
		const footer = bordered ? 1 : 0;
		const warningBudget = Math.min(warningLines.length, Math.max(0, panelHeight - (bordered ? 2 : 0) - choices.length - 2 - footer));
		const routeBudget = Math.max(0, panelHeight - (bordered ? 2 : 0) - choices.length - 1 - warningBudget - footer);
		const routes = confirmation.routes ?? [];
		/** Wrap requested IDs by terminal cells without changing confirmed route data. @param route Exact route label. @returns Display lines. */
		const wrapRoute = (route: string): string[] => {
			const lines: string[] = []; let line = "", cells = 0;
			for (const char of fitWorkbenchText(route, Number.MAX_SAFE_INTEGER)) {
				const next = stringWidth(char);
				if (line && cells + next > innerWidth) { lines.push(line); line = ""; cells = 0; }
				line += char; cells += next;
			}
			if (line) lines.push(line);
			return lines;
		};
		const routeLines = routes.flatMap(wrapRoute);
		const viewport = workbenchWindow(routeLines.length, confirmation.index === 0 ? 0 : routeLines.length - 1, Math.max(1, routeBudget));
		return <Box position="absolute" marginLeft={dialog.left} marginTop={dialog.top} width={dialog.width} height={dialog.height} paddingX={Math.max(0, dialog.inset - 1)} flexDirection="column" borderStyle={bordered ? "double" : undefined} borderColor={workbenchColor(BORDER)} backgroundColor={workbenchColor(BLUE)} overflow="hidden">
				<Row text={innerWidth < 21 ? `Quota/cost: ${routes.length} call${routes.length === 1 ? "" : "s"}` : `Quota/cost: ${routes.length} call(s)`} width={innerWidth} color={AMBER} />
				<Box flexDirection="column" height={routeBudget} overflow="hidden">{routeBudget > 0 && routeLines.slice(viewport.start, viewport.end).map((route, index) => <Row key={index} text={route} width={innerWidth} color="white" />)}</Box>
				{warningLines.slice(0, warningBudget).map((warning, index) => <Row key={`warning:${index}`} text={warning} width={innerWidth} color="white" />)}
				{choices.map((choice, index) => <Row key={choice.action} text={`${index === confirmation.index ? "►" : " "} ${choice.label}`} width={innerWidth} color="white" active={index === confirmation.index} />)}
				{footer > 0 && <Row text="Arrows/Tab · Enter · Esc cancel" width={innerWidth} color={AMBER} />}
		</Box>;
	}
	const innerWidth = dialog.innerWidth;
	const compact = dialog.innerHeight < choices.length + 4;
	return <Box position="absolute" marginLeft={dialog.left} marginTop={dialog.top} width={dialog.width} height={dialog.height} paddingX={Math.max(0, dialog.inset - 1)} flexDirection="column" borderStyle={dialog.inset ? "double" : undefined} borderColor={workbenchColor(BORDER)} backgroundColor={workbenchColor(BLUE)} overflow="hidden">
			<Row text={confirmation.type === "reset" ? "Reset builtin prompt?" : confirmation.type === "save" ? "Save changes?" : "Exit configuration?"} width={innerWidth} color={AMBER} />
			{!compact && <>
				<Row text={confirmation.type === "reset" ? "Only prompt/stance reset; route and seating stay." : confirmation.type === "save" ? "Write this draft to the config file?" : confirmation.dirty ? "Draft has unsaved changes." : "No unsaved changes. File stays untouched."} width={innerWidth} color="white" />
				<Row text="" width={innerWidth} color="white" />
			</>}
			{choices.map((choice, index) => <Row key={choice.action} text={`${index === confirmation.index ? "►" : " "} ${choice.label}`} width={innerWidth} color="white" active={index === confirmation.index} />)}
			{!compact && <Row text="Arrows/Tab · Enter · Esc cancel" width={innerWidth} color={AMBER} />}
	</Box>;
}

/** Route keyboard events through the active dialog before workspace shortcuts. @param controller Draft. @param input Text key. @param key Ink key flags. @param size Frame for page movement. @param editing Field that owned input at render time; it consumes Enter even after closing itself. */
export function workbenchKey(controller: ConfigDraft, input: string, key: Key, size: WorkbenchSize, editing: DraftModal | undefined = controller.modal, accountEditing: { view: SdkAccountView; phase: string; prompt: unknown } | undefined = controller.account?.view ? { view: controller.account.view, phase: controller.account.view.phase, prompt: controller.account.view.prompt } : undefined): void {
	if (key.eventType === "release") return;
	if (key.ctrl && input === "c") { controller.interrupt(true); return; }
	if (accountEditing || controller.account?.view) {
		if (key.escape) { controller.account?.cancel(); return; }
		const view = controller.account?.view;
		if (!view || (accountEditing && (view !== accountEditing.view || view.phase !== accountEditing.phase || view.prompt !== accountEditing.prompt))) return;
		if (key.pageUp || key.pageDown) { controller.accountPage(key.pageUp ? -1 : 1, accountLayout(controller, workbenchGeometry(controller, size)).maxPage); return; }
		if (view.busy) return;
		if (accountEditing?.phase === "key" || accountEditing?.prompt || view.phase === "key") return;
		if (key.upArrow || key.leftArrow) controller.account?.move(-1);
		else if (key.downArrow || key.rightArrow || key.tab) controller.account?.move(key.shift ? -1 : 1);
		else if (key.return) controller.account?.enter();
		return;
	}
	if (controller.operation) { if (key.escape) controller.interrupt(); return; }
	if (key.escape) { controller.escape(); return; }
	if (key.tab) { controller.tab(key.shift); return; }
	if (controller.confirmation) {
		if (key.leftArrow || key.upArrow) controller.move(-1);
		else if (key.rightArrow || key.downArrow) controller.move(1);
		else if (key.home) controller.move("first");
		else if (key.end) controller.move("last");
		else if (key.return) controller.enter();
		return;
	}
	if (editing?.type === "text" || (editing && (key.leftArrow || key.rightArrow))) return;
	if (!editing && key.leftArrow) controller.horizontal("left");
	else if (!editing && key.rightArrow) controller.horizontal("right");
	else if (!editing && !key.ctrl && /^[1-8]$/.test(input)) controller.jump(SECTIONS[Number(input) - 1]);
	else if (key.upArrow) controller.move(-1);
	else if (key.downArrow) controller.move(1);
	else if (key.home) controller.move("first");
	else if (key.end) controller.move("last");
	else if (key.pageUp) controller.move(-workbenchGeometry(controller, size).pageItems);
	else if (key.pageDown) controller.move(workbenchGeometry(controller, size).pageItems);
	else if (key.return && !editing) controller.enter();
}

/** Attach keyboard, resize, and exit lifecycle to view. @param props Controller. @returns Live workbench. */
function Workbench({ controller }: { controller: ConfigDraft }): React.ReactElement {
	const { stdout } = useStdout();
	const { exit } = useApp();
	const [, rerender] = useState(0);
	const stream = stdout as NodeJS.WriteStream;
	const [size, setSize] = useState<WorkbenchSize>({ columns: stream.columns ?? 80, rows: stream.rows ?? 24 });
	useEffect(() => {
		/** Repaint after each draft event and finish Ink only after result exists. */
		const update = (): void => { rerender(value => value + 1); if (controller.result) exit(); };
		const unsubscribe = controller.subscribe(update);
		/** Use same output stream for layout and resize notifications. */
		const resize = (): void => setSize({ columns: stream.columns ?? 80, rows: stream.rows ?? 24 });
		stream.on("resize", resize); update();
		return () => { unsubscribe(); stream.off("resize", resize); controller.cancel(); };
	}, [controller, exit, stream]);
	const editing = controller.modal;
	const accountEditing = controller.account?.view ? { view: controller.account.view, phase: controller.account.view.phase, prompt: controller.account.view.prompt } : undefined;
	useInput((input, key) => workbenchKey(controller, input, key, size, editing, accountEditing));
	return <WorkbenchView controller={controller} size={size} />;
}

/** Run standalone workbench on stderr; raw mode precedes first visible frame.
 * @param available Detected backends, not auth assertions. @param existing Exact file config. @param options Path/scope trust. @param discovery Bounded async catalogs. @param sdkService Optional opaque direct provider boundary.
 * @returns Explicit saved draft, discard, or interrupted status. No file writes.
 */
export async function runConfigWorkbench(available: AvailableBackend[], existing: BpxCouncilConfig | undefined, options: EditorOptions, discovery: DraftDiscovery, sdkService?: SdkProviderService): Promise<WorkbenchResult> {
	if (!process.stdin.isTTY || !process.stderr.isTTY) throw new Error("Config workbench needs TTY stdin and stderr.");
	const controller = new ConfigDraft(existing, options, available, discovery, undefined, undefined, sdkService);
	const previousRaw = process.stdin.isRaw;
	let app: ReturnType<typeof render> | undefined;
	/** Catch Ctrl-C even before Ink's input effect mounts. @param data Raw terminal bytes. */
	const earlyInterrupt = (data: Buffer | string): void => { if (data.toString().includes("\x03")) { controller.interrupt(true); if (controller.result) app?.unmount(); } };
	try {
		process.stdin.setRawMode(true);
		process.stdin.on("data", earlyInterrupt);
		app = render(<Workbench controller={controller} />, { stdout: process.stderr, stdin: process.stdin, exitOnCtrlC: false, patchConsole: false });
		await app.waitUntilExit();
		return controller.result ?? { config: null, code: 0 };
	} finally {
		controller.cancel(); app?.unmount(); process.stdin.off("data", earlyInterrupt);
		process.stdin.setRawMode(previousRaw ?? false);
		// index.ts calls process.exit: keep cancellation escalation and temp cleanup alive.
		await controller.settle();
	}
}
