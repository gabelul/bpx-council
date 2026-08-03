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
import { CLI_BACKENDS, KNOWN_CLI_COMMANDS } from "./cli-registry.js";
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
	effort?: string;
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

/**
 * Turn a backend spec string into an ExplicitBackend.
 *
 * Accepts a known CLI name (codex, claude, opencode, cursor-agent, gemini, …),
 * an HTTP provider (anthropic, openai, google), or a PTY alias (tmux, pty,
 * interactive). Anything else is assumed to be a CLI command name, so a custom
 * advisor binary still works.
 *
 * Lives here rather than in index.ts because council mode resolves one of
 * these per persona, and index.ts runs main() on import.
 */
export function parseBackendArg(arg: string): ExplicitBackend {
	// A `name:model` spec pins a model to this backend, e.g. `codex:gpt-5-codex`
	// or `anthropic:claude-opus-4-8`. Split on the FIRST colon only — model IDs
	// don't contain one, but this stays safe if a future one does.
	// An `@level` suffix pins reasoning effort: `codex:gpt-5.6-sol@max`. Split it
	// off first, from the LAST `@`, so a model id containing one survives.
	const at = arg.lastIndexOf("@");
	const effort = at > 0 ? arg.slice(at + 1) || undefined : undefined;
	const rest = at > 0 ? arg.slice(0, at) : arg;

	const colon = rest.indexOf(":");
	const name = colon === -1 ? rest : rest.slice(0, colon);
	const model = colon === -1 ? undefined : rest.slice(colon + 1) || undefined;

	const http = ["anthropic", "openai", "google"];
	const tmux = ["tmux", "pty", "interactive"];
	if (KNOWN_CLI_COMMANDS.includes(name)) return { type: "cli", command: name, model, effort };
	if (http.includes(name)) return { type: "http", provider: name, model, effort };
	if (tmux.includes(name)) return { type: "tmux", command: "codex", model, effort };
	// Unknown — treat as a CLI command name.
	return { type: "cli", command: name, model, effort };
}

/**
 * A short label for a resolved backend, for display in council output.
 *
 * The whole point of running members on different models is being able to see
 * who said what, so this ends up in the member headers.
 */
export function backendLabel(backend: DetectedBackend): string {
	if (backend.type === "http") return backend.model ?? backend.provider ?? "http";
	// CLI/tmux: show the pinned model too when there is one, so a council header
	// reads "codex:gpt-5-codex" rather than a bare "codex".
	const command = (backend as { command?: string }).command ?? backend.type;
	const model = (backend as { model?: string }).model;
	const effort = (backend as { effort?: string }).effort;
	const base = model ? `${command}:${model}` : command;
	return effort ? `${base}@${effort}` : base;
}

function resolveExplicit(explicit: ExplicitBackend): DetectedBackend {
	if (explicit.type === "cli") {
		// Carry the pinned model through — callCliAdvisor injects it as the CLI's
		// own --model flag. Without a model the CLI uses whatever it's configured
		// for, which is the sensible default (and stays current on its own).
		return { type: "cli", command: explicit.command ?? "codex", model: explicit.model, effort: explicit.effort, timeoutMs: 120_000 };
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

/** A backend the config wizard can actually offer — one that would work. */
export interface AvailableBackend {
	name: string;
	kind: "cli" | "http";
	detail: string;
}

/**
 * Every backend that would actually run on this machine, for the config wizard.
 *
 * Only workable ones: known CLIs on PATH (registry order, codex first), and
 * anthropic-over-HTTP when its key is set. openai/google HTTP are deliberately
 * left out — their HTTP path isn't implemented, so offering them would write a
 * config that errors. (For OpenAI models, the codex CLI is the working route.)
 */
export function availableBackends(): AvailableBackend[] {
	const out: AvailableBackend[] = [];
	for (const cmd of KNOWN_CLI_COMMANDS) {
		if (isOnPath(cmd)) out.push({ name: cmd, kind: "cli", detail: `${CLI_BACKENDS[cmd].label} · on PATH` });
	}
	if (process.env.ANTHROPIC_API_KEY) {
		out.push({ name: "anthropic", kind: "http", detail: "ANTHROPIC_API_KEY set" });
	}
	return out;
}

function detectFromPath(): DetectedBackend | undefined {
	// First known advisor CLI on PATH wins, in registry order (codex first).
	for (const cmd of KNOWN_CLI_COMMANDS) {
		if (isOnPath(cmd)) {
			return { type: "cli", command: cmd, timeoutMs: 120_000 };
		}
	}
	return undefined;
}

/**
 * Is `cmd` runnable from PATH?
 *
 * Exported because the installer detects agent CLIs the same way this module
 * detects advisor CLIs — one `which` wrapper, not two.
 */
export function isOnPath(cmd: string): boolean {
	try {
		execSync(`which ${cmd}`, { stdio: "ignore", timeout: 2000 });
		return true;
	} catch {
		return false;
	}
}

/**
 * The default HTTP model per provider, when none is pinned.
 *
 * Anthropic is the only HTTP backend that's actually implemented, so its default
 * is the one that matters — set to a current model (claude-opus-4-8) rather than
 * a stale one. openai/google are placeholders: their HTTP path returns "not yet
 * implemented", so pin a model explicitly (or use the codex CLI for OpenAI).
 *
 * CLI backends don't come through here — their default model is the CLI's own,
 * which tracks the latest without us hardcoding a version that goes stale.
 */
function defaultModelFor(provider: string): string {
	const defaults: Record<string, string> = {
		anthropic: "claude-opus-4-8",
		openai: "gpt-4o",
		google: "gemini-1.5-pro",
	};
	return defaults[provider] ?? "unknown";
}
