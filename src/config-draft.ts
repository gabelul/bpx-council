import { MODES } from "./args.js";
import type { SdkProviderService, SdkProviderSummary } from "./sdk-types.js";
import { SdkAccountController } from "./sdk-account-controller.js";
import type { BpxCouncilConfig } from "./config.js";
import { backendLabel, backendName, changeConfigRoute, configRoute, type EditorOptions, type RouteTarget } from "./config-editor.js";
import { validateConfig } from "./config-validation.js";
import type { AvailableBackend } from "./detect.js";
import { DEFAULT_PERSONAS, type Persona } from "./personas.js";
import { acceptPersona, personaError, personaLibrary, resetBuiltinPersona, seatedPersonas, togglePersonaSeat } from "./config-personas.js";
import { defaultConfigActions, type ActionPreflight, type ConfigActions, type RouteTestResult } from "./config-actions.js";
import { defaultBackendDiagnostics, type BackendDiagnostic, type BackendDiagnostics } from "./backend-diagnostics.js";

export const SECTIONS = ["Advisor", "Gut-check", "Council", "Debate", "Backends", "Preferences", "Review", "Discard"] as const;
export type Section = typeof SECTIONS[number];
export type FieldKind = "backend" | "model" | "effort" | "mode" | "tokens" | "action" | "name" | "stance" | "prompt" | "focus";
export type DraftAction = "route" | "persona" | "library" | "add" | "manual" | "ai" | "seat" | "edit-persona" | "reset-persona" | "preview" | "accept" | "candidate-edit" | "generator" | "generate" | "test" | "test-all" | "backend-detail" | "check-backends" | "configure-advisor" | "direct-providers" | "installed-clis" | "sdk-account" | "share-pi" | "back";
/** Editable or actionable row; identities never share persona-name namespaces. */
export interface DraftField { id: string; label: string; value: string; kind: FieldKind; target?: RouteTarget; action?: DraftAction; name?: string }
/** Nested workspaces, not implicit combinations of flat fields. */
export type DraftScreen = { type: "root" } | { type: "route"; target: RouteTarget } | { type: "library" } | { type: "persona"; name: string } | { type: "add" } | { type: "candidate" } | { type: "preview" } | { type: "ai" } | { type: "generator" } | { type: "results" } | { type: "backend-detail"; name: string } | { type: "direct-providers" } | { type: "installed-clis" };
/** Session-local test outcome tied to one effective route. */
export interface DraftTestResult { target: RouteTarget; fingerprint: string; result: RouteTestResult; pending?: boolean; blocked?: boolean }
/** Pending paid call; abort stays attached until cleanup settles. */
export interface DraftOperation { type: "test" | "generate" | "local-check"; abort: AbortController; cancelling: boolean; completed: number; total: number; current?: string; rows?: { label: string; status: string }[] }
/** Staged persona, independent of saved draft and generator route. */
export interface DraftCandidate { value: Persona; editingName?: string; generated?: boolean; seat: boolean }
/** Dropdown item; undefined retains exact current value. */
export interface DraftChoice { label: string; value?: string | null; manual?: boolean; backend?: string; accentText?: string; setup?: boolean }
/** Edit dialog state; text belongs to Ink's caret-aware input. */
export interface DraftModal { field: DraftField; type: "choices" | "text"; text: string; index: number; choices: DraftChoice[]; loading: boolean; notice: string }
/** Selectable presets or bounded catalogs, never an advisor call or authentication check. */
export interface DraftDiscovery {
	listModels(name: string, signal?: AbortSignal): Promise<string[]>;
	listEfforts(name: string, model?: string, signal?: AbortSignal): Promise<{ levels: string[]; def?: string } | null>;
}
export type WorkbenchResult = { config: BpxCouncilConfig | null; code: number };
/** Confirmation overlays leave workspace focus and draft untouched. */
export interface DraftConfirmation { type: "save" | "exit" | "cost" | "reset"; dirty: boolean; index: number; routes?: string[]; warnings?: string[]; request?: { type: "test" | "generate"; draft: BpxCouncilConfig; targets: RouteTarget[]; focus?: string; blocked?: DraftTestResult[]; order?: RouteTarget[]; fingerprints?: Record<string, string>; sdkAccountRevisions?: Readonly<Record<string, string>> }; name?: string }
/** Confirmation button with explicit result intent. */
export interface ConfirmationChoice { label: string; action: "cancel" | "save" | "discard" | "run" | "reset" }

/** List safe-default buttons. @param confirmation Open dialog. @returns Ordered choices. */
export function confirmationChoices(confirmation: DraftConfirmation): ConfirmationChoice[] {
	if (confirmation.type === "cost") return [{ label: "Cancel", action: "cancel" }, { label: `Run ${confirmation.routes?.length ?? 1} call(s)`, action: "run" }];
	if (confirmation.type === "reset") return [{ label: "Cancel", action: "cancel" }, { label: "Reset builtin prompt", action: "reset" }];
	return confirmation.type === "save" ? [{ label: "Cancel", action: "cancel" }, { label: "Save", action: "save" }]
		: [{ label: "Keep editing", action: "cancel" }, ...(confirmation.dirty ? [{ label: "Save & exit", action: "save" as const }] : []), { label: confirmation.dirty ? "Discard & exit" : "Exit", action: "discard" }];
}

/** Build detail rows without creating absent config keys.
 * @param draft Exact stored draft. @param section Active section. @returns Editable rows, including real Council members.
 */
export function draftFields(draft: BpxCouncilConfig, section: Section): DraftField[] {
	if (section === "Preferences") return [{ id: "mode", label: "Default mode", value: draft.defaultMode ?? "solo (default)", kind: "mode" }];
	const targets: RouteTarget[] = section === "Advisor" ? [{ section: "advisor", role: "Advisor" }]
		: section === "Gut-check" ? [{ section: "gut-check", role: "Gut-check" }]
		: section === "Council" ? [...(draft.council?.members ?? DEFAULT_PERSONAS.map(p => p.name)).map(role => ({ section: "council" as const, role, member: true })), { section: "council", role: "Verdict" }]
		: section === "Debate" ? ["advocate", "critic", "synthesizer"].map(role => ({ section: "debate" as const, role })) : [];
	const fields: DraftField[] = targets.flatMap(target => {
		const route = configRoute(draft, target);
		const inherited = target.section !== "advisor" && !route;
		const effective = route ?? (inherited ? draft.solo?.backend : undefined);
		const legacy = target.section === "advisor" ? draft.solo?.thinkingLevel : undefined;
		const prefix = !target.member && target.role === "synthesizer" ? "Verdict" : target.role;
		return (["backend", "model", "effort"] as const).map(kind => ({
			id: JSON.stringify([target.section, target.member ?? false, target.role, kind]), target, kind,
			label: `${target.section === "advisor" || target.section === "gut-check" ? "" : `${prefix} / `}${kind === "effort" ? "Effort" : kind === "model" ? "Model" : "Backend"}`,
			value: kind === "backend" ? (inherited ? `Inherit Advisor → ${backendLabel(effective)}` : backendLabel(route))
				: kind === "model" ? (inherited ? `Advisor → ${effective?.model ?? "backend default"}` : route?.model ?? "Backend default")
					: inherited ? `Advisor → ${effective?.effort ?? draft.solo?.thinkingLevel ?? "backend default"}` : route?.effort ?? (legacy ? `${legacy} (legacy fallback)` : "Backend default"),
		}));
	});
	if (section === "Gut-check") fields.push({ id: "tokens", label: "Output tokens (HTTP limit; CLI request)", value: String(draft.gutCheck?.maxOutputTokens ?? "Default"), kind: "tokens" });
	return fields;
}

/** Filter catalog while retaining default/current/manual escape routes.
 * @param modal Dialog state. @returns Visible choices.
 */
export function modalChoices(modal: DraftModal): DraftChoice[] {
	const query = modal.text.trim().toLowerCase();
	if (!query) return modal.choices;
	const matches = modal.choices.filter(choice => !choice.manual && choice.label.toLowerCase().includes(query));
	const utilities = modal.choices.filter(choice => (choice.value == null || choice.manual) && !matches.includes(choice));
	// An unmatched search must not make Enter silently reset a stored route.
	if (!matches.length) utilities.sort((left, right) => Number(Boolean(right.manual)) - Number(Boolean(left.manual)));
	return [...matches, ...utilities];
}

/** Draft controller shared by UI/tests. No config-file reads or writes; presence inventory is local-only. */
export class ConfigDraft {
	draft: BpxCouncilConfig;
	section: Section = "Advisor";
	pane: "sidebar" | "detail" = "sidebar";
	focus: Partial<Record<Section, number>> = {};
	modal?: DraftModal;
	confirmation?: DraftConfirmation;
	error = "";
	result?: WorkbenchResult;
	screen: DraftScreen = { type: "root" };
	candidate?: DraftCandidate;
	generationFocus = "";
	generatorTarget: RouteTarget = { section: "advisor", role: "Advisor" };
	operation?: DraftOperation;
	testResults: DraftTestResult[] = [];
	backendDiagnostics: BackendDiagnostic[] = [];
	sdkProviders: SdkProviderSummary[] = [];
	account?: SdkAccountController;
	private pickerReturn?: { modal: DraftModal; screen: DraftScreen; stack: { screen: DraftScreen; index: number }[]; index: number; pane: "sidebar" | "detail" };
	#sdkService?: SdkProviderService;
	private stack: { screen: DraftScreen; index: number }[] = [];
	private nestedIndex = 0;
	private exitAfterOperation = false;
	private readonly original: string;
	private abort?: AbortController;
	private pending = new Set<Promise<void>>();
	private editingSection: Section = "Advisor";
	private listeners = new Set<() => void>();

	/** Clone input and inspect local presence only. @param existing File config. @param options Target trust context. @param available Prior detected routes. @param discovery Bounded catalogs. @param actions Confirmed paid actions. @param diagnostics Local presence/version service. @param sdkService Optional direct provider boundary, untouched until explicit operation. */
	constructor(existing: BpxCouncilConfig | undefined, readonly options: EditorOptions, readonly available: AvailableBackend[], private readonly discovery: DraftDiscovery, private readonly actions: ConfigActions = defaultConfigActions, private readonly diagnostics: BackendDiagnostics = defaultBackendDiagnostics, sdkService?: SdkProviderService) {
		this.#sdkService = sdkService;
		this.draft = structuredClone(existing ?? {}) as BpxCouncilConfig;
		this.original = JSON.stringify(this.draft);
		this.refreshInventory();
	}
	/** Construct provider boundary only for explicit account/picker operations. @returns Safe provider service. */
	private async sdk(): Promise<SdkProviderService> {
		if (!this.#sdkService) this.#sdkService = (await import("./sdk-provider-service.js")).getSdkProviderService();
		if (!this.account) this.account = new SdkAccountController(this.#sdkService!, () => {
			this.sdkProviders = this.#sdkService!.inventory(); this.changed();
		}, () => { if (this.pickerReturn) this.restorePicker(); });
		return this.#sdkService!;
	}
	/** Open account inventory without selecting routes or saving config. */
	private openProviders(): void {
		if (this.options.project) { this.error = "Direct provider accounts belong to Global settings. Project settings cannot log in, store keys or remove accounts."; return; }
		this.push({ type: "direct-providers" });
		const screen = this.screen;
		/** Load local safe metadata; stale navigation cannot change current workspace. */
		const load = async (): Promise<void> => {
			try { const service = await this.sdk(); if (this.screen === screen && !this.result) { this.sdkProviders = service.inventory(); this.changed(); } }
			catch { if (this.screen === screen) { this.error = "Direct providers unavailable. Return to editing; no account changed."; this.changed(); } }
		};
		const job = load(); this.pending.add(job); void job.then(() => this.pending.delete(job), () => this.pending.delete(job));
	}
	/** Restore exact originating seat/search/highlight, refreshing only configured provider choices. */
	private restorePicker(): void {
		const saved = this.pickerReturn; if (!saved) return;
		this.pickerReturn = undefined; this.screen = saved.screen; this.stack = saved.stack; this.nestedIndex = saved.index; this.pane = saved.pane; this.modal = saved.modal;
		if (this.screen.type === "root") this.focus[this.section] = saved.index;
		const job = this.loadPickerProviders(saved.modal); this.pending.add(job); void job.then(() => this.pending.delete(job), () => this.pending.delete(job)); this.changed();
	}
	/** Append configured Council accounts and explicit setup affordance. @param modal Exact picker identity. */
	private async loadPickerProviders(modal: DraftModal): Promise<void> {
		if (!this.#sdkService) { if (this.modal === modal && !modal.choices.some(choice => choice.setup)) modal.choices.push({ label: "Add direct provider…", setup: true }); return; }
		try {
			const service = await this.sdk(); if (this.modal !== modal || this.result) return;
			this.sdkProviders = service.inventory(); const highlighted = modalChoices(modal)[modal.index];
			modal.choices = modal.choices.filter(choice => !choice.setup && !(choice.value?.startsWith("sdk:")));
			modal.choices.push(...this.sdkProviders.filter(provider => provider.account.state === "stored").map(provider => ({ label: `Direct: ${provider.label} (account stored; not tested)`, value: `sdk:${provider.id}`, backend: `sdk:${provider.id}`, accentText: `Direct: ${provider.label}` })), { label: "Add direct provider…", setup: true });
			modal.index = Math.max(0, modalChoices(modal).findIndex(choice => choice === highlighted || (highlighted?.setup && choice.setup) || (highlighted?.value !== undefined && choice.value === highlighted.value))); this.changed();
		} catch { if (this.modal === modal) { modal.notice = "Direct providers unavailable; existing routes retained."; this.changed(); } }
	}
	/** Saved CLI names across seats, including manual paths; never executed by inventory.
	 * @returns Unique configured CLI identities.
	 */
	private diagnosticNames(): string[] {
		return [...new Set((["Advisor", "Gut-check", "Council", "Debate"] as const).flatMap(section => draftFields(this.draft, section).filter(field => field.kind === "backend").map(field => configRoute(this.draft, field.target!)).filter(route => route && route.type === "cli").map(route => route!.command!)))];
	}
	/** Refresh presence while retaining version receipts for unchanged executable identities. */
	private refreshInventory(): void {
		this.backendDiagnostics = this.diagnostics.inventory(this.diagnosticNames()).map(row => {
			const previous = this.backendDiagnostics.find(old => old.name === row.name && old.path === row.path && old.status === row.status);
			return previous ? { ...row, check: previous.check, version: previous.version, detail: previous.detail ?? row.detail } : row;
		});
	}
	/** Installed usable CLI rows, plus Anthropic with explicit key status. @returns Picker inventory. */
	get actualInstalled(): BackendDiagnostic[] { return this.backendDiagnostics.filter(row => (row.status === "installed" && row.check !== "failed") || row.kind === "http"); }
	/** Local state label, deliberately separate from connection receipts. @param row Inventory row. @returns Presence summary. */
	backendStatus(row: BackendDiagnostic): string {
		return ({ installed: "Installed", missing: "Missing", unusable: "Unusable", "key-present": "Key present", "key-missing": "Key missing" })[row.status];
	}
	/** Version outcome never implies login or model success. @param row Inventory row. @returns Version/check label. */
	backendVersion(row: BackendDiagnostic): string {
		return row.check === "version-found" ? row.version ?? "found" : ({ "not-checked": "not checked", checking: "checking", "version-unavailable": "version unavailable (warning)", failed: "check failed", unsupported: "not supported", cancelled: "not checked (cancelled)", "not-applicable": "not applicable" })[row.check as Exclude<BackendDiagnostic["check"], "version-found">];
	}
	/** Match only explicit configured Advisor route, never an ambient guessed backend. @param name Backend identity. @returns Whether detail can offer its exact Advisor test. */
	advisorMatches(name: string): boolean { return Boolean(this.draft.solo?.backend && backendName(this.draft.solo.backend) === name); }
	/** Retrieve current-route receipt only; backend-wide success is never inferred. @param target Exact seat. @returns Current receipt, if any. */
	connectionReceipt(target: RouteTarget): DraftTestResult | undefined { return this.testResults.find(item => JSON.stringify(item.target) === JSON.stringify(target) && item.fingerprint === this.routeFingerprint(target)); }
	/** Label call outcomes without treating preflight refusal/cancellation as provider failure. @param item Route receipt. @returns UI status. */
	testStatus(item: DraftTestResult): string {
		if (item.pending) return "Queued";
		if (item.blocked) return item.result.error?.startsWith("Not available:") ? "Not available" : "Not supported";
		if (item.result.error?.startsWith("Not called;")) return "Not called";
		if (item.result.cancelled) return "Cancelled";
		return item.result.ok ? "Response received" : "Test failed";
	}
	/** Explicit local version check with tracked cancellation and cleanup; draft and catalogs untouched. */
	private startBackendCheck(): void {
		if (this.operation) return;
		const operation: DraftOperation = { type: "local-check", abort: new AbortController(), cancelling: false, completed: 0, total: 0 };
		this.operation = operation;
		/** Accept immutable service snapshots and render only app-owned statuses. @param rows Local diagnostics. */
		const update = (rows: BackendDiagnostic[], initializing = false): void => {
			if (this.operation !== operation || operation.abort.signal.aborted) return;
			if (!initializing) this.backendDiagnostics = structuredClone(rows);
			const candidates = rows.filter(row => row.kind === "cli" && ["installed", "unusable"].includes(row.status));
			operation.total = candidates.length;
			operation.completed = candidates.filter(row => !["not-checked", "checking"].includes(row.check)).length;
			const current = candidates.find(row => row.check === "checking") ?? candidates.find(row => row.check === "not-checked");
			/** Hide arbitrary executable paths; identity is not subprocess output. @param row Candidate. @returns Safe CLI name. */
			const label = (row: BackendDiagnostic): string => /^[a-z][a-z0-9-]{0,31}$/.test(row.name) ? row.name : "Manual CLI";
			operation.current = current ? label(current) : "Complete";
			operation.rows = candidates.map(row => ({ label: label(row), status: row.check === "version-found" ? "Version found" : row.check === "version-unavailable" ? "Version unavailable (warning)" : row.check === "failed" ? "Check failed" : row.check === "unsupported" ? "Unsupported; not called" : row.check === "cancelled" ? "Cancelled" : row.check === "checking" ? "Checking" : "Waiting" }));
			this.changed();
		};
		update(this.backendDiagnostics.map(row => row.kind === "cli" ? { ...row, check: "not-checked" } : row), true);
		/** Keep process teardown tracked until service settles. @returns Cleanup completion. */
		const run = async (): Promise<void> => {
			try {
				const rows = await this.diagnostics.check(operation.abort.signal, update, this.diagnosticNames());
				this.backendDiagnostics = structuredClone(rows);
				const cleanupUnconfirmed = rows.some(row => row.check === "failed" && row.detail?.includes("cleanup"));
				this.error = operation.abort.signal.aborted ? cleanupUnconfirmed ? "Local check cancelled; cleanup could not be confirmed." : "Local check cancelled; cleanup complete." : "";
			} catch { this.error = operation.abort.signal.aborted ? "Local check cancelled; cleanup could not be confirmed." : "Local check failed. Retry Check installed CLIs; no connection call made."; }
			finally {
				this.operation = undefined;
				if (this.exitAfterOperation) { this.exitAfterOperation = false; this.finish(null, 130); }
				this.changed();
			}
		};
		const job = run(); this.pending.add(job);
		void job.then(() => this.pending.delete(job), () => this.pending.delete(job));
	}
	/** Whether explicit edits differ from file. @returns Dirty state. */
	get dirty(): boolean { return JSON.stringify(this.draft) !== this.original; }
	/** Current editable rows. @returns Rows. */
	get fields(): DraftField[] { return this.screenFields(); }
	/** Remembered row for current path. @returns Row index. */
	get index(): number { return Math.min(this.screen.type === "root" ? this.focus[this.section] ?? 0 : this.nestedIndex, Math.max(0, this.fields.length - 1)); }
	/** Current path, independent of focused row. @returns Breadcrumb label. */
	get breadcrumb(): string {
		/** Name one breadcrumb segment without repeating seat identity. @param screen Path segment. @returns Human label. */
		const label = (screen: DraftScreen): string => screen.type === "route" ? (screen.target.member ? screen.target.role : screen.target.role === "synthesizer" ? "Verdict" : screen.target.role) : screen.type === "backend-detail" ? screen.name : screen.type === "persona" ? (this.stack.some(item => item.screen.type === "route" && item.screen.target.role === screen.name) ? "Persona" : screen.name) : ({ root: "", library: "Manage seating", add: "Add persona", candidate: "Edit candidate", preview: "Preview", ai: "AI persona", generator: "Generator route", results: "Test results", "direct-providers": "Direct providers", "installed-clis": "Installed CLIs" })[screen.type];
		return [this.section, ...this.stack.map(item => label(item.screen)), label(this.screen)].filter(Boolean).join(" > ");
	}
	/** Whether current modal edits multiline content. @returns Multiline input ownership. */
	get multiline(): boolean { return this.modal?.type === "text" && ["prompt", "focus"].includes(this.modal.field.kind); }
	/** Build contextual rows without writing runtime defaults. @returns Current screen rows. */
	private screenFields(): DraftField[] {
		/** Build collision-proof action identity. @param intent Command. @param label Row name. @param value Summary. @param target Route seat. @param name Persona identity. @returns Action row. */
		const action = (intent: DraftAction, label: string, value = "", target?: RouteTarget, name?: string): DraftField => ({ id: JSON.stringify(["action", intent, target, name]), kind: "action", action: intent, label, value, target, name });
		/** Describe effective configured route without normalizing config. @param target Seat. @returns Inheritance-aware label. */
		const summary = (target: RouteTarget): string => {
			const route = configRoute(this.draft, target);
			return `${!route && target.section !== "advisor" ? "Advisor → " : ""}${backendLabel(route ?? this.draft.solo?.backend)}`;
		};
		const screen = this.screen;
		if (screen.type === "direct-providers") return [...this.sdkProviders.map(provider => action("sdk-account", provider.label, `Account: ${provider.account.state}; no connection test`, undefined, provider.id)), action("share-pi", "Share pi logins", `${this.draft.sharePiAuth === true ? "on" : "off"} — ~/.pi/agent/auth.json; logins, removals and quota shared with pi`, undefined), action("back", "Back")];
		if (screen.type === "installed-clis") return [action("check-backends", "Check installed CLIs", "Local versions; no model calls"), ...this.backendDiagnostics.filter(row => row.kind === "cli").map(row => action("backend-detail", row.name, `${this.backendStatus(row)} · v: ${this.backendVersion(row)}`, undefined, row.name)), action("back", "Back")];
		if (screen.type === "backend-detail") {
			const row = this.backendDiagnostics.find(item => item.name === screen.name);
			const available = row && ["installed", "key-present"].includes(row.status);
			return [action("check-backends", "Check installed CLIs", "Local versions only"), ...(available && this.advisorMatches(screen.name) ? [action("test", "Test Advisor connection", summary({ section: "advisor", role: "Advisor" }), { section: "advisor", role: "Advisor" })] : [action("configure-advisor", "Configure Advisor", available ? "No matching configured Advisor" : "Not available; configure usable route")]), action("back", "Back")];
		}
		if (screen.type === "root") {
			if (this.section === "Backends") return [action("direct-providers", "Direct providers", this.options.project ? "Accounts managed in Global settings" : "Council accounts; not CLI logins"), action("installed-clis", "Installed CLIs", "Executable inventory and local versions"), action("check-backends", "Check installed CLIs", "Local versions; no model calls"), this.draft.solo?.backend ? action("test", "Test Advisor connection", summary({ section: "advisor", role: "Advisor" }), { section: "advisor", role: "Advisor" }) : action("configure-advisor", "Configure Advisor", "No configured Advisor route"), ...this.backendDiagnostics.filter(row => row.kind === "http").map(row => action("backend-detail", row.name, `${this.backendStatus(row)} · legacy HTTP`, undefined, row.name))];
			if (this.section === "Council") return [
				...seatedPersonas(this.draft).map(name => { const target: RouteTarget = { section: "council", role: name, member: true }; return action("route", name, `${personaLibrary(this.draft).find(p => p.name === name)?.stance ?? "definition missing"} · ${summary(target)}`, target); }),
				action("route", "Verdict", summary({ section: "council", role: "Verdict" }), { section: "council", role: "Verdict" }),
				action("library", "Manage seating"), ...(!this.options.project ? [action("add", "Add persona")] : []), action("test-all", "Test all members", `${seatedPersonas(this.draft).length} seats`),
			];
			if (this.section === "Debate") return ["advocate", "critic", "synthesizer"].map(role => { const target: RouteTarget = { section: "debate", role }; return action("route", role === "synthesizer" ? "Verdict" : role, summary(target), target); });
			const rows = draftFields(this.draft, this.section);
			if (this.section === "Advisor" || this.section === "Gut-check") rows.push(action("test", "Test this route", "Explicit quota/cost confirmation", { section: this.section === "Advisor" ? "advisor" : "gut-check", role: this.section }));
			return rows;
		}
		if (screen.type === "route") {
			const section = screen.target.section === "council" ? "Council" : "Debate";
			return [...draftFields(this.draft, section).filter(field => field.target?.role === screen.target.role && Boolean(field.target.member) === Boolean(screen.target.member)).map(field => ({ ...field, label: field.kind === "backend" ? "Backend" : field.kind === "model" ? "Model" : "Effort" })),
				...(screen.target.member ? [action("persona", "Persona", "Prompt, stance and seating", undefined, screen.target.role)] : []), action("test", "Test this route", "Explicit quota/cost confirmation", screen.target)];
		}
		if (screen.type === "library") return personaLibrary(this.draft).filter(p => !this.options.project || DEFAULT_PERSONAS.some(b => b.name === p.name)).map(p => action("persona", p.name, `${seatedPersonas(this.draft).includes(p.name) ? "seated" : "library"} · ${p.stance}${Object.hasOwn(this.draft.personas ?? {}, p.name) ? " · custom" : " · bundled"}`, undefined, p.name));
		if (screen.type === "persona") return [action("seat", seatedPersonas(this.draft).includes(screen.name) ? "Unseat persona" : "Seat persona", "Route and prompt retained", undefined, screen.name), ...(!this.options.project ? [action("edit-persona", "Edit prompt / stance", "Bundled edits become explicit overrides", undefined, screen.name), ...(DEFAULT_PERSONAS.some(p => p.name === screen.name) && Object.hasOwn(this.draft.personas ?? {}, screen.name) ? [action("reset-persona", "Reset builtin prompt", "Route and seating retained", undefined, screen.name)] : [])] : [])];
		if (screen.type === "add") return [action("manual", "Manual persona"), action("ai", "AI-assisted persona", "Paid call only after confirmation")];
		if (screen.type === "candidate") {
			const value = this.candidate!.value;
			return [{ id: "candidate:name", kind: "name", label: "Name", value: value.name }, { id: "candidate:stance", kind: "stance", label: "Stance (bias, not verdict)", value: value.stance }, { id: "candidate:prompt", kind: "prompt", label: "System prompt", value: `${value.systemPrompt.length} characters` }, action("preview", "Preview candidate")];
		}
		if (screen.type === "preview") return [action("candidate-edit", "Edit candidate"), ...(this.candidate?.generated ? [action("generate", "Regenerate", summary(this.generatorTarget), this.generatorTarget)] : []), action("accept", this.candidate?.editingName ? "Accept explicit edit" : "Accept into draft", this.candidate?.editingName ? "No rename, no save" : this.candidate?.seat && seatedPersonas(this.draft).length < 8 ? "Seat with inherited Advisor route; no save" : "Keep in library; no save")];
		if (screen.type === "ai") return [{ id: "generation:focus", kind: "focus", label: "Describe focus", value: this.generationFocus || "Not set" }, action("generator", "Generator route", summary(this.generatorTarget)), action("generate", "Generate candidate", "Explicit quota/cost confirmation", this.generatorTarget)];
		if (screen.type === "generator") return this.generatorRoutes.map(target => action("route", `${target.section === "advisor" ? "Advisor" : target.section === "council" ? "Council" : "Debate"}${target.section === "advisor" ? "" : ` / ${target.member ? target.role : target.role === "synthesizer" ? "Verdict" : target.role}`}`, summary(target), target));
		return [...this.testResults.map((item, index) => ({ id: `result:${index}`, kind: "action" as const, label: `${item.target.section} / ${item.target.role}`, value: `${this.testStatus(item)} · ${item.result.elapsedMs}ms · ${item.result.route}` })), action("back", "Back to editing")];
	}
	/** Available generator routes, distinct from new persona's inherited route. @returns Explicit labelled targets. */
	get generatorRoutes(): RouteTarget[] { return [{ section: "advisor", role: "Advisor" }, ...seatedPersonas(this.draft).map(role => ({ section: "council" as const, role, member: true })), { section: "council", role: "Verdict" }]; }
	/** Enter nested screen preserving parent focus. @param screen Destination. */
	private push(screen: DraftScreen): void { this.stack.push({ screen: this.screen, index: this.index }); this.screen = screen; this.nestedIndex = 0; this.pane = "detail"; this.error = ""; }
	/** Return exactly one level and restore parent focus. */
	private back(): void { if (this.pickerReturn && this.screen.type === "direct-providers") { this.restorePicker(); return; } const parent = this.stack.pop(); if (!parent) { this.pane = "sidebar"; return; } this.screen = parent.screen; if (parent.screen.type === "root") this.focus[this.section] = parent.index; else this.nestedIndex = parent.index; this.error = ""; }
	/** Open staged candidate without mutating config. @param candidate Reviewed or manual value. @param editingName Immutable edit identity. @param generated Candidate came from paid generation. */
	startCandidate(candidate: Persona = { name: "", stance: "neutral", systemPrompt: "" }, editingName?: string, generated = false): void {
		if (this.operation || this.account?.view) return;
		if (this.options.project) { this.error = "Prompts need global or explicit config."; this.changed(); return; }
		this.candidate = { value: structuredClone(candidate), editingName, generated, seat: !editingName };
		this.push({ type: "candidate" }); this.changed();
	}
	/** Execute explicit row intent; callers must distinguish Right from Enter. @param field Focused action. */
	private dispatch(field: DraftField): void {
		try {
			switch (field.action) {
				case "route": if (this.screen.type === "generator") { this.generatorTarget = structuredClone(field.target!); this.back(); } else this.push({ type: "route", target: field.target! }); break;
				case "persona": this.push({ type: "persona", name: field.name! }); break;
				case "library": this.push({ type: "library" }); break;
				case "add": if (!this.options.project) this.push({ type: "add" }); break;
				case "manual": this.startCandidate(); break;
				case "ai": if (!this.options.project) this.push({ type: "ai" }); break;
				case "generator": this.push({ type: "generator" }); break;
				case "seat": this.draft = togglePersonaSeat(this.draft, field.name!, Boolean(this.options.project)); break;
				case "edit-persona": { const persona = personaLibrary(this.draft).find(p => p.name === field.name) ?? { name: field.name!, stance: "neutral" as const, systemPrompt: "" }; this.startCandidate(persona, persona.name); break; }
				case "reset-persona": this.confirmation = { type: "reset", dirty: this.dirty, index: 0, name: field.name }; break;
				case "preview": if (this.stack.at(-1)?.screen.type === "preview") this.back(); else this.push({ type: "preview" }); break;
				case "candidate-edit": this.push({ type: "candidate" }); break;
				case "accept": {
					const candidate = this.candidate!; this.draft = acceptPersona(this.draft, candidate.value, Boolean(this.options.project), candidate.editingName, candidate.seat);
					this.candidate = undefined;
					// Leave every candidate/generation child while retaining originating persona/library focus.
					while (this.stack.length && ["candidate", "preview", "ai", "generator", "add"].includes(this.screen.type)) this.back();
					break;
				}
				case "direct-providers": this.openProviders(); break;
				case "installed-clis": this.push({ type: "installed-clis" }); break;
				case "sdk-account": { const provider = this.sdkProviders.find(row => row.id === field.name); if (provider) this.account?.open(provider); break; }
				case "share-pi": {
					// Toggle in the draft only; Review saves it. Off removes the key entirely.
					if (this.draft.sharePiAuth === true) delete this.draft.sharePiAuth;
					else this.draft.sharePiAuth = true;
					this.changed();
					break;
				}
				case "backend-detail": this.push({ type: "backend-detail", name: field.name! }); break;
				case "check-backends": this.startBackendCheck(); break;
				case "configure-advisor": this.jump("Advisor"); break;
				case "generate": this.requestOperation("generate", [this.generatorTarget]); break;
				case "test": this.requestOperation("test", [field.target!]); break;
				case "test-all": this.requestOperation("test", seatedPersonas(this.draft).map(role => ({ section: "council", role, member: true }))); break;
				case "back": this.back(); break;
			}
		} catch (error) { this.error = error instanceof Error ? error.message : "Persona change failed."; }
	}
	/** Refuse project inheritance whose global route is absent from this file-only draft.
	 * @param draft Target-file settings. @param target Selected seat. @returns Exact route preflight or actionable blocker.
	 */
	private preflight(draft: BpxCouncilConfig, target: RouteTarget, purpose: "test" | "generate" = "test"): ActionPreflight {
		if (this.options.project && !draft.solo?.backend && !configRoute(draft, target)) {
			return { route: "Inherited global Advisor", error: "Global Advisor is not represented in this project draft. Test in Global settings or pin a project Anthropic backend." };
		}
		const route = configRoute(draft, target) ?? draft.solo?.backend;
		if (route?.type === "sdk" && !route.model) return { route: backendLabel(route), error: "Choose an explicit direct provider model before running this route." };
		return this.actions.preflight(draft, target, purpose);
	}
	/** Fingerprint effective runtime route, not unrelated prompt/preferences JSON. @param target Route identity. @param draft Snapshot. @returns Stable session comparison. */
	routeFingerprint(target: RouteTarget, draft = this.draft, purpose: "test" | "generate" = "test"): string {
		const pinned = configRoute(draft, target);
		const route = structuredClone(pinned ?? draft.solo?.backend);
		if (route && (target.section === "advisor" || !pinned) && !route.effort && draft.solo?.thinkingLevel) route.effort = draft.solo.thinkingLevel;
		return JSON.stringify([route, this.preflight(draft, target, purpose), target.section === "gut-check" ? draft.gutCheck?.maxOutputTokens : undefined, ...(route?.type === "sdk" ? [this.#sdkService?.preflight(route).revision] : [])]);
	}
	/** Reject only a previously called, failed exact route; other models remain choices.
	 * @param target Edited seat. @param draft Candidate settings. @returns Whether identical effective route failed.
	 */
	private failedChoice(target: RouteTarget, draft = this.draft): boolean {
		const fingerprint = this.routeFingerprint(target, draft);
		return this.testResults.some(item => !item.pending && !item.blocked && !item.result.ok && !item.result.cancelled && !item.result.error?.startsWith("Not called;") && item.fingerprint === fingerprint);
	}
	/** Retain saved identity with explicit failure labels, never erase an unusable route.
	 * @param target Edited seat. @param route Exact configured route. @returns Keep-choice suffix.
	 */
	private retainedStatus(target: RouteTarget, route: NonNullable<ReturnType<typeof configRoute>>): string {
		const local = this.backendDiagnostics.find(row => row.name === backendName(route));
		return `${local?.check === "failed" ? "; check failed" : local?.status === "missing" ? "; missing" : local?.status === "unusable" ? "; unusable" : local?.status === "key-missing" ? "; Key missing; configure later" : local?.check === "version-unavailable" ? "; version unavailable (warning)" : ""}${this.failedChoice(target) ? "; Test failed" : ""}`;
	}
	/** Remove results whose effective routes changed, including inherited Advisor edits. */
	private invalidateResults(): void { this.testResults = this.testResults.filter(item => item.fingerprint === this.routeFingerprint(item.target)); }
	/** Preflight synchronously and open safe cost confirmation. @param type Operation. @param targets Exact seats. */
	private requestOperation(type: "test" | "generate", targets: RouteTarget[]): void {
		if (this.operation || (type === "generate" && this.options.project)) return;
		if (type === "generate" && !this.generationFocus.trim()) { this.error = "Describe persona focus before generating."; return; }
		const draft = structuredClone(this.draft);
		const checks = targets.map(target => {
			const route = configRoute(draft, target) ?? draft.solo?.backend;
			const local = route && this.backendDiagnostics.find(row => row.name === backendName(route));
			if (this.section === "Backends" && local && ["missing", "unusable", "key-missing"].includes(local.status)) return { route: backendLabel(route), error: `Not available: ${this.backendStatus(local)}. Configure Advisor; Check installed CLIs refreshes local presence.` };
			return this.preflight(draft, target, type);
		});
		const blocked = checks.flatMap((check, index) => check.error ? [{ target: targets[index], blocked: true, fingerprint: this.routeFingerprint(targets[index], draft), result: { ok: false, route: check.route, elapsedMs: 0, text: "", error: check.error } }] : []);
		const eligible = targets.filter((_, index) => !checks[index].error);
		if (!eligible.length) { this.testResults = blocked; if (type === "test") this.push({ type: "results" }); this.error = type === "generate" ? `${checks[0].route}: ${checks[0].error}` : "No eligible routes. Blocked reasons shown below."; return; }
		this.confirmation = { type: "cost", dirty: this.dirty, index: 0, routes: checks.filter(check => !check.error).map(check => check.route), warnings: [...new Set(checks.filter(check => !check.error).flatMap(check => check.warning ? [check.warning] : []))], request: { type, draft, targets: structuredClone(eligible), focus: this.generationFocus, blocked, order: structuredClone(targets), fingerprints: Object.fromEntries(targets.map(target => [JSON.stringify(target), this.routeFingerprint(target, draft, type)])), sdkAccountRevisions: Object.freeze(Object.fromEntries(targets.flatMap((target, index) => checks[index].revision === undefined ? [] : [[JSON.stringify(target), checks[index].revision!]]))) } };
	}
	/** Run confirmed snapshot sequentially; track lifecycle through actual cancellation cleanup.
	 * @param request Confirmed operation snapshot. @returns Cleanup completion.
	 */
	private async runOperation(request: NonNullable<DraftConfirmation["request"]>): Promise<void> {
		const operation: DraftOperation = { type: request.type, abort: new AbortController(), cancelling: false, completed: 0, total: request.targets.length, rows: request.targets.map(target => ({ label: `${target.section} / ${target.role}`, status: "Waiting" })) };
		this.operation = operation;
		if (request.type === "test") {
			const order = request.order ?? request.targets;
			const attempted = order.map(target => JSON.stringify(target));
			const retained = this.testResults.filter(item => !attempted.includes(JSON.stringify(item.target)));
			this.testResults = [...retained, ...order.map(target => request.blocked?.find(item => JSON.stringify(item.target) === JSON.stringify(target)) ?? { target, fingerprint: request.fingerprints?.[JSON.stringify(target)] ?? this.routeFingerprint(target, request.draft), pending: true, result: { ok: false, route: this.preflight(request.draft, target).route, elapsedMs: 0, text: "Waiting for this seat." } })];
			this.push({ type: "results" }); this.nestedIndex = retained.length;
		}
		this.changed();
		try {
			for (const target of request.targets) {
				if (operation.abort.signal.aborted) break;
				const fingerprint = request.fingerprints?.[JSON.stringify(target)] ?? this.routeFingerprint(target, request.draft, request.type);
				if (fingerprint !== this.routeFingerprint(target, request.draft, request.type)) { this.error = "Route changed since confirmation. Remaining calls skipped; confirm again."; break; }
				operation.current = `${target.section} / ${target.role}`;
				operation.rows![operation.completed].status = request.type === "test" ? "Testing" : "Generating";
				this.changed();
				// Fresh checks may reject consent, never renew its original account generation.
				const sdkAccountRevision = request.sdkAccountRevisions?.[JSON.stringify(target)];
				if (request.type === "generate") {
					const result = await (sdkAccountRevision === undefined
						? this.actions.generate(request.draft, target, request.focus!, operation.abort.signal)
						: this.actions.generate(request.draft, target, request.focus!, operation.abort.signal, { sdkAccountRevision }));
					operation.rows![operation.completed].status = result.ok && result.candidate ? "Candidate ready" : "Generation failed";
					if (operation.abort.signal.aborted || this.result) break;
					if (fingerprint !== this.routeFingerprint(target, this.draft, "generate")) { this.error = "Generator route changed; stale candidate ignored. Generate again."; break; }
					if (result.ok && result.candidate) {
						this.candidate = { value: structuredClone(result.candidate), generated: true, seat: true };
						if (this.screen.type !== "preview") this.push({ type: "preview" });
						this.error = personaError(this.draft, this.candidate.value, Boolean(this.options.project));
					} else this.error = result.error ?? "Generation failed; edit focus or generator route and retry.";
				} else {
					let result: RouteTestResult;
					try { result = await (sdkAccountRevision === undefined
						? this.actions.test(request.draft, target, operation.abort.signal)
						: this.actions.test(request.draft, target, operation.abort.signal, { sdkAccountRevision })); }
					catch { result = { ok: false, route: this.preflight(request.draft, target).route, elapsedMs: 0, text: "", error: operation.abort.signal.aborted ? "Cancelled" : "Route test failed. Check settings and retry; provider details withheld." }; }
					operation.rows![operation.completed].status = operation.abort.signal.aborted || result.cancelled ? "Cancelled" : result.ok ? "Response received" : "Test failed";
					if (!this.result && fingerprint === this.routeFingerprint(target)) {
						const index = this.testResults.findIndex(item => JSON.stringify(item.target) === JSON.stringify(target));
						if (index >= 0) this.testResults[index] = { target: structuredClone(target), fingerprint, result: operation.abort.signal.aborted ? { ...result, ok: false, cancelled: true, text: "", error: "Cancelled" } : result };
					} else if (!this.result && !operation.abort.signal.aborted && sdkAccountRevision !== undefined) {
						this.error = "Route changed while testing; stale response ignored. Confirm again.";
					}
				}
				operation.completed++; this.changed();
			}
		} catch {
			this.error = operation.abort.signal.aborted ? "Call cancelled; completed results retained." : "Operation failed. Check route settings and retry; provider details withheld.";
		} finally {
			if (operation.abort.signal.aborted) {
				this.error = "Call cancelled; completed results retained.";
				this.testResults = this.testResults.map(item => item.pending ? { ...item, pending: false, result: { ...item.result, cancelled: true, error: "Not called; cancellation stopped batch.", text: "" } } : item);
			}
			this.testResults = this.testResults.map(item => item.pending ? { ...item, pending: false, result: { ...item.result, error: "Not called; route changed. Confirm again.", text: "" } } : item);
			this.operation = undefined;
			if (this.exitAfterOperation) { this.exitAfterOperation = false; this.finish(null, 130); }
			this.changed();
		}
	}
	/** Cancel paid call without losing completed results or racing subprocess cleanup. @param exit Exit after cleanup. */
	interrupt(exit = false): void {
		if (this.account?.view) { this.account.cancel(exit ? () => this.finish(null, 130) : undefined); return; }
		if (!this.operation) { if (exit) this.finish(null, 130); return; }
		this.exitAfterOperation ||= exit; this.operation.cancelling = true; this.operation.abort.abort(); this.changed();
	}
	/** Subscribe to changes. @param listener Render callback. @returns Unsubscribe callback. */
	subscribe(listener: () => void): () => void { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; }
	/** Notify UI after controller state changes. */
	private changed(): void { this.invalidateResults(); for (const listener of this.listeners) listener(); }
	/** Cancel discovery and invalidate late results. */
	cancel(): void { if (this.account?.view) this.account.cancel(); this.abort?.abort(); this.abort = undefined; this.modal = undefined; if (this.operation) this.interrupt(); }
	/** Await cancelled subprocess cleanup before caller can exit. @returns All tracked lookups settled. */
	async settle(): Promise<void> { this.cancel(); await Promise.allSettled([...this.pending]); await this.account?.settle(); }
	/** Page transient account instructions without exposing events to draft Review. @param amount Page offset. @param maximum Last visible page. */
	accountPage(amount: number, maximum: number): void { if (this.account?.view) { this.account.view.page = Math.max(0, Math.min(maximum, this.account.view.page) + amount); this.account.view.page = Math.min(maximum, this.account.view.page); this.changed(); } }
	/** Select a section while retaining its previous row. @param section Sidebar section. */
	selectSection(section: Section): void {
		if (this.confirmation || this.operation || this.account?.view) return;
		this.cancel(); this.screen = { type: "root" }; this.stack = []; this.candidate = undefined; this.section = section; this.error = "";
		if (section !== "Review" && section !== "Discard") this.editingSection = section;
		if (section === "Review") { this.focus.Review = 0; this.review(); }
		if (section === "Discard") this.focus.Discard = 0;
		this.changed();
	}
	/** Jump directly into a section. @param section Shortcut destination. */
	jump(section: Section): void { if (this.confirmation || this.operation || this.account?.view) return; this.pane = "detail"; this.selectSection(section); }
	/** Toggle pane focus, or cycle dialog buttons. @param backwards Shift-Tab direction. */
	tab(backwards = false): void {
		if (this.operation || this.account?.view?.busy) return;
		if (this.account?.view) { this.account.move(backwards ? -1 : 1); return; }
		if (this.confirmation) {
			const count = confirmationChoices(this.confirmation).length;
			this.confirmation.index = (this.confirmation.index + (backwards ? count - 1 : 1)) % count;
		} else if (this.modal) return;
		else this.pane = this.pane === "sidebar" ? "detail" : "sidebar";
		this.changed();
	}
	/** Move between panes or open an editable row, never execute Review/Discard actions.
	 * @param direction Left returns to sidebar; Right enters details or edits a field.
	 */
	horizontal(direction: "left" | "right"): void {
		if (this.modal || this.confirmation || this.result || this.operation || this.account?.view) return;
		if (direction === "left") {
			if (this.pane === "detail") { this.back(); this.changed(); }
		} else if (this.pane === "sidebar") this.enter();
		else if (this.section !== "Review" && this.section !== "Discard") {
			const field = this.fields[this.index];
			if (field?.kind !== "action" || ["route", "persona", "library", "generator", "candidate-edit", "backend-detail", "direct-providers", "installed-clis"].includes(field.action!)) this.enter();
		}
	}
	/** Move active list focus. @param amount Offset, or first/last. */
	move(amount: number | "first" | "last"): void {
		if (this.operation) return;
		if (this.confirmation) {
			const count = confirmationChoices(this.confirmation).length;
			this.confirmation.index = Math.max(0, Math.min(count - 1, amount === "first" ? 0 : amount === "last" ? count - 1 : this.confirmation.index + amount));
			this.changed(); return;
		}
		if (this.account?.view) { this.account.move(typeof amount === "number" ? amount : amount === "first" ? -999 : 999); return; }
		const count = this.modal ? modalChoices(this.modal).length : this.pane === "sidebar" ? SECTIONS.length : this.section === "Review" ? (this.error ? 1 : 2) : this.section === "Discard" ? 2 : this.fields.length;
		const index = this.modal ? this.modal.index : this.pane === "sidebar" ? SECTIONS.indexOf(this.section) : this.index;
		const next = Math.max(0, Math.min(count - 1, amount === "first" ? 0 : amount === "last" ? count - 1 : index + amount));
		if (this.modal) this.modal.index = next;
		else if (this.pane === "sidebar") { this.selectSection(SECTIONS[next]); return; }
		else if (this.screen.type === "root") this.focus[this.section] = next;
		else this.nestedIndex = next;
		this.changed();
	}
	/** Escape closes confirmation/edit, backs out to sidebar, then asks before exiting. */
	escape(): void {
		if (this.account?.view) { this.account.cancel(); return; }
		if (this.operation) { this.interrupt(); return; }
		if (this.confirmation) this.confirmation = undefined;
		else if (this.modal) this.cancel();
		else if (this.pane === "detail") this.back();
		else this.openConfirmation("exit");
		this.changed();
	}
	/** Open safe-default confirmation without changing workspace. @param type Save or exit intent. */
	private openConfirmation(type: DraftConfirmation["type"]): void {
		if (this.confirmation || this.result || (type === "save" && !this.review())) return;
		this.confirmation = { type, dirty: this.dirty, index: 0 };
	}
	/** Execute one button; reopening always starts at safe Cancel/Keep editing. */
	private confirm(): void {
		if (!this.confirmation) return;
		const action = confirmationChoices(this.confirmation)[this.confirmation.index]?.action;
		if (action === "run") {
			const request = this.confirmation.request!; this.confirmation = undefined;
			const job = this.runOperation(request); this.pending.add(job);
			void job.then(() => this.pending.delete(job), () => this.pending.delete(job));
		} else if (action === "reset") {
			this.draft = resetBuiltinPersona(this.draft, this.confirmation.name!, Boolean(this.options.project)); this.confirmation = undefined;
		} else if (action === "cancel") this.confirmation = undefined;
		else if (action === "save") {
			this.confirmation = undefined;
			if (this.review()) this.finish(this.draft, 0);
		} else if (action === "discard") this.finish(null, 0);
		this.changed();
	}
	/** Enter focused section, edit, or confirm a button. */
	enter(): void {
		if (this.result || this.operation) return;
		if (this.account?.view) { this.account.enter(); return; }
		if (this.confirmation) { this.confirm(); return; }
		if (this.modal) { if (this.modal.type === "choices") this.choose(); return; }
		if (this.pane === "sidebar") {
			this.pane = "detail";
			if (this.section === "Review") this.review();
			this.changed(); return;
		}
		if (this.section === "Review") {
			if (this.focus.Review === 1) this.openConfirmation("save");
			else { this.selectSection(this.editingSection); this.pane = "detail"; }
		} else if (this.section === "Discard") {
			if (this.focus.Discard === 1) this.openConfirmation("exit");
			else { this.selectSection(this.editingSection); this.pane = "detail"; }
		} else { const field = this.fields[this.index]; if (field?.kind === "action") this.dispatch(field); else this.edit(field); }
		this.changed();
	}
	/** Validate before exposing Save. Invalid drafts remain editable. @returns Whether save is allowed. */
	review(): boolean {
		if (this.operation || this.account?.view) return false;
		try { validateConfig(this.draft, this.options.path, this.options.project ?? false); this.error = ""; }
		catch (error) { this.error = error instanceof Error ? error.message : String(error); }
		return !this.error;
	}
	/** End UI without disk effects. @param config Saved draft or null. @param code Exit status. */
	finish(config: BpxCouncilConfig | null, code: number): void { if (this.result) return; if (this.account?.view?.busy) { this.account.cancel(() => this.finish(config, code)); return; } if (this.operation) { this.interrupt(code === 130); return; } this.confirmation = undefined; this.cancel(); this.result = { config: config ? structuredClone(config) : null, code }; this.changed(); }
	/** Open field dialog with current value retained, discovery requested only on demand. @param field Focused row. */
	edit(field: DraftField | undefined): void {
		if (!field || this.confirmation || this.operation || this.account?.view) return;
		this.cancel(); this.error = "";
		if (["name", "stance", "prompt", "focus"].includes(field.kind)) {
			if (field.kind === "name" && this.candidate?.editingName) { this.error = "Existing persona name is immutable."; this.changed(); return; }
			this.modal = { field, type: field.kind === "stance" ? "choices" : "text", text: field.kind === "stance" ? "" : field.kind === "focus" ? this.generationFocus : field.kind === "prompt" ? this.candidate!.value.systemPrompt : this.candidate!.value.name, index: field.kind === "stance" ? ["for", "against", "neutral"].indexOf(this.candidate!.value.stance) : 0, choices: field.kind === "stance" ? ["for", "against", "neutral"].map(value => ({ label: `${value} (search bias, not forced verdict)`, value })) : [], loading: false, notice: ["prompt", "focus"].includes(field.kind) ? "Enter newline · Ctrl-S apply · Esc cancel" : "Enter applies candidate field; no config mutation." };
			this.changed(); return;
		}
		const route = field.target ? configRoute(this.draft, field.target) : undefined;
		const legacyReset = field.target?.section === "advisor" && field.kind === "effort" && !route && this.draft.solo?.thinkingLevel !== undefined;
		if (field.target && field.kind !== "backend" && !route && !legacyReset) { this.error = "Choose a pinned backend first; inherited routes follow Advisor."; this.changed(); return; }
		const current = field.kind === "model" ? route?.model : field.kind === "effort" ? route?.effort ?? (field.target?.section === "advisor" ? this.draft.solo?.thinkingLevel : undefined) : undefined;
		let choices: DraftChoice[] = [];
		if (field.kind === "backend") {
			const backends = this.actualInstalled;
			choices = [{ label: field.target?.section === "advisor" ? "Auto-detect" : "Inherit Advisor", value: null }, ...(route ? [{ label: `${backendLabel(route)} (current; keep exact${this.retainedStatus(field.target!, route)})`, value: undefined, backend: backendName(route), accentText: backendLabel(route) }] : []), ...backends.filter(b => (!this.options.project || b.name === "anthropic") && !this.failedChoice(field.target!, changeConfigRoute(this.draft, field.target!, { field: "backend", value: b.name }))).map(b => ({ label: `${b.name} (${this.backendStatus(b)}${b.kind === "cli" ? `; ${this.backendVersion(b)}` : b.status === "key-missing" ? "; configure later" : "; not authenticated"})`, value: b.name, backend: b.name, accentText: b.name })), ...(!this.options.project ? [{ label: "Enter backend manually…", manual: true }] : [])];
		} else if (field.kind === "mode") choices = MODES.map(value => ({ label: value, value }));
		else if (field.kind === "tokens") choices = [{ label: "Default", value: null }, { label: "Enter limit (1–4096)", manual: true }];
		else choices = [{ label: "Backend default", value: null }, ...(!current && field.target && this.failedChoice(field.target) ? [{ label: "Backend default (current; keep unchanged; Test failed)", value: undefined }] : []), ...(current ? [{ label: `${current} (current; keep unchanged${field.kind === "model" && field.target && this.failedChoice(field.target) ? "; Test failed" : ""})`, value: undefined, ...(field.kind === "model" && route ? { backend: backendName(route), accentText: current } : {}) }] : []), ...(!legacyReset ? [{ label: `Enter ${field.kind} ID`, manual: true }] : [])];
		if (route?.type === "sdk" && field.kind === "model") choices[0] = { label: "Clear model (choose model before running)", value: null };
		if (field.target && ["backend", "model", "effort"].includes(field.kind)) choices = choices.filter(choice => choice.value === undefined || !this.failedChoice(field.target!, changeConfigRoute(this.draft, field.target!, { field: field.kind as "backend" | "model" | "effort", value: choice.value })));
		const retained = choices.findIndex(choice => choice.value === undefined && !choice.manual);
		this.modal = { field, type: "choices", text: "", index: retained >= 0 ? retained : field.kind === "mode" ? Math.max(0, MODES.indexOf(this.draft.defaultMode ?? "solo")) : 0, choices, loading: false, notice: field.kind === "backend" ? "CLI installed = executable found. Direct account stored = not tested. Manual entry takes a route, not an API key. Setup saves accounts immediately; routes stay staged." : "Catalog entries do not test selected model." };
		if (route && (field.kind === "model" || field.kind === "effort")) {
			const job = this.discover(this.modal, route);
			this.pending.add(job);
			void job.then(() => this.pending.delete(job), () => this.pending.delete(job));
		}
		if (field.kind === "backend" && !this.options.project) {
			const modal = this.modal;
			const job = this.loadPickerProviders(modal); this.pending.add(job);
			void job.then(() => this.pending.delete(job), () => this.pending.delete(job));
		}
		this.changed();
	}
	/** Load model choices or effort levels with abort and modal identity guards. @param modal Original dialog. @param route Pinned route. */
	private async discover(modal: DraftModal, route: NonNullable<ReturnType<typeof configRoute>>): Promise<void> {
		const abort = new AbortController(); this.abort = abort; modal.loading = true;
		const name = backendName(route);
		try {
			const discovered = route.type === "sdk" ? (modal.field.kind === "model" ? (await this.sdk()).catalog(route.provider).map(model => model.id) : (await this.sdk()).catalog(route.provider).find(model => model.id === route.model)?.thinkingLevels ?? []) : modal.field.kind === "model" ? await this.discovery.listModels(name, abort.signal) : (await this.discovery.listEfforts(name, route.model, abort.signal))?.levels ?? [];
			const items = discovered.filter(value => !modal.field.target || !this.failedChoice(modal.field.target, value === route.model && modal.field.kind === "model" ? this.draft : changeConfigRoute(this.draft, modal.field.target, { field: modal.field.kind as "model" | "effort", value })));
			if (abort.signal.aborted || this.modal !== modal) return;
			const highlighted = modalChoices(modal)[modal.index];
			const choices = [...new Set(items)].map(value => ({ label: value, value, ...(modal.field.kind === "model" ? { backend: name, accentText: value } : {}) }));
			if (name === "claude" && modal.field.kind === "model") modal.choices.unshift(...choices);
			else modal.choices.push(...choices);
			modal.index = Math.max(0, modalChoices(modal).indexOf(highlighted));
			modal.notice = name === "claude" && modal.field.kind === "model" ? "Claude aliases; resolved by Claude when run."
				: items.length ? `${items.length} catalog entries; current choice retained.` : "Catalog empty/unavailable. Keep current or enter ID manually.";
		} catch {
			if (abort.signal.aborted || this.modal !== modal) return;
			modal.notice = "Catalog lookup failed. Keep current or enter ID manually.";
		} finally {
			if (!abort.signal.aborted && this.modal === modal) { modal.loading = false; this.changed(); }
		}
	}
	/** Update search or manual text without mutating draft. @param text Input value. */
	text(text: string): void { if (this.operation) return; if (this.modal) { this.modal.text = text; this.modal.index = 0; this.changed(); } }
	/** Choose focused dropdown value; manual entry remains cancellable. */
	choose(): void {
		if (this.operation || !this.modal) return;
		const choice = modalChoices(this.modal)[this.modal.index];
		if (!choice) return;
		if (choice.setup) { this.pickerReturn = { modal: this.modal, screen: this.screen, stack: [...this.stack], index: this.index, pane: this.pane }; this.modal = undefined; this.openProviders(); return; }
		if (choice.manual) {
			const modal = this.modal; const query = modal.text.trim(); this.abort?.abort(); this.abort = undefined; modal.loading = false; modal.type = "text";
			if (modal.field.kind === "backend") modal.notice = "CLI name or backend:model@effort / sdk:provider:model@effort route; does not install CLI or accept API keys.";
			const route = modal.field.target ? configRoute(this.draft, modal.field.target) : undefined;
			modal.text = query || (modal.field.kind === "tokens" ? String(this.draft.gutCheck?.maxOutputTokens ?? "") : modal.field.kind === "model" ? route?.model ?? "" : modal.field.kind === "effort" ? route?.effort ?? "" : "");
			this.changed(); return;
		}
		if (choice.value !== undefined) this.apply(this.modal.field, choice.value);
		this.cancel(); this.changed();
	}
	/** Submit manual value, rejecting invalid limits in place. @param text Submitted text. */
	submit(text: string): void {
		if (this.operation || !this.modal || this.modal.type !== "text") return;
		const value = ["prompt", "focus"].includes(this.modal.field.kind) ? text : text.trim();
		if (!value.trim()) { this.error = "Enter a value, or Esc to keep current."; this.changed(); return; }
		if (this.modal.field.kind === "tokens" && (!/^\d+$/.test(value) || Number(value) < 1 || Number(value) > 4096)) { this.error = "Output tokens must be an integer from 1 to 4096."; this.changed(); return; }
		this.apply(this.modal.field, value); this.cancel(); this.changed();
	}
	/** Apply explicit field intent via authoritative route helpers. @param field Row. @param value Selected value or default. */
	private apply(field: DraftField, value: string | null): void {
		if (field.kind === "focus") this.generationFocus = value ?? "";
		else if (field.kind === "name") this.candidate!.value.name = value ?? "";
		else if (field.kind === "stance") this.candidate!.value.stance = value as Persona["stance"];
		else if (field.kind === "prompt") this.candidate!.value.systemPrompt = value ?? "";
		else if (field.target && (field.kind === "backend" || field.kind === "model" || field.kind === "effort")) this.draft = changeConfigRoute(this.draft, field.target, { field: field.kind, value });
		else {
			this.draft = structuredClone(this.draft);
			if (field.kind === "mode") this.draft.defaultMode = value as BpxCouncilConfig["defaultMode"];
			else if (field.kind === "tokens") {
				if (value === null) { if (this.draft.gutCheck) delete this.draft.gutCheck.maxOutputTokens; }
				else { this.draft.gutCheck ??= {}; this.draft.gutCheck.maxOutputTokens = Number(value); }
			}
		}
		if (field.kind === "backend") this.refreshInventory();
	}
}
