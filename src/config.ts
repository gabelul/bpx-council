/**
 * config — bpx-council configuration.
 *
 * Lives at ~/.bpx-council.json (or a path passed via --config). Defines the
 * advisor model, the backend (CLI like codex/claude, or HTTP), and optional
 * personas for council mode. Kept intentionally minimal for the prototype —
 * the full persona/council config from bpx-consult carries over later.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync, existsSync } from "node:fs";

export interface BackendConfig {
	type: "cli" | "http";
	command?: string;
	args?: string[];
	timeoutMs?: number;
	/** HTTP only: the API base URL. */
	baseUrl?: string;
	/** HTTP only: env var name holding the API key. */
	apiKeyEnv?: string;
}

export interface AdvisorConfig {
	model: string;
	thinkingLevel?: "minimal" | "low" | "medium" | "high" | "xhigh";
	backend?: BackendConfig;
}

export interface BpxCouncilConfig {
	defaultMode: "solo" | "council" | "debate" | "gut-check";
	solo: AdvisorConfig;
	/** Context window to fit the input to (tokens). Falls back to a per-backend default. */
	contextWindow?: number;
}

const DEFAULT_CONFIG: BpxCouncilConfig = {
	defaultMode: "solo",
	solo: {
		model: "codex",
		thinkingLevel: "medium",
		backend: { type: "cli", command: "codex", timeoutMs: 120_000 },
	},
	contextWindow: 200_000,
};

export function configPath(): string {
	return join(homedir(), ".bpx-council.json");
}

export function loadConfig(path?: string): BpxCouncilConfig {
	const file = path ?? configPath();
	if (!existsSync(file)) return DEFAULT_CONFIG;
	try {
		const raw = JSON.parse(readFileSync(file, "utf-8"));
		return { ...DEFAULT_CONFIG, ...raw };
	} catch {
		return DEFAULT_CONFIG;
	}
}
