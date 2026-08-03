/**
 * backend — shared CLI subprocess advisor caller.
 *
 * Spawns an advisor CLI (codex/claude/opencode/cursor-agent/gemini/…), hands it
 * the prompt the way that CLI wants it, parses the reply. Used by solo, council
 * (one call per member), and the synthesizer. Tolerant of junk preamble
 * (deprecation notices, auth chatter).
 *
 * How each CLI is driven — args, prompt delivery, output shape — lives in the
 * cli-registry, not here. This file is the spawn-and-pipe machinery; the registry
 * is the per-tool knowledge.
 *
 * Lifted from bpx-consult's cli-backend.ts — same defensive parsing, same
 * spawn-and-pipe pattern, but standalone (no pi dependency).
 */

import { spawn } from "node:child_process";
import { cliSpecOrGeneric } from "./cli-registry.js";
import { callHttpAdvisor, type HttpBackendConfig } from "./http-backend.js";
import { callPtyAdvisor, type PtyBackendConfig } from "./pty-backend.js";

export type BackendConfig = CliBackendConfig | HttpBackendConfig | PtyBackendConfig;

export interface CliBackendConfig {
	type: "cli";
	command: string;
	args?: string[];
	timeoutMs?: number;
	/**
	 * Pin the CLI's model. Injected as that CLI's own `--model` flag (codex,
	 * claude, and opencode all take one). Omit to let the CLI use its configured
	 * default. Ignored when `args` is set — then you're supplying the full args.
	 */
	model?: string;
	/**
	 * Reasoning effort, for CLIs that expose one (codex, claude). Passed as that
	 * tool's own flag; silently ignored by backends with no such control, rather
	 * than guessed at with a flag they'd reject.
	 */
	effort?: string;
	/**
	 * Image paths to send with the prompt. Only reaches backends that take images;
	 * index.ts refuses up front for the ones that don't, rather than dropping them.
	 */
	images?: string[];
}

export interface BackendResult {
	ok: boolean;
	text: string;
	error?: string;
}

/**
 * Build the CLI args (minus the prompt), injecting the model flag when pinned.
 *
 * Delegates to the registry so the per-tool knowledge lives in one place; each
 * CLI takes its model flag in its own spot (codex/opencode after their
 * subcommand, claude/gemini up front). When no model is set, the CLI uses its
 * own configured default.
 */
export function cliArgsFor(command: string, model?: string, effort?: string, images?: string[]): string[] {
	return cliSpecOrGeneric(command).runArgs({ model, effort, images });
}

/**
 * Run one CLI advisor call. Spawns the subprocess, hands over the prompt the way
 * that CLI expects (stdin or trailing arg), collects stdout/stderr, resolves on
 * close. Never throws — failures return {ok:false}.
 */
export function callCliAdvisor(
	systemPrompt: string,
	userMessage: string,
	backend: CliBackendConfig,
): Promise<BackendResult> {
	const command = backend.command;
	const spec = cliSpecOrGeneric(command);
	// Explicit args win outright; otherwise build from the registry, injecting the
	// pinned model as the CLI's own flag.
	const baseArgs = backend.args?.length ? backend.args : spec.runArgs({ model: backend.model, effort: backend.effort, images: backend.images });
	const timeoutMs = backend.timeoutMs ?? 120_000;
	const promptText = `${systemPrompt}\n\n---\n\n=== User ===\n${userMessage}\n`;
	// stdin CLIs read the prompt off the pipe; arg CLIs want it as the last argv
	// entry (the value of their trailing -p/-x, or a positional prompt).
	const viaArg = spec.prompt === "arg";
	const args = viaArg ? [...baseArgs, promptText] : baseArgs;

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child;

		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			resolve({ ok: false, text: "", error: `Failed to spawn "${command}": ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve({ ok: false, text: "", error: `"${command}" timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout?.on("data", (d) => { stdout += d.toString(); });
		child.stderr?.on("data", (d) => { stderr += d.toString(); });
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, text: "", error: `"${command}" failed: ${e.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && code !== null) {
				resolve({ ok: false, text: "", error: `"${command}" exited ${code}: ${(stderr || stdout).slice(0, 200)}` });
				return;
			}
			const text = parseCliOutput(stdout, command);
			resolve(text.trim() ? { ok: true, text: text.trim() } : { ok: false, text: "", error: `"${command}" returned no usable output` });
		});

		child.stdin?.on("error", () => {});
		// stdin CLIs get the prompt on the pipe; arg CLIs already have it in argv,
		// so just close their stdin so they don't block waiting on it.
		child.stdin?.end(viaArg ? "" : promptText);
	});
}

/**
 * Parse CLI stdout into advisor text. JSONL producers (codex, opencode) embed
 * the payload in JSON lines; the rest emit plain text. Tolerant of junk.
 */
export function parseCliOutput(stdout: string, command: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";

	if (cliSpecOrGeneric(command).jsonl) {
		const collected: string[] = [];
		for (const line of trimmed.split("\n")) {
			const l = line.trim();
			if (!l.startsWith("{")) continue;
			try {
				const parsed = JSON.parse(l);
				const t = parsed?.item?.text ?? parsed?.text;
				if (typeof t === "string" && t.trim()) collected.push(t);
			} catch { /* junk preamble */ }
		}
		if (collected.length > 0) return collected.join("\n");
	}

	return trimmed;
}

/**
 * Unified advisor caller — dispatches to CLI or HTTP based on backend type.
 * This is what solo/council/debate use: they don't care whether the advisor is
 * a subprocess or an HTTP call, just that it returns text.
 */
export async function callAdvisor(
	systemPrompt: string,
	userMessage: string,
	backend: BackendConfig,
): Promise<BackendResult> {
	if (backend.type === "cli") {
		return callCliAdvisor(systemPrompt, userMessage, backend);
	}
	if (backend.type === "tmux") {
		return callPtyAdvisor(systemPrompt, userMessage, backend);
	}
	return callHttpAdvisor(systemPrompt, userMessage, backend);
}
