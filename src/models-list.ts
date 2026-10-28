/**
 * models-list — selectable model choices, from presets or live catalogs.
 *
 * Claude offers static aliases, resolved by Claude when run, not an account
 * catalog. Live sources are a CLI's own list command (codex `debug models`,
 * opencode/crush/cursor-agent `models`) or the Anthropic HTTP Models API.
 * CLI presets, list commands and parsers live in cli-registry. Backends with
 * neither presets nor a list (gemini, qwen, amp) fall back to free text.
 *
 * Any failure returns an empty list; the caller then degrades to free-text
 * rather than erroring.
 */

import { getSdkProviderService } from "./sdk-provider-service.js";
import { isSdkProviderId } from "./sdk-route.js";
import { spawn, execFileSync } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { preparePiInvocation, parsePiModels } from "./pi-backend.js";
import { cliSpec, codexModelTakesImages, parseCodexEfforts, parseCodexModels, parseLineList } from "./cli-registry.js";

// Re-exported for tests and callers that want the pure parsers without the
// registry indirection.
export { codexModelTakesImages, parseCodexEfforts, parseCodexModels, parseLineList, parsePiModels };
/** @deprecated name kept for existing imports — opencode/crush/cursor share this. */
export const parseOpencodeModels = parseLineList;

/**
 * The reasoning levels a backend accepts, and its default — or null when it has
 * no effort control at all.
 *
 * codex is asked about the specific model, since its catalog reports levels per
 * model; everything else uses the registry's static list. Any failure falls back
 * to the static list rather than blocking the wizard.
 * @param name - Registered backend name.
 * @param model - Optional model ID for per-model effort lookup.
 * @param signal - Optional cancellation for dynamic discovery.
 * @returns Supported levels/default, static fallback on failure, or null without effort control.
 */
export async function listEfforts(name: string, model?: string, signal?: AbortSignal): Promise<{ levels: string[]; def?: string } | null> {
	if (name.startsWith("sdk:")) {
		if (signal?.aborted || !isSdkProviderId(name.slice(4)) || !model) return null;
		try {
			const found = getSdkProviderService().catalog(name.slice(4)).find((entry) => entry.id === model);
			return found ? { levels: [...found.thinkingLevels] } : null;
		} catch { return null; }
	}
	const spec = cliSpec(name);
	if (!spec?.effort) return null;
	if (spec.effort.perModel && spec.list) {
		try {
			const out = await runListCommand(spec.command, spec.list.args, signal);
			const found = out === null ? null : parseCodexEfforts(JSON.parse(out), model);
			if (found) return found;
		} catch {
			// Fall through to the static list.
		}
	}
	return { levels: spec.effort.levels };
}

/**
 * Does this backend/model combination accept images? null when we can't tell.
 *
 * Only codex publishes this per model, so everything else answers null and the
 * caller falls back to the registry's coarser "does this backend do images at
 * all" flag.
 */
export function modelTakesImages(name: string, model?: string): boolean | null {
	if (name !== "codex" || !model) return null;
	const spec = cliSpec(name);
	if (!spec?.list) return null;
	try {
		const out = execFileSync(spec.command, spec.list.args, { encoding: "utf-8", timeout: 15_000 });
		return codexModelTakesImages(JSON.parse(out), model);
	} catch {
		return null;
	}
}

/** Does this backend offer selectable presets or a live catalog? Otherwise use free text. */
export function backendListsModels(name: string): boolean {
	if (name.startsWith("sdk:")) return isSdkProviderId(name.slice(4));
	const spec = cliSpec(name);
	return Boolean(spec?.list || spec?.modelPresets?.length) || name === "anthropic";
}

/** Pull model IDs out of the Anthropic Models API response. */
export function parseAnthropicModels(body: unknown): string[] {
	const data = (body as { data?: Array<{ id?: unknown }> })?.data ?? [];
	return data.map((m) => m.id).filter((id): id is string => typeof id === "string");
}

/**
 * List selectable model choices, or `[]` if cancelled, unsupported or unavailable.
 *
 * Presets return a fresh copy without I/O. Live CLI catalogs run the registry's
 * list command; anthropic hits the HTTP Models API. Everything else returns `[]`.
 * Pi's private cwd excludes project settings: its catalog is global auth-filtered,
 * extension-disabled chat models, not the parent session or subscription entitlement.
 * @param name - Registered backend name.
 * @param signal - Optional cancellation for model discovery.
 * @returns Model aliases/IDs, or an empty list for manual entry when discovery fails.
 */
export async function listModels(name: string, signal?: AbortSignal): Promise<string[]> {
	if (signal?.aborted) return [];
	try {
		if (name.startsWith("sdk:")) return isSdkProviderId(name.slice(4)) ? getSdkProviderService().catalog(name.slice(4)).map((entry) => entry.id) : [];
		const spec = cliSpec(name);
		if (spec?.modelPresets) return [...spec.modelPresets];
		if (spec?.list) {
			const out = await runListCommand(spec.command, spec.list.args, signal);
			return out === null ? [] : spec.list.parse(out);
		}
		if (name === "anthropic") {
			return await listAnthropicModels(signal);
		}
	} catch {
		// Subprocess failed, bad JSON, network down, whatever — degrade to free text.
	}
	return [];
}

/**
 * Run a model-list subprocess without blocking the terminal or exposing CLI stderr.
 * @param command - Registered CLI binary.
 * @param args - Registry's guarded list argv.
 * @param signal - Optional caller cancellation.
 * @returns Private parser input (Pi includes its metadata stderr), or null on failure.
 */
async function runListCommand(command: string, args: string[], signal?: AbortSignal): Promise<string | null> {
	if (signal?.aborted) return null;
	let pi: ReturnType<typeof preparePiInvocation> | undefined;
	try { if (command === "pi") pi = preparePiInvocation(""); }
	catch { return null; }
	const argv = pi ? args.map((arg, i) => args[i - 1] === "--system-prompt" ? pi.systemPromptFile : arg) : args;
	try {
		return await new Promise<string | null>((resolve) => {
			let stopped = false;
			let settled = false;
			let force: ReturnType<typeof setTimeout> | undefined;
			let timer: ReturnType<typeof setTimeout> | undefined;
			let stdoutBytes = 0;
			let stderrBytes = 0;
			let stdout = "";
			let piStderr = "";
			const decoder = new StringDecoder("utf8");
			const stderrDecoder = new StringDecoder("utf8");
			let child: ReturnType<typeof spawn>;
			/** Signal the whole POSIX group, including descendants retaining output pipes. */
			const kill = (name: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
					else child.kill(name);
				} catch { /* Already exited. */ }
			};
			/** Resolve once and remove cancellation listeners and all pending timers. */
			const finish = (out: string | null) => {
				if (settled) return;
				settled = true;
				clearTimeout(timer);
				clearTimeout(force);
				signal?.removeEventListener("abort", stop);
				resolve(out);
			};
			/** Cancellation waits for group escalation even when the leader exits first. */
			const stop = () => {
				if (stopped || settled) return;
				stopped = true;
				clearTimeout(timer);
				child.stdin?.destroy();
				kill("SIGTERM");
				force = setTimeout(() => {
					kill("SIGKILL");
					child.stdout?.destroy();
					child.stderr?.destroy();
					finish(null);
				}, 1000);
			};
			try {
				child = spawn(command, argv, {
					stdio: ["pipe", "pipe", "pipe"],
					detached: process.platform !== "win32", cwd: pi?.cwd,
				});
			} catch { finish(null); return; }
			child.stdout?.on("data", (chunk: Buffer) => {
				stdoutBytes += chunk.length;
				if (stdoutBytes > 1024 * 1024) stop();
				else if (!stopped) stdout += decoder.write(chunk);
			});
			child.stderr?.on("data", (chunk: Buffer) => {
				stderrBytes += chunk.length;
				if (stderrBytes > (command === "pi" ? 1024 * 1024 : 64 * 1024)) stop();
				// Pi 1.0.0 redirects its metadata console.log to stderr with --print/--mode.
				// Keep this private: only the validated table parser sees it after success.
				else if (command === "pi" && !stopped) piStderr += stderrDecoder.write(chunk);
			});
			child.on("error", stop);
			child.on("close", (code, signalName) => {
				if (!stopped) {
					if (code === 0 && signalName === null) finish(stdout + decoder.end() + (command === "pi" ? `\n${piStderr}${stderrDecoder.end()}` : ""));
					else stop();
				}
			});
			child.stdin?.on("error", () => {});
			child.stdin?.end();
			signal?.addEventListener("abort", stop, { once: true });
			timer = setTimeout(stop, 15_000);
			if (signal?.aborted) stop();
		});
	} finally { pi?.cleanup(); }
}

/** Fetch authenticated Anthropic model IDs, bounded by timeout and caller cancellation. */
async function listAnthropicModels(signal?: AbortSignal): Promise<string[]> {
	const key = process.env.ANTHROPIC_API_KEY;
	if (!key) return [];
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), 5_000);
	try {
		const res = await fetch("https://api.anthropic.com/v1/models?limit=100", {
			headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
			signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		});
		if (!res.ok) return [];
		return parseAnthropicModels(await res.json());
	} finally {
		clearTimeout(timer);
	}
}
