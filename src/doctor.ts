/** Offline route diagnostics and an explicitly requested, single-call smoke probe. */
import { existsSync } from "node:fs";
import { configPath, projectConfigPath, resolveConfig, type BpxCouncilConfig } from "./config.js";
import { callAdvisor, type BackendConfig } from "./backend.js";
import { backendLabel, detectBackend, isOnPath, parseBackendArg, resolveSeatBackend } from "./detect.js";
import { unusableReason } from "./cli-registry.js";
import { DEFAULT_PERSONAS } from "./personas.js";

/** Limit untrusted path/model text to one printable line. Never show argv, keys or responses. */
function display(value: string): string {
	return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?").slice(0, 180);
}

/** Classify local evidence only; installed binaries and present keys are not proof of authentication. */
export function routeStatus(backend: BackendConfig): string {
	if (backend.type === "http") {
		if (backend.provider !== "anthropic") return "unavailable (HTTP provider not implemented)";
		const keyPresent = Boolean(process.env[backend.apiKeyEnv ?? "ANTHROPIC_API_KEY"]);
		return keyPresent ? "API key present; authentication unverified" : "unavailable (API key absent)";
	}
	if (backend.type === "tmux") {
		return isOnPath("tmux") && isOnPath(backend.command)
			? "tmux + CLI available; authentication unverified"
			: "unavailable (tmux or CLI absent)";
	}
	if (unusableReason(backend.command)) return "unavailable (CLI cannot run as advisor)";
	return isOnPath(backend.command)
		? "executable available; authentication unverified"
		: "unavailable (executable absent)";
}

/** Resolve modes with consult's seat precedence, without spawning or querying models. */
export function doctorRoutes(config: BpxCouncilConfig): Array<{ seat: string; backend?: BackendConfig; error?: string; source: string }> {
	let shared = config.solo.backend as BackendConfig | undefined;
	if (!shared) {
		try { shared = detectBackend(); }
		catch { /* No auto route: report unresolved seats rather than guessing. */ }
	}
	if (shared) {
		shared = { ...shared };
		shared.model = process.env.BPX_COUNCIL_MODEL ?? process.env.ANTHROPIC_MODEL ?? shared.model;
		if (shared.type === "http" && !shared.model && shared.provider === "anthropic") {
			shared.model = (detectBackend(parseBackendArg("anthropic")) as typeof shared).model;
		}
		if (shared.type === "cli" && !shared.effort && config.solo.thinkingLevel) shared.effort = config.solo.thinkingLevel;
	}
	const rows: Array<{ seat: string; backend?: BackendConfig; error?: string; source: string }> = [];
	const add = (seat: string, spec?: string | null) => {
		const source = seat === "Solo" ? config.solo.backend ? "configured" : "auto-detected"
			: spec === null ? "reset to Solo" : spec === undefined ? "inherited Solo" : "configured seat";
		if (!shared) { rows.push({ seat, error: "unresolved (no Solo fallback)", source }); return; }
		try { rows.push({ seat, backend: resolveSeatBackend(spec, shared), source }); }
		catch { rows.push({ seat, error: "invalid or unsupported route", source }); }
	};
	add("Solo");
	add("Gut-check", config.gutCheck?.backend);
	const roster = config.council?.members ?? DEFAULT_PERSONAS.map((persona) => persona.name);
	const known = new Set([...DEFAULT_PERSONAS.map((persona) => persona.name), ...Object.keys(config.personas ?? {})]);
	for (const name of roster) {
		if (!known.has(name)) rows.push({ seat: `Council/${name}`, error: "unknown council persona", source: "configured roster" });
		else add(`Council/${name}`, config.council?.backends?.[name]);
	}
	add("Council/synthesizer", config.council?.synthesizer);
	add("Debate/advocate", config.debate?.advocate);
	add("Debate/critic", config.debate?.critic);
	add("Debate/synthesizer", config.debate?.synthesizer);
	return rows;
}

/** Print offline report; optionally run one safe Solo call after cost warning. */
export async function runDoctor(configFile: string | undefined, cwd: string, probe: boolean): Promise<number> {
	const global = configPath();
	const project = configFile ? undefined : projectConfigPath(cwd);
	console.log("bpx-council doctor (offline diagnostics)");
	console.log(configFile ? `Trusted config: ${display(configFile)}` :
		`Global config: ${existsSync(global) ? "loaded" : "absent"}; project config: ${project ? `discovered (${display(project)})` : "absent"}`);
	let config: BpxCouncilConfig;
	try { config = resolveConfig(configFile, cwd); }
	catch (error) {
		const message = error instanceof Error ? error.message : "config unreadable";
		const reason = message.replace(/^.*?: /, "");
		console.error(`Config error: ${display(reason)}`);
		return 1;
	}
	console.log(`Default mode: ${config.defaultMode}`);
	console.log("Routes (presence only; no authentication tested):");
	const routes = doctorRoutes(config);
	for (const { seat, backend, error, source } of routes) {
		const label = backend?.type === "http" ? `${backend.provider}:${backendLabel(backend)}` : backend ? backendLabel(backend) : undefined;
		console.log(`  ${display(seat)}: ${backend ? `${display(label!)} — ${routeStatus(backend)}` : error} (${source})`);
	}
	if (!probe) return routes.some((row) => row.error || (row.backend && routeStatus(row.backend).startsWith("unavailable"))) ? 1 : 0;
	if (routes.some((row) => row.error)) {
		console.error("Probe skipped: resolve config and seat errors first.");
		return 1;
	}
	const solo = routes[0].backend;
	if (!solo || routeStatus(solo).startsWith("unavailable")) {
		console.error("Probe skipped: Solo route unavailable.");
		return 1;
	}
	// Only Codex's read-only preset, Claude's tool-disabled preset, and the
	// built-in Anthropic endpoint. Custom args/endpoints may execute more.
	if ((solo.type === "cli" && (!["codex", "claude"].includes(solo.command) || solo.args?.length)) ||
		(solo.type === "http" && (solo.provider !== "anthropic" || solo.baseUrl || solo.apiKeyEnv)) || solo.type === "tmux") {
		console.error("Probe skipped: route has no bounded, tool-disabled smoke preset. Use a supported Solo route.");
		return 1;
	}
	const probeLabel = solo.type === "http" ? `${solo.provider}:${backendLabel(solo)}` : backendLabel(solo);
	console.log(`Probe route: ${display(probeLabel)}. One advisor call; may charge API credits or subscription quota.`);
	const bounded: BackendConfig = solo.type === "http"
		? { ...solo, images: undefined, imageData: undefined, timeoutMs: 10_000, maxOutputTokens: 32 }
		: { ...solo, images: undefined, timeoutMs: 10_000, maxStdoutBytes: 8 * 1024, isolate: true };
	let result;
	try { result = await callAdvisor("Reply with OK only. Do not use tools.", "Reply OK.", bounded); }
	catch { console.error("Probe failed (no response details shown)."); return 1; }
	if (!result.ok) {
		console.error("Probe failed (no response details shown). Check route, login and model settings.");
		return 1;
	}
	console.log("Probe response received. Authentication and model selection are not independently verified.");
	return 0;
}
