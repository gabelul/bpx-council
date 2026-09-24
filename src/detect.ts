/**
 * detect — auto-detect the best available advisor backend.
 *
 * Override chain: CLI arg --backend > config file > env-var API keys > CLIs on
 * PATH (tool-disabled Claude only), otherwise an explicit error. The goal is safe auto-selection from any
 * host without manual config. ANTHROPIC_API_KEY selects Anthropic HTTP;
 * otherwise a tool-disabled Claude CLI can run. OpenAI HTTP isn't implemented, so
 * OPENAI_API_KEY alone never selects it.
 */

import { accessSync, constants, statSync } from "node:fs";
import { delimiter, join, sep } from "node:path";
import type { CliBackendConfig } from "./backend.js";
import { CLI_BACKENDS, KNOWN_CLI_COMMANDS, imageSupport, unusableReason } from "./cli-registry.js";
import { modelTakesImages } from "./models-list.js";
import type { HttpBackendConfig } from "./http-backend.js";
import type { PreparedImage } from "./attachments.js";
import type { PtyBackendConfig } from "./pty-backend.js";
import { isTmuxAvailable } from "./pty-backend.js";

export type DetectedBackend = CliBackendConfig | HttpBackendConfig | PtyBackendConfig;

/** Run-wide controls applied to explicitly selected seat routes. */
export interface SeatOptions {
	timeoutMs?: number;
	isolate?: boolean;
	images?: string[];
	imageData?: PreparedImage[];
}

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

	// 3. Installed CLI. Codex stays the no-key default with a read-only sandbox.
	const cliDetected = detectFromPath();
	if (cliDetected) return cliDetected;

	throw new Error("No advisor backend detected. Set ANTHROPIC_API_KEY, install Codex or Claude CLI, or select a trusted --backend explicitly.");
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
 * Resolve an optional seat spec without carrying the shared model into it.
 * @param spec - Seat's backend[:model][@effort] override, if set.
 * @param shared - Resolved Solo fallback.
 * @param options - Global timeout, isolation and image inputs for explicit routes.
 * @returns The independent route, or shared backend when no override exists.
 */
export function resolveSeatBackend(
	spec: string | null | undefined,
	shared: DetectedBackend,
	options: SeatOptions = {},
): DetectedBackend {
	let backend = shared;
	if (spec != null) {
		const trimmed = spec.trim();
		if (!trimmed || !trimmed.split(/[:@]/, 1)[0]) throw new Error(`Invalid backend spec: ${JSON.stringify(spec)}`);
		backend = detectBackend(parseBackendArg(trimmed));
		if (options.timeoutMs) backend.timeoutMs = options.timeoutMs;
		if (options.isolate && backend.type === "cli") backend.isolate = true;
	}
	if (options.images?.length) {
		const name = backend.type === "http" ? backend.provider : backend.command;
		const support = backend.type === "tmux" ? undefined : imageSupport(name);
		if (!support) throw new Error(`${name} can't take images in this seat. Use codex or anthropic.`);
		if (support === "attach" && backend.type !== "tmux") {
			backend.images = options.images;
			if (backend.type === "http") backend.imageData = options.imageData;
		}
	}
	return backend;
}

/**
 * Warn when Codex's model catalog confirms a pinned model takes text only.
 * @param backend - Resolved seat route and image paths.
 * @returns Warning text, or undefined when the catalog has no known conflict.
 */
export function textOnlyImageWarning(backend: DetectedBackend): string | undefined {
	if (backend.type !== "cli" || backend.command !== "codex" || !backend.images?.length || !backend.model) return undefined;
	if (modelTakesImages(backend.command, backend.model) !== false) return undefined;
	return `Warning: ${backend.model} takes text only — the image may be ignored. Pick a model with image input.`;
}

/**
 * Label a backend with its selected model and effort for attributed output.
 * @param backend - Resolved advisor route.
 * @returns Human-readable backend:model@effort label.
 */
export function backendLabel(backend: DetectedBackend): string {
	if (backend.type === "http") return backend.model ?? backend.provider ?? "http";
	// CLI/tmux: show the pinned model too when there is one, so a council header
	// reads "codex:gpt-5-codex" rather than a bare "codex".
	const command = (backend as { command?: string }).command ?? backend.type;
	// Custom CLI argv replaces generated --model/effort flags; neither pin is verified.
	if (backend.type === "cli" && backend.args?.length) return command;
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
	// OpenAI HTTP is not implemented; try installed CLIs instead.
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
		// Installed but unusable (amp) is worse than absent: picking it would save a
		// config that fails every consult. Leave it out of the offer entirely.
		if (isOnPath(cmd) && !unusableReason(cmd)) {
			out.push({ name: cmd, kind: "cli", detail: `${CLI_BACKENDS[cmd].label} · on PATH${cmd === "claude" || cmd === "opencode" ? " · tools disabled by preset" : cmd === "codex" ? " · read-only sandbox; can read project files" : " · may run tools (trusted choice)"}` });
		}
	}
	if (process.env.ANTHROPIC_API_KEY) {
		out.push({ name: "anthropic", kind: "http", detail: "ANTHROPIC_API_KEY set" });
	}
	return out;
}

function detectFromPath(): DetectedBackend | undefined {
	// Preserve the no-key Codex path. Its sandbox blocks writes, not reads;
	// a CLI advisor can still inspect project files beyond supplied context.
	if (isOnPath("codex")) return { type: "cli", command: "codex", timeoutMs: 120_000 };
	if (isOnPath("claude")) return { type: "cli", command: "claude", timeoutMs: 120_000 };
	return undefined;
}

/**
 * Is `cmd` runnable from PATH?
 *
 * Inspect PATH in-process: even an executable named `which` in PATH must not
 * run during offline doctor diagnostics. Trusted command paths are checked directly.
 */
export function isOnPath(cmd: string): boolean {
	if (!cmd || cmd.includes("\0") || cmd.startsWith("-")) return false;
	const pathLike = cmd.includes(sep) || (process.platform === "win32" && cmd.includes("/"));
	const candidates = pathLike ? [cmd] : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir || ".", cmd));
	const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";") : [""];
	return candidates.some((candidate) => extensions.some((ext) => {
		try {
			const path = process.platform === "win32" && !candidate.toUpperCase().endsWith(ext.toUpperCase()) ? `${candidate}${ext}` : candidate;
			if (!statSync(path).isFile()) return false;
			accessSync(path, constants.X_OK);
			return true;
		} catch { return false; }
	}));
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
