import { MODES } from "./args.js";
import type { BackendConfig, BpxCouncilConfig } from "./config.js";
import { validateConfig } from "./config-validation.js";
import { parseBackendArg, type AvailableBackend } from "./detect.js";
import { serializeSdkRoute } from "./sdk-route.js";
import { DEFAULT_PERSONAS } from "./personas.js";
import type { SelectOption } from "./select.js";

/** Cancellable settings interactions; discovery never proves authentication. */
export interface EditorPickers {
	select(header: string, options: SelectOption[], initial: number): Promise<string | null>;
	filterSelect(header: string, items: string[], initial: number): Promise<string | null>;
	ask(header: string, def: string): Promise<string | null>;
	/** Show a discovery status before a potentially slow bounded lookup. */
	status?(message: string): void;
	listModels(backend: string): Promise<string[]>;
	listEfforts(backend: string, model?: string): Promise<{ levels: string[]; def?: string } | null>;
}

export interface EditorOptions {
	path: string;
	scope: "global" | "project" | "explicit";
	/** Explicit trusted paths do not receive project restrictions. */
	project?: boolean;
}

/** Describe backend without exposing custom args, endpoints or credentials. @param backend Stored backend. @returns Route label. */
export function backendLabel(backend?: BackendConfig): string {
	if (!backend) return "Auto-detect";
	if (backend.type === "sdk") return serializeSdkRoute({ ...backend, provider: backend.provider! });
	return `${backend.type === "http" ? backend.provider : backend.command}${backend.type === "tmux" ? " (tmux)" : ""}${backend.model ? `:${backend.model}` : ""}${backend.effort ? `@${backend.effort}` : ""}`;
}

/** Read discovery name without converting stored backend to a spec. @param backend Stored backend. @returns Catalog name. */
export function backendName(backend: BackendConfig): string {
	return backend.type === "sdk" ? `sdk:${backend.provider}` : backend.type === "http" ? backend.provider! : backend.command!;
}

/** Describe inherited routes explicitly. @param spec Stored seat spec. @returns Display label. */
function seatLabel(spec?: string | null): string { return spec ?? "Inherit Advisor"; }

/** Build summary without normalizing missing sections. @param draft Settings draft. @param opts Target context. @param dirty Whether edits exist. @returns Hub header. */
function summary(draft: BpxCouncilConfig, opts: EditorOptions, dirty: boolean): string {
	const members = draft.council?.members ?? DEFAULT_PERSONAS.map((p) => p.name);
	return [
		`Settings · ${opts.scope} · ${dirty ? "unsaved changes" : "unchanged"}`,
		opts.path,
		`Advisor: ${backendLabel(draft.solo?.backend)}`,
		`Gut-check: ${seatLabel(draft.gutCheck?.backend)} · output ${draft.gutCheck?.maxOutputTokens ?? "default"}`,
		`Council: ${members.map((name) => `${name}=${seatLabel(draft.council?.backends?.[name])}`).join(", ")}`,
		`Council verdict: ${seatLabel(draft.council?.synthesizer)}`,
		`Debate: ${["advocate", "critic", "synthesizer"].map((seat) => `${seat}=${seatLabel(draft.debate?.[seat as keyof NonNullable<BpxCouncilConfig["debate"]>])}`).join(", ")}`,
		`Default mode: ${draft.defaultMode ?? "solo (default)"}`,
	].join("\n");
}

/** A route draft plus explicit intent to remove its legacy Advisor effort fallback. */
export interface EditedRoute {
	route: BackendConfig | undefined;
	clearLegacyEffort: boolean;
}

/** Explicit field intent; null means backend default or seat inheritance. */
export type RouteChange = { field: "backend" | "model" | "effort"; value: string | null };
/** Config route identity; Council members never share an action namespace. */
export type RouteTarget = { section: "advisor" | "gut-check" | "council" | "debate"; role: string; member?: boolean };

/** Change one field without normalizing untouched settings.
 * @param current Exact stored backend. @param change Explicit edit. @returns Route plus legacy-reset intent, or null for no change.
 */
export function changeRoute(current: BackendConfig | undefined, change: RouteChange): EditedRoute | null {
	if (change.field === "backend") {
		if (change.value === null) return { route: undefined, clearLegacyEffort: true };
		const parsed = parseBackendArg(change.value);
		const selected: BackendConfig = parsed.type === "sdk"
			? { type: "sdk", provider: parsed.provider! }
			: parsed.type === "http"
				? { type: "http", provider: parsed.provider as "anthropic" | "openai" | "google" }
				: { type: parsed.type, command: parsed.command };
		if (parsed.model) selected.model = parsed.model;
		if (parsed.effort) selected.effort = parsed.effort;
		if (current?.type === selected.type && backendName(current) === backendName(selected)) {
			if (!parsed.model && !parsed.effort) return null;
			const route = structuredClone(current);
			if (parsed.model && parsed.model !== route.model) { route.model = parsed.model; delete route.effort; }
			if (parsed.effort) route.effort = parsed.effort;
			if (!parsed.effort && JSON.stringify(route) === JSON.stringify(current)) return null;
			return { route, clearLegacyEffort: true };
		}
		return { route: selected, clearLegacyEffort: true };
	}
	if (!current) return null;
	const route = structuredClone(current);
	if (change.field === "model") {
		if (change.value === route.model) return null;
		if (change.value === null) delete route.model;
		else route.model = change.value;
		delete route.effort;
	} else {
		if (change.value === null) delete route.effort;
		else route.effort = change.value;
	}
	return { route, clearLegacyEffort: true };
}

/** Read a seat without creating missing sections. @param draft Exact draft. @param target Route identity. @returns Stored spec. */
export function routeSpec(draft: BpxCouncilConfig, target: RouteTarget): string | null | undefined {
	if (target.section === "gut-check") return draft.gutCheck?.backend;
	if (target.section === "debate") return draft.debate?.[target.role as keyof NonNullable<BpxCouncilConfig["debate"]>];
	return target.member ? draft.council?.backends?.[target.role] : draft.council?.synthesizer;
}

/** Read exact Advisor object or parse a seat. @param draft Draft. @param target Route identity. @returns Pinned route, not fallback. */
export function configRoute(draft: BpxCouncilConfig, target: RouteTarget): BackendConfig | undefined {
	if (target.section === "advisor") return draft.solo?.backend;
	const spec = routeSpec(draft, target);
	return spec ? parseBackendArg(spec) as BackendConfig : undefined;
}

/** Store explicit route intent on a clone; only Advisor edits can clear its legacy effort.
 * @param draft Exact draft. @param target Route identity. @param edited Route and intent. @returns Updated clone.
 */
export function storeRoute(draft: BpxCouncilConfig, target: RouteTarget, edited: EditedRoute): BpxCouncilConfig {
	const next = structuredClone(draft);
	if (target.section === "advisor") {
		next.solo ??= {};
		if (edited.route) next.solo.backend = edited.route;
		else delete next.solo.backend;
		if (edited.clearLegacyEffort) delete next.solo.thinkingLevel;
		return next;
	}
	const route = edited.route;
	// Empty effort suffix protects a literal @ inside model ID from the spec parser.
	const spec = route ? `${route.type === "tmux" ? "tmux" : backendName(route)}${route.model ? `:${route.model}` : ""}${route.effort ? `@${route.effort}` : route.model?.includes("@") ? "@" : ""}` : null;
	if (target.section === "gut-check") { next.gutCheck ??= {}; next.gutCheck.backend = spec; }
	else if (target.section === "debate") { next.debate ??= {}; next.debate[target.role as keyof NonNullable<BpxCouncilConfig["debate"]>] = spec; }
	else {
		next.council ??= {};
		if (target.member) { next.council.backends ??= {}; next.council.backends[target.role] = spec; }
		else next.council.synthesizer = spec;
	}
	return next;
}

/** Apply a field edit without touching unrelated config. @param draft Draft. @param target Route identity. @param change Explicit field edit. @returns Draft clone, or original for no-op. */
export function changeConfigRoute(draft: BpxCouncilConfig, target: RouteTarget, change: RouteChange): BpxCouncilConfig {
	const current = configRoute(draft, target);
	const legacyReset = target.section === "advisor" && !current && draft.solo?.thinkingLevel !== undefined && change.field === "effort" && change.value === null;
	const edited = legacyReset ? { route: undefined, clearLegacyEffort: true } : changeRoute(current, change);
	return edited ? storeRoute(draft, target, edited) : draft;
}

/** Edit one route in memory. Null leaves settings unchanged; inherited seats serialize separately.
 * @param pickers Cancellable interactions and bounded catalogs.
 * @param available Detected choices, not authenticated accounts.
 * @param current Exact stored backend object.
 * @param seat Whether this is an inheritable seat.
 * @param project Restrict all route choices to Anthropic HTTP.
 * @param legacyEffort Display-only Advisor fallback, never merged into backend.
 * @returns Route and reset intent, or null when unchanged.
 */
async function editRoute(pickers: EditorPickers, available: AvailableBackend[], current: BackendConfig | undefined, seat: boolean, project: boolean, legacyEffort?: string): Promise<EditedRoute | null> {
	let route = current ? structuredClone(current) : undefined;
	const before = JSON.stringify(route);
	let explicitDefault = false;
	let clearLegacyEffort = false;
	for (;;) {
		const action = await pickers.select(`Route: ${backendLabel(route)}\nAvailability/catalog entries do not verify login.`, [
			{ label: "Backend", value: "backend", hint: backendLabel(route) },
			{ label: "Model", value: "model", hint: route?.model ?? "Backend default" },
			{ label: "Reasoning effort", value: "effort", hint: route?.effort ?? (legacyEffort && !clearLegacyEffort ? `${legacyEffort} (legacy fallback)` : "Backend default") },
			{ label: "Back", value: "back" },
		], 0);
		if (action === null || action === "back") {
			if (!explicitDefault && !clearLegacyEffort && JSON.stringify(route) === before) return null;
			return { route, clearLegacyEffort };
		}
		if (action === "backend") {
			const choices = available.filter((b) => !project || b.name === "anthropic");
			const options: SelectOption[] = [
				{ label: seat ? "Inherit Advisor" : "Auto-detect", value: "default" },
				...(route ? [{ label: backendLabel(route), value: "current", hint: "current; keep exact settings" }] : []),
				...choices.map((b, i) => ({ label: b.name, value: `choice:${i}`, kind: b.kind, hint: b.detail })),
				...(!project ? [{ label: "Enter backend manually…", value: "manual", hint: "CLI name or route; not an API key; does not install software" }] : []),
			];
			const picked = await pickers.select("Backend · esc keeps current", options, route ? 1 : 0);
			if (picked === null || picked === "current") continue;
			if (picked === "default") { const edited = changeRoute(route, { field: "backend", value: null })!; route = edited.route; explicitDefault = true; clearLegacyEffort = edited.clearLegacyEffort; continue; }
			const name = picked === "manual" ? await pickers.ask("Backend command or route (e.g. pi; not an API key)", "") : choices[Number(picked.slice(7))]?.name;
			if (!name?.trim()) continue;
			const edited = changeRoute(route, { field: "backend", value: name.trim() });
			if (!edited) continue;
			route = edited.route;
			explicitDefault = false;
			clearLegacyEffort = edited.clearLegacyEffort;
		} else if (!route) {
			await pickers.select("Choose a backend before pinning model or effort.", [{ label: "Back", value: "back" }], 0);
		} else if (action === "model") {
			const options: SelectOption[] = [
				{ label: "Backend default", value: "default", hint: "clear pinned model and effort" },
				...(route.model ? [{ label: route.model, value: "current", hint: "current, even if unavailable" }] : []),
				{ label: "Choose from catalog", value: "catalog", hint: "discover on demand; type to filter" },
				{ label: "Enter model ID", value: "manual" },
			];
			const picked = await pickers.select("Model · esc keeps current", options, route.model ? 1 : 0);
			if (picked === null || picked === "current") continue;
			if (picked === "default") { const edited = changeRoute(route, { field: "model", value: null })!; route = edited.route; clearLegacyEffort = edited.clearLegacyEffort; continue; }
			let model: string | null = null;
			if (picked === "catalog") {
				let models: string[] = [];
				pickers.status?.("Loading models… (bounded discovery; no advisor call)");
				try { models = await pickers.listModels(backendName(route)); } catch { /* Current/manual choices remain usable. */ }
				const items = [...new Set([...(route.model ? [route.model] : []), ...models])];
				if (items.length) model = await pickers.filterSelect("Model catalog · esc keeps current", items, Math.max(0, items.indexOf(route.model ?? "")));
				else model = await pickers.ask("Catalog unavailable · enter model ID (esc keeps current)", route.model ?? "");
			} else model = await pickers.ask("Model ID · esc keeps current", route.model ?? "");
			if (model?.trim()) { const edited = changeRoute(route, { field: "model", value: model.trim() }); if (edited) { route = edited.route; clearLegacyEffort = edited.clearLegacyEffort; } }
		} else if (action === "effort") {
			let efforts: { levels: string[]; def?: string } | null = null;
			pickers.status?.("Loading reasoning levels…");
			try { efforts = await pickers.listEfforts(backendName(route), route.model); } catch { /* Keep stored effort when discovery fails. */ }
			const effectiveEffort = route.effort ?? (legacyEffort && !clearLegacyEffort ? legacyEffort : undefined);
			const options: SelectOption[] = [
				{ label: "Backend default", value: "default" },
				...(effectiveEffort ? [{ label: effectiveEffort, value: "current", hint: route.effort ? "current; keep unchanged" : "legacy fallback; keep unchanged" }] : []),
				...(efforts?.levels ?? []).map((level) => ({ label: level, value: `level:${level}`, hint: level === efforts?.def ? "model default" : undefined })),
			];
			const fallback = legacyEffort && !clearLegacyEffort ? `\nLegacy fallback: ${legacyEffort}; Backend default clears it.` : "";
			const picked = await pickers.select(`Reasoning effort · discovered levels only; esc keeps current${fallback}`, options, effectiveEffort ? 1 : 0);
			const value = picked === "default" ? null : picked?.startsWith("level:") ? picked.slice(6) : undefined;
			if (value !== undefined) { const edited = changeRoute(route, { field: "effort", value })!; route = edited.route; clearLegacyEffort = edited.clearLegacyEffort; }
		}
	}
}

/** Edit string/null seat without rewriting an untouched route. @param pickers Interactions. @param available Backends. @param spec Stored spec. @param project Trust restriction. @returns New spec, or undefined when unchanged. */
async function editSeat(pickers: EditorPickers, available: AvailableBackend[], spec: string | null | undefined, project: boolean): Promise<string | null | undefined> {
	const parsed = spec ? parseBackendArg(spec) : undefined;
	const edited = await editRoute(pickers, available, parsed as BackendConfig | undefined, true, project);
	if (edited === null) return undefined;
	if (!edited.route) return null;
	const route = edited.route;
	return `${route.type === "tmux" ? "tmux" : backendName(route)}${route.model ? `:${route.model}` : ""}${route.effort ? `@${route.effort}` : route.model?.includes("@") ? "@" : ""}`;
}

/** Run summary-first settings hub over an isolated draft; never writes disk.
 * @param pickers Deterministic, cancellable interactions.
 * @param available Detected backend choices.
 * @param existing Exact file contents, not merged runtime defaults.
 * @param opts Path/scope used for display and save validation.
 * @returns Validated draft only after explicit Review → Save; null on discard.
 */
export async function editConfig(pickers: EditorPickers, available: AvailableBackend[], existing: BpxCouncilConfig | undefined, opts: EditorOptions): Promise<BpxCouncilConfig | null> {
	let draft = structuredClone(existing ?? {}) as BpxCouncilConfig;
	const original = JSON.stringify(draft);
	// A missing key does not prevent saving a provider choice for later use.
	available = available.some((b) => b.name === "anthropic") ? available : [...available, { name: "anthropic", kind: "http", detail: process.env.ANTHROPIC_API_KEY ? "API key present; connection not tested" : "API key missing; configure for later" }];
	for (;;) {
		const dirty = JSON.stringify(draft) !== original;
		const members = draft.council?.members ?? DEFAULT_PERSONAS.map((p) => p.name);
		const action = await pickers.select(`Settings · bpx-council · ${opts.scope}\n${opts.path}\n${dirty ? "Unsaved changes" : "Unchanged"}`, [
			{ label: "Advisor", value: "advisor", hint: backendLabel(draft.solo?.backend) },
			{ label: "Gut-check", value: "gut-check", hint: seatLabel(draft.gutCheck?.backend) },
			{ label: "Council", value: "council", hint: `${members.length} members · verdict ${seatLabel(draft.council?.synthesizer)}` },
			{ label: "Debate", value: "debate", hint: `verdict ${seatLabel(draft.debate?.synthesizer)}` },
			{ label: "Default mode", value: "mode", hint: draft.defaultMode ?? "solo (default)" },
			{ label: "Review & save", value: "review" }, { label: "Discard & exit", value: "discard" },
		], 0);
		if (action === null || action === "discard") {
			if (!dirty) return null;
			const discard = await pickers.select("Discard unsaved changes?", [{ label: "Keep editing", value: "keep" }, { label: "Discard & exit", value: "discard" }], 0);
			if (discard === "discard") return null;
		} else if (action === "mode") {
			const mode = await pickers.select("Default mode · routes stay independent", MODES.map((m) => ({ label: m, value: m })), Math.max(0, MODES.indexOf(draft.defaultMode ?? "solo")));
			if (mode !== null) draft.defaultMode = mode as BpxCouncilConfig["defaultMode"];
		} else if (action === "advisor") {
			const edited = await editRoute(pickers, available, draft.solo?.backend, false, opts.project ?? false, draft.solo?.thinkingLevel);
			if (edited !== null) draft = storeRoute(draft, { section: "advisor", role: "advisor" }, edited);
		} else if (action === "gut-check" || action === "council" || action === "debate") {
			for (;;) {
				const seats = action === "gut-check" ? ["backend"] : action === "debate" ? ["advocate", "critic", "synthesizer"] : [...(draft.council?.members ?? DEFAULT_PERSONAS.map((p) => p.name)), "synthesizer"];
				/** Read a seat without creating missing config sections. @param seat Role name. @returns Stored spec. */
				const specFor = (seat: string): string | null | undefined => action === "gut-check" ? draft.gutCheck?.backend : action === "debate" ? draft.debate?.[seat as keyof NonNullable<BpxCouncilConfig["debate"]>] : seat === "synthesizer" ? draft.council?.synthesizer : draft.council?.backends?.[seat];
				const options = seats.map((seat) => ({ label: seat, value: `seat:${seat}`, hint: seatLabel(specFor(seat)) }));
				if (action === "gut-check") options.push({ label: "Output tokens", value: "tokens", hint: String(draft.gutCheck?.maxOutputTokens ?? "default") });
				options.push({ label: "Back", value: "back", hint: "" });
				const selected = await pickers.select(`${action} · every route inherits Advisor unless pinned`, options, 0);
				if (selected === null || selected === "back") break;
				if (selected === "tokens") {
					const limit = await pickers.select("Gut-check output · HTTP limit; CLI prompt request only", [{ label: "Default", value: "default" }, { label: "Enter limit (1–4096)", value: "manual" }], draft.gutCheck?.maxOutputTokens ? 1 : 0);
					if (limit === "default") { if (draft.gutCheck) delete draft.gutCheck.maxOutputTokens; }
					else if (limit === "manual") {
						const text = await pickers.ask("Output tokens (1–4096) · esc keeps current", String(draft.gutCheck?.maxOutputTokens ?? ""));
						if (text !== null) {
							const value = /^\d+$/.test(text) ? Number(text) : NaN;
							if (Number.isSafeInteger(value) && value >= 1 && value <= 4096) { draft.gutCheck ??= {}; draft.gutCheck.maxOutputTokens = value; }
							else await pickers.select("Output tokens must be an integer from 1 to 4096; unchanged.", [{ label: "Back", value: "back" }], 0);
						}
					}
					continue;
				}
				const seat = selected.slice(5);
				const spec = await editSeat(pickers, available, specFor(seat), opts.project ?? false);
				if (spec === undefined) continue;
				draft = storeRoute(draft, { section: action, role: seat, member: action === "council" && seat !== "synthesizer" }, { route: spec ? parseBackendArg(spec) as BackendConfig : undefined, clearLegacyEffort: false });
			}
		} else if (action === "review") {
			let error: string | undefined;
			try { validateConfig(draft, opts.path, opts.project ?? false); } catch (e) { error = e instanceof Error ? e.message : String(e); }
			const picked = await pickers.select(`${summary(draft, opts, dirty)}\n${error ? `Cannot save: ${error}` : "Save writes this draft atomically."}`, error ? [{ label: "Back to editing", value: "back" }] : [{ label: "Back to editing", value: "back" }, { label: "Save", value: "save" }], 0);
			if (picked === "save" && !error) return draft;
		}
	}
}
