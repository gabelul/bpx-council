/**
 * detect — auto-detect the best available advisor backend.
 *
 * Override chain: CLI arg --backend > config file > env-var API keys > CLIs on
 * PATH > hardcoded default (codex). The goal: bpx-council "just works" from any
 * host without manual config. Claude Code sets ANTHROPIC_API_KEY → bpx-council
 * uses Anthropic HTTP. Codex has the codex CLI on PATH → uses that. Cursor sets
 * OPENAI_API_KEY → uses OpenAI HTTP.
 */

import { execSync } from "node:child_process";
import type { CliBackendConfig } from "./backend.js";
import type { HttpBackendConfig } from "./http-backend.js";
import type { PtyBackendConfig } from "./pty-backend.js";
import { isTmuxAvailable } from "./pty-backend.js";

export type DetectedBackend = CliBackendConfig | HttpBackendConfig | PtyBackendConfig;

export type BackendType = "cli" | "http" | "tmux";

/** What the user explicitly asked for (--backend or config). */
export interface ExplicitBackend {
	type: BackendType;
	provider?: string;
	command?: string;
	model?: string;
}

/**
 * Detect the best backend. Returns a concrete config ready to pass to the
 * appropriate caller (callCliAdvisor or callHttpAdvisor).
 */
export function detectBackend(explicit?: ExplicitBackend): DetectedBackend {
	// 1. Explicit override (CLI arg or config).
	if (explicit) {
		return resolveExplicit(explicit);
	}

	// 2. Env-var API keys (hosts like Claude Code set these).
	const envDetected = detectFromEnv();
	if (envDetected) return envDetected;

	// 3. CLIs on PATH.
	const cliDetected = detectFromPath();
	if (cliDetected) return cliDetected;

	// 4. Hardcoded default.
	return { type: "cli", command: "codex", timeoutMs: 120_000 };
}

function resolveExplicit(explicit: ExplicitBackend): DetectedBackend {
	if (explicit.type === "cli") {
		return { type: "cli", command: explicit.command ?? "codex", timeoutMs: 120_000 };
	}
	if (explicit.type === "tmux") {
		return { type: "tmux", command: explicit.command ?? "codex", model: explicit.model, timeoutMs: 120_000 };
	}
	// HTTP
	const provider = (explicit.provider ?? "anthropic") as HttpBackendConfig["provider"];
	return { type: "http", provider, model: explicit.model ?? defaultModelFor(provider) };
}

function detectFromEnv(): DetectedBackend | undefined {
	// Anthropic (Claude Code sets ANTHROPIC_API_KEY).
	if (process.env.ANTHROPIC_API_KEY) {
		return { type: "http", provider: "anthropic", model: defaultModelFor("anthropic") };
	}
	// OpenAI.
	if (process.env.OPENAI_API_KEY) {
		return { type: "http", provider: "openai", model: defaultModelFor("openai") };
	}
	return undefined;
}

function detectFromPath(): DetectedBackend | undefined {
	// Check for installed advisor CLIs (reverse priority: codex > claude > opencode).
	for (const cmd of ["codex", "claude", "opencode"]) {
		if (isOnPath(cmd)) {
			return { type: "cli", command: cmd, timeoutMs: 120_000 };
		}
	}
	return undefined;
}

function isOnPath(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

function defaultModelFor(provider: string): string {
	const defaults: Record<string, string> = {
		anthropic: "claude-sonnet-4-20250514",
		openai: "gpt-4o",
		google: "gemini-1.5-pro",
	};
	return defaults[provider] ?? "unknown";
}
