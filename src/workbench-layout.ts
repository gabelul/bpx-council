import { configRoute } from "./config-editor.js";
import { SECTIONS, confirmationChoices, draftFields, modalChoices, type ConfigDraft } from "./config-draft.js";

/** Terminal size measured from Ink's actual output stream. */
export interface WorkbenchSize { columns: number; rows: number }
/** Cell rectangle relative to terminal surround; inner dimensions exclude frame/padding. */
export interface WorkbenchFrame { width: number; height: number; left: number; top: number; inset: number; innerWidth: number; innerHeight: number }
/** Shared render/key budgets. Counts describe visible selectable items, not terminal rows. */
export interface WorkbenchGeometry { width: number; height: number; main: WorkbenchFrame; dialog: WorkbenchFrame; narrow: boolean; tiny: boolean; contentHeight: number; sideWidth: number; detailWidth: number; modalItems: number; detailItems: number; pageItems: number }

/** Center a bounded DOS frame, dropping padding and borders before content.
 * @param width Available columns. @param height Available rows. @param capWidth Preferred width. @param capHeight Preferred height.
 * @returns Centered frame and inner cell bounds.
 */
export function workbenchFrame(width: number, height: number, capWidth: number, capHeight: number): WorkbenchFrame {
	const w = Math.max(1, Math.min(width, capWidth));
	const h = Math.max(1, Math.min(height, capHeight));
	const inset = w >= 28 && h >= 10 ? 2 : w >= 28 && h >= 8 ? 1 : 0;
	return { width: w, height: h, left: Math.floor((width - w) / 2), top: Math.floor((height - h) / 2), inset, innerWidth: Math.max(1, w - inset * 2), innerHeight: Math.max(1, h - (inset ? 2 : 0)) };
}

/** Calculate the exact list budgets used by rendering and PageUp/PageDown.
 * @param c Current draft state; never mutated. @param size Output-stream cell dimensions.
 * @returns Bounded shell/dialog geometry and selectable row counts.
 */
export function workbenchGeometry(c: ConfigDraft, size: WorkbenchSize): WorkbenchGeometry {
	const width = Math.max(1, size.columns), height = Math.max(1, size.rows - 1);
	const compact = height < 10 || width < 24;
	const detailRows = c.screen.type === "preview" ? (c.candidate?.value.systemPrompt.split("\n").length ?? 0) + c.fields.length + 2
		: c.screen.type === "results" || c.screen.type === "backend-detail" ? c.fields.length + 2
			: c.section === "Review" ? 6 + (["Gut-check", "Council", "Debate"] as const).reduce((count, section) => count + draftFields(c.draft, section).filter(field => field.kind === "backend").length, 0)
				: c.section === "Discard" ? 3 : c.fields.length;
	const preferredHeight = Math.min(32, Math.max(SECTIONS.length, detailRows) + (compact ? 3 : 7));
	const main = workbenchFrame(width, height, 112, preferredHeight);
	const tiny = main.height < 10 || main.width < 24;
	const narrow = main.width < 62;
	const contentHeight = Math.max(1, main.innerHeight - (tiny ? 3 : 5));
	const sideWidth = narrow ? main.innerWidth : 20;
	const detailWidth = narrow ? main.innerWidth : Math.max(1, main.innerWidth - 23);
	let dialog = workbenchFrame(width, height, 80, 22);
	let modalItems = Math.max(1, dialog.innerHeight - 4);
	if (c.account?.view) {
		const view = c.account.view;
		const rows = view.busy || view.phase === "login" ? 18 : view.phase === "methods" ? 10 + c.account.choices.length : view.phase === "receipt" ? 12 : 10;
		dialog = workbenchFrame(width, height, 80, rows);
	} else if (c.modal) {
		const extra = c.modal.field.target && configRoute(c.draft, c.modal.field.target)?.command === "pi" ? 1 : 0;
		const lines = c.multiline ? 16 : c.modal.type === "choices" ? Math.min(16, Math.max(1, modalChoices(c.modal).length)) : 1;
		dialog = workbenchFrame(width, height, 80, Math.max(10, lines + 6 + extra));
		modalItems = Math.max(1, dialog.innerHeight - 4 - extra);
	} else if (c.operation) {
		// Discovery can replace the local inventory mid-run; reserve one fixed local window.
		const preferredHeight = c.operation.type === "local-check" ? 24 : Math.max(12, Math.min(24, c.operation.total + 10));
		dialog = workbenchFrame(width, height, 80, preferredHeight);
	} else if (c.confirmation) {
		const choices = confirmationChoices(c.confirmation).length;
		const cost = c.confirmation.type === "cost";
		const desired = cost ? Math.max(10, Math.min(22, (c.confirmation.routes?.length ?? 0) + (c.confirmation.warnings?.length ?? 0) * 2 + choices + 6)) : choices + 6;
		dialog = workbenchFrame(width, height, cost ? 64 : 56, desired);
	}
	const detailItems = c.screen.type === "preview" ? Math.max(1, Math.min(c.fields.length, contentHeight < 5 ? contentHeight : contentHeight - 2))
		: c.screen.type === "backend-detail" || c.screen.type === "results" ? Math.max(1, contentHeight - Math.min(2, Math.max(0, contentHeight - 1))) : contentHeight;
	const count = c.modal ? modalChoices(c.modal).length : c.pane === "sidebar" ? SECTIONS.length : c.section === "Review" ? (c.error ? 1 : 2) : c.section === "Discard" ? 2 : c.fields.length;
	const pageItems = Math.max(1, Math.min(count, c.modal ? modalItems : c.pane === "sidebar" ? contentHeight : detailItems));
	return { width, height, main, dialog, narrow, tiny, contentHeight, sideWidth, detailWidth, modalItems, detailItems, pageItems };
}
