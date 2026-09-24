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
import { preparedImagesError } from "./attachments.js";
import { cliSpecOrGeneric } from "./cli-registry.js";
import { callHttpAdvisor, type HttpBackendConfig } from "./http-backend.js";
import { callPtyAdvisor, type PtyBackendConfig } from "./pty-backend.js";

export type BackendConfig = CliBackendConfig | HttpBackendConfig | PtyBackendConfig;

export interface CliBackendConfig {
	type: "cli";
	command: string;
	args?: string[];
	timeoutMs?: number;
	/** Optional per-call stdout byte cap; doctor probe uses a small bound. */
	maxStdoutBytes?: number;
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
	/**
	 * Cut the advisor off from the project's own agent instructions.
	 *
	 * Both codex and claude read AGENTS.md / CLAUDE.md from the working directory,
	 * so without this a second opinion arrives already following the house rules
	 * of the project it's reviewing. Backends that don't read them, or give us no
	 * way to stop it, ignore this.
	 */
	isolate?: boolean;
}

export interface ProviderUsage {
	/** Anthropic input_tokens excludes cached input. */
	inputTokens: number;
	outputTokens: number;
	cacheCreationInputTokens?: number;
	cacheReadInputTokens?: number;
}

export interface BackendResult {
	ok: boolean;
	text: string;
	error?: string;
	/** Provider-reported only; absent means unknown, including CLI calls. */
	usage?: ProviderUsage;
}

/** Build subprocess-only OpenCode advisor config without erasing provider settings. */
export function openCodeAdvisorEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
	let base: Record<string, unknown> = {};
	if (env.OPENCODE_CONFIG_CONTENT) {
		let parsed: unknown;
		try { parsed = JSON.parse(env.OPENCODE_CONFIG_CONTENT); }
		catch { throw new Error("OPENCODE_CONFIG_CONTENT is invalid JSON; refusing to replace it"); }
		if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("OPENCODE_CONFIG_CONTENT must be a JSON object");
		base = parsed as Record<string, unknown>;
	}
	const permission = Object.fromEntries(["*", "read", "bash", "edit", "glob", "grep", "webfetch", "websearch", "task", "skill", "lsp"].map((key) => [key, "deny"]));
	const agents = base.agent && typeof base.agent === "object" && !Array.isArray(base.agent)
		? base.agent as Record<string, unknown> : {};
	return {
		...env,
		OPENCODE_PERMISSION: JSON.stringify(permission),
		OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...base, agent: { ...agents, "bpx-council": {
			description: "Answer supplied context without tools.", mode: "primary", permission,
		} } }),
	};
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
 * Return a known transport failure without making a provider call.
 * Multi-seat modes check every resolved route before starting any seat.
 * @param backend - Resolved seat transport and image inputs.
 * @returns Failure reason, or undefined when dispatch can proceed.
 */
export function advisorTransportError(backend: BackendConfig): string | undefined {
	if (backend.type === "cli") {
		const unusable = cliSpecOrGeneric(backend.command).unusable;
		if (unusable) return `${backend.command} can't be used as an advisor. ${unusable}`;
		if (backend.images?.length && backend.args?.length) {
			return `${backend.command} custom CLI args cannot safely attach images; remove args to use generated image flags`;
		}
	}
	if (backend.type === "http") {
		if (backend.provider === "openai" || backend.provider === "google") return `HTTP backend for ${backend.provider} not yet implemented. Use a CLI backend.`;
		if (backend.provider !== "anthropic") return `Unknown provider: ${backend.provider}`;
		const imageError = preparedImagesError(backend.images, backend.imageData);
		if (imageError) return imageError;
		const keyEnv = backend.apiKeyEnv ?? "ANTHROPIC_API_KEY";
		if (!process.env[keyEnv]) return `No API key found in $${keyEnv}. Set it or use a CLI backend.`;
	}
	return undefined;
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
	const transportError = advisorTransportError(backend);
	if (transportError) return Promise.resolve({ ok: false, text: "", error: transportError });
	const spec = cliSpecOrGeneric(command);
	// Explicit args win outright; otherwise build from the registry, injecting the
	// pinned model as the CLI's own flag.
	const baseArgs = backend.args?.length
		? backend.args
		: spec.runArgs({
				model: backend.model,
				effort: backend.effort,
				images: backend.images,
				isolate: backend.isolate,
				systemPrompt,
			});
	const timeoutMs = backend.timeoutMs ?? 120_000;
	// When the persona went in as a real system prompt (claude, isolated), sending
	// it again on stdin would just duplicate it — so the body is the question alone.
	const personaInArgs = backend.isolate === true && spec.isolation === "system-prompt" && !backend.args?.length;
	const promptText = personaInArgs ? `${userMessage}\n` : `${systemPrompt}\n\n---\n\n=== User ===\n${userMessage}\n`;
	// stdin CLIs read the prompt off the pipe; arg CLIs want it as the last argv
	// entry (the value of their trailing -p/-x, or a positional prompt).
	const viaArg = spec.prompt === "arg";
	const args = viaArg ? [...baseArgs, promptText] : baseArgs;
	const jsonl = backend.args?.length
		? command === "codex" ? args.includes("--json") : command === "opencode" ? args.some((arg, i) => arg === "--format" && args[i + 1] === "json") : false
		: Boolean(spec.jsonl);
	let env: NodeJS.ProcessEnv | undefined;
	try { if (command === "opencode" && !backend.args?.length) env = openCodeAdvisorEnv(); }
	catch (e) { return Promise.resolve({ ok: false, text: "", error: e instanceof Error ? e.message : String(e) }); }

	return new Promise((resolve) => {
		let stdout = "";
		let stdoutBytes = 0;
		let stderrBytes = 0;
		let failed: string | undefined;
		let child;

		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32", env });
		} catch (e) {
			resolve({ ok: false, text: "", error: `Failed to spawn "${command}"` });
			return;
		}

		const signal = (name: NodeJS.Signals) => {
			try {
				if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
				else child.kill(name);
			} catch { /* Already exited. */ }
		};
		let cleanupDone = false;
		let closed = false;
		let force: ReturnType<typeof setTimeout> | undefined;
		let fallback: ReturnType<typeof setTimeout> | undefined;
		const finishFailure = () => {
			if (cleanupDone && closed && failed) {
				if (fallback) clearTimeout(fallback);
				resolve({ ok: false, text: "", error: failed });
			}
		};
		const stop = (reason: string) => {
			if (failed) return;
			failed = reason;
			clearTimeout(timer);
			child.stdin?.destroy();
			signal("SIGTERM");
			// Keep this timer after parent close: a descendant may still own the pipe.
			force = setTimeout(() => {
				signal("SIGKILL");
				cleanupDone = true;
				fallback = setTimeout(() => {
					child.stdout?.destroy();
					child.stderr?.destroy();
					resolve({ ok: false, text: "", error: failed });
				}, 1000);
				fallback.unref();
				finishFailure();
			}, 1000);
		};
		const timer = setTimeout(() => stop(`"${command}" timed out after ${timeoutMs}ms`), timeoutMs);
		const MAX_STDOUT = backend.maxStdoutBytes ?? 4 * 1024 * 1024;
		const MAX_STDERR = 64 * 1024;
		child.stdout?.on("data", (d: Buffer) => {
			stdoutBytes += d.length;
			if (stdoutBytes > MAX_STDOUT) stop(`"${command}" stdout exceeded ${MAX_STDOUT} bytes`);
			else stdout += d.toString();
		});
		child.stderr?.on("data", (d: Buffer) => {
			stderrBytes += d.length;
			if (stderrBytes > MAX_STDERR) stop(`"${command}" stderr exceeded ${MAX_STDERR} bytes`);
			// Never put CLI stderr (which may echo prompt or secrets) into a receipt.
		});
		child.on("error", (e) => {
			if (!failed) stop(`"${command}" subprocess failed`);
		});
		child.on("close", (code, signalName) => {
			closed = true;
			clearTimeout(timer);
			if (failed) {
				finishFailure();
				return;
			}
			if (force) clearTimeout(force);
			if (fallback) clearTimeout(fallback);
			if (code === null) {
				resolve({ ok: false, text: "", error: `"${command}" terminated by signal ${signalName ?? "unknown"}` });
				return;
			}
			if (code !== 0) {
				resolve({ ok: false, text: "", error: `"${command}" exited ${code}` });
				return;
			}
			const text = parseCliOutput(stdout, command, jsonl);
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
export function parseCliOutput(stdout: string, command: string, jsonl = Boolean(cliSpecOrGeneric(command).jsonl)): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";

	if (jsonl) {
		const collected: string[] = [];
		for (const line of trimmed.split("\n")) {
			const l = line.trim();
			if (!l.startsWith("{")) continue;
			try {
				const parsed = JSON.parse(l);
				const t = command === "codex"
					? parsed?.type === "item.completed" && parsed?.item?.type === "agent_message" ? parsed.item.text : undefined
					: parsed?.type === "text" ? parsed?.part?.text : undefined;
				if (typeof t === "string" && t.trim()) collected.push(t);
			} catch { /* junk preamble */ }
		}
		return collected.join("\n");
	}

	// Plain mode belongs to the advisor, even when its answer is valid JSON.
	// Event filtering applies only to backends explicitly requesting JSONL.
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
	return callHttpAdvisor(systemPrompt, userMessage, backend, backend.timeoutMs);
}
