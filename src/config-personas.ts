import type { BpxCouncilConfig } from "./config.js";
import { DEFAULT_PERSONAS, type Persona } from "./personas.js";

/** List bundled and trusted custom definitions without materializing defaults.
 * @param draft Exact config. @returns Independent candidates in stable library order.
 */
export function personaLibrary(draft: BpxCouncilConfig): Persona[] {
	const names = [...new Set([...DEFAULT_PERSONAS.map(p => p.name), ...Object.keys(draft.personas ?? {})])];
	return names.map(name => ({ name, ...(draft.personas?.[name] ?? DEFAULT_PERSONAS.find(p => p.name === name)!) }));
}

/** Read seating without creating stored defaults. @param draft Config. @returns Independent ordered names. */
export function seatedPersonas(draft: BpxCouncilConfig): string[] {
	return [...(draft.council?.members ?? DEFAULT_PERSONAS.map(p => p.name))];
}

/** Validate a candidate separately from routes, before accepting any mutation.
 * @param draft Exact config. @param candidate Proposed definition. @param project Project trust restriction.
 * @param editingName Explicit edit identity, immutable even for bundled overrides.
 * @returns Validation error, or empty string.
 */
export function personaError(draft: BpxCouncilConfig, candidate: Persona, project: boolean, editingName?: string): string {
	if (project) return "Project config may seat bundled personas only; prompts need global or explicit config.";
	if (editingName && candidate.name !== editingName) return "Existing persona names cannot change.";
	if (!/^[a-z][a-z0-9-]{0,31}$/.test(candidate.name)) return "Name needs lowercase letters, digits or hyphens, starting with a letter; max 32 characters.";
	if (candidate.name === "synthesizer") return "synthesizer is reserved for Council verdict.";
	if (!editingName && (personaLibrary(draft).some(p => p.name === candidate.name) || seatedPersonas(draft).includes(candidate.name) || Object.hasOwn(draft.council?.backends ?? {}, candidate.name))) return "Name already exists. Edit that persona explicitly or choose another name.";
	if (!editingName && !Object.hasOwn(draft.personas ?? {}, candidate.name) && Object.keys(draft.personas ?? {}).length >= 16) return "Persona library allows at most 16 custom definitions.";
	if (editingName && !Object.hasOwn(draft.personas ?? {}, editingName) && Object.keys(draft.personas ?? {}).length >= 16) return "Persona library allows at most 16 custom definitions.";
	if (!["for", "against", "neutral"].includes(candidate.stance)) return "Stance must be for, against or neutral; bias does not force verdict.";
	if (!candidate.systemPrompt.trim() || candidate.systemPrompt.length > 8000) return "Prompt must be nonempty and at most 8000 characters.";
	return "";
}

/** Accept validated candidate into a clone; new candidates optionally seat unless roster is full.
 * @param draft Exact config. @param candidate Reviewed definition. @param project Trust restriction.
 * @param editingName Explicit edit identity. @param seat Seat new persona when capacity permits.
 * @returns New config; throws on invalid candidate without changing input.
 */
export function acceptPersona(draft: BpxCouncilConfig, candidate: Persona, project: boolean, editingName?: string, seat = true): BpxCouncilConfig {
	const error = personaError(draft, candidate, project, editingName);
	if (error) throw new Error(error);
	const next = structuredClone(draft);
	next.personas ??= {};
	next.personas[candidate.name] = { stance: candidate.stance, systemPrompt: candidate.systemPrompt };
	const members = seatedPersonas(draft);
	if (!editingName && seat && members.length < 8) { next.council ??= {}; next.council.members = [...members, candidate.name]; }
	return next;
}

/** Toggle seating while retaining every route and definition.
 * @param draft Config. @param name Library identity. @param project Trust restriction.
 * @returns New config; throws for unknown names or roster bounds.
 */
export function togglePersonaSeat(draft: BpxCouncilConfig, name: string, project: boolean): BpxCouncilConfig {
	if (!personaLibrary(draft).some(p => p.name === name)) throw new Error("Unknown persona; create a definition first.");
	if (project && !DEFAULT_PERSONAS.some(p => p.name === name)) throw new Error("Project config may seat bundled personas only.");
	const members = seatedPersonas(draft);
	const seated = members.includes(name);
	if (seated && members.length === 1) throw new Error("Council needs at least one seated persona.");
	if (!seated && members.length >= 8) throw new Error("Council allows at most eight seated personas.");
	const next = structuredClone(draft); next.council ??= {};
	next.council.members = seated ? members.filter(member => member !== name) : [...members, name];
	return next;
}

/** Remove only an intentional bundled override, never its route or seating.
 * @param draft Config. @param name Bundled identity. @param project Trust restriction.
 * @returns Config clone with builtin definition restored.
 */
export function resetBuiltinPersona(draft: BpxCouncilConfig, name: string, project: boolean): BpxCouncilConfig {
	if (project) throw new Error("Project config cannot edit prompts.");
	if (!DEFAULT_PERSONAS.some(p => p.name === name)) throw new Error("Only bundled personas have builtin prompts.");
	const next = structuredClone(draft);
	if (next.personas) delete next.personas[name];
	return next;
}
