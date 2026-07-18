/**
 * backend — shared CLI subprocess advisor caller.
 *
 * Spawns an advisor CLI (codex/claude/opencode), pipes the prompt to stdin,
 * parses the reply. Used by solo, council (one call per member), and the
 * synthesizer. Tolerant of junk preamble (deprecation notices, auth chatter).
 *
 * Lifted from bpx-consult's cli-backend.ts — same defensive parsing, same
 * spawn-and-pipe pattern, but standalone (no pi dependency).
 */

import { spawn } from "node:child_process";
import { callHttpAdvisor, type HttpBackendConfig } from "./http-backend.js";
import { callPtyAdvisor, type PtyBackendConfig } from "./pty-backend.js";

export type BackendConfig = CliBackendConfig | HttpBackendConfig | PtyBackendConfig;

export interface CliBackendConfig {
	type: "cli";
	command: string;
	args?: string[];
	timeoutMs?: number;
}

export interface BackendResult {
	ok: boolean;
	text: string;
	error?: string;
}

const PRESET_ARGS: Record<string, string[]> = {
	codex: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
	claude: ["-p"],
	opencode: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
};

/**
 * Run one CLI advisor call. Spawns the subprocess, pipes the prompt, collects
 * stdout/stderr, resolves on close. Never throws — failures return {ok:false}.
 */
export function callCliAdvisor(
	systemPrompt: string,
	userMessage: string,
	backend: CliBackendConfig,
): Promise<BackendResult> {
	const command = backend.command;
	const args = backend.args?.length ? backend.args : PRESET_ARGS[command] ?? [];
	const timeoutMs = backend.timeoutMs ?? 120_000;
	const promptText = `${systemPrompt}\n\n---\n\n=== User ===\n${userMessage}\n`;

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
		child.stdin?.end(promptText);
	});
}

/**
 * Parse CLI stdout into advisor text. JSONL producers (codex, opencode) embed
 * the payload in JSON lines; claude emits plain text. Tolerant of junk.
 */
export function parseCliOutput(stdout: string, command: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";

	if (command === "codex" || command === "opencode") {
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
