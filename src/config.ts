/**
 * config — bpx-council configuration.
 *
 * Lives at ~/.bpx-council.json (or a path passed via --config). Defines the
 * advisor model, the backend (CLI like codex/claude, or HTTP), and optional
 * personas for council mode. Kept intentionally minimal for the prototype —
 * the full persona/council config from bpx-consult carries over later.
 */

import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface BackendConfig {
	type: "cli" | "http";
	command?: string;
	args?: string[];
	timeoutMs?: number;
	/** HTTP only: the provider name. */
	provider?: "anthropic" | "openai" | "google";
	/** HTTP only: the model ID. */
	model?: string;
	/** HTTP only: env var name holding the API key. */
	apiKeyEnv?: string;
	/** HTTP only: the API base URL. */
	baseUrl?: string;
}

export interface AdvisorConfig {
	model: string;
	thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
	backend?: BackendConfig;
}

export interface CouncilConfig {
	/**
	 * Persona name → backend spec, e.g. `{ "architect": "codex", "critic": "claude" }`.
	 *
	 * This is what makes council mode actually multi-model. Any persona without
	 * an entry falls back to the shared `solo.backend`, so a config that omits
	 * this behaves exactly as before.
	 */
	backends?: Record<string, string>;
}

export interface BpxCouncilConfig {
	defaultMode: "solo" | "council" | "debate" | "gut-check";
	solo: AdvisorConfig;
	council?: CouncilConfig;
	/** Context window to fit the input to (tokens). Falls back to a per-backend default. */
	contextWindow?: number;
}

export const DEFAULT_CONFIG: BpxCouncilConfig = {
	defaultMode: "solo",
	solo: {
		model: "auto",
		thinkingLevel: "medium",
		// No hardcoded backend — auto-detect at runtime (env vars > CLIs on PATH).
		// See src/detect.ts. Override via ~/.bpx-council.json or --backend.
	},
	contextWindow: 200_000,
};

/** The global config: `~/.bpx-council.json`. */
export function configPath(): string {
	return join(homedir(), ".bpx-council.json");
}

/**
 * The nearest project config, walking up from `cwd` to the git root.
 *
 * A `.bpx-council.json` committed at the repo root gives a whole team the same
 * council without anyone configuring it. Search stops at the git root — we
 * don't wander above the repo into unrelated parents.
 */
export function projectConfigPath(cwd: string): string | undefined {
	let dir = cwd;
	for (;;) {
		const candidate = join(dir, ".bpx-council.json");
		if (existsSync(candidate)) return candidate;
		if (existsSync(join(dir, ".git"))) return undefined; // repo root, none found
		const parent = dirname(dir);
		if (parent === dir) return undefined; // filesystem root
		dir = parent;
	}
}

/** Where `config --scope project` writes: `.bpx-council.json` at the git root (or cwd). */
export function projectConfigWritePath(cwd: string): string {
	let dir = cwd;
	for (;;) {
		if (existsSync(join(dir, ".git"))) return join(dir, ".bpx-council.json");
		const parent = dirname(dir);
		if (parent === dir) return join(cwd, ".bpx-council.json"); // not a repo → cwd
		dir = parent;
	}
}

function readConfigFile(path: string): Partial<BpxCouncilConfig> | undefined {
	if (!existsSync(path)) return undefined;
	try {
		return JSON.parse(readFileSync(path, "utf-8")) as Partial<BpxCouncilConfig>;
	} catch {
		return undefined;
	}
}

/**
 * Layer one config partial over another.
 *
 * `over` wins. `solo` merges key-by-key so a project can override just the model
 * (and `solo.backend` is atomic — a cli backend never half-merges with an http
 * one). `council.backends` merges per-persona, so a project can reassign one
 * persona and inherit the rest. Everything else is a plain override.
 */
export function mergeConfigs(base: BpxCouncilConfig, over: Partial<BpxCouncilConfig>): BpxCouncilConfig {
	const merged: BpxCouncilConfig = {
		...base,
		...over,
		solo: { ...base.solo, ...over.solo },
	};
	const backends = { ...base.council?.backends, ...over.council?.backends };
	if (Object.keys(backends).length > 0) merged.council = { backends };
	else if (base.council || over.council) merged.council = over.council ?? base.council;
	return merged;
}

/**
 * The effective config for a run: defaults ← global ← project (each layered).
 *
 * An explicit `--config <path>` replaces discovery — that one file, over the
 * defaults. Otherwise global `~/.bpx-council.json` layers over the defaults, and
 * a discovered project `.bpx-council.json` layers over that. Unparseable files
 * are skipped, never fatal — a bad config shouldn't stop you asking a question.
 */
export function resolveConfig(explicitPath: string | undefined, cwd: string): BpxCouncilConfig {
	if (explicitPath) {
		return mergeConfigs(DEFAULT_CONFIG, readConfigFile(explicitPath) ?? {});
	}
	let config = DEFAULT_CONFIG;
	const global = readConfigFile(configPath());
	if (global) config = mergeConfigs(config, global);
	const projectPath = projectConfigPath(cwd);
	if (projectPath) {
		const project = readConfigFile(projectPath);
		if (project) config = mergeConfigs(config, project);
	}
	return config;
}

/**
 * Back-compat shim: the old global-or-explicit loader, now with project
 * discovery layered in. Prefer resolveConfig directly.
 */
export function loadConfig(path?: string, cwd: string = process.cwd()): BpxCouncilConfig {
	return resolveConfig(path, cwd);
}
