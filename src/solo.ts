/**
 * solo — the default council mode. One advisor model, one response.
 *
 * Takes a question + optional context, fits the context to the advisor's
 * window, calls the advisor (via CLI backend or HTTP), returns the verdict.
 *
 * This is the prototype — it proves the concept end-to-end. Council mode
 * (parallel multi-model) and debate mode layer on top once the solo path is
 * proven.
 */

import { spawn } from "node:child_process";
import type { BpxCouncilConfig } from "./config.js";

export interface SoloInput {
	question: string;
	context?: string;
	config: BpxCouncilConfig;
}

export type SoloResult = { ok: true; text: string } | { ok: false; error: string };

const ADVISOR_SYSTEM_PROMPT =
	"You are an advisor model consulted by a coding agent. The user message contains " +
	"a question (and optionally conversation context). Return a concrete, actionable " +
	"recommendation — a PLAN, a CORRECTION, or a STOP signal. Be direct, cite specifics, " +
	"and never hedge. If you don't know, say so.";

/**
 * Run a solo consult. Builds the prompt (system + question + context), calls
 * the advisor via its configured backend, returns the verdict.
 */
export async function runSolo(input: SoloInput): Promise<SoloResult> {
	const { question, context, config } = input;
	const backend = config.solo.backend;

	if (!backend) {
		return { ok: false, error: "No backend configured for the solo advisor." };
	}

	// Build the user message: question + optional context.
	const userMessage = context
		? `=== Context ===\n${context}\n\n=== Question ===\n${question}`
		: question;

	if (backend.type === "cli") {
		return runCliAdvisor(backend, userMessage, config.solo.thinkingLevel);
	}

	// HTTP backend: TODO (prototype uses CLI only).
	return { ok: false, error: "HTTP backend not yet implemented. Use a CLI backend (codex/claude/opencode)." };
}

// ---------------------------------------------------------------------------
// CLI backend — spawn the advisor CLI, pipe the prompt to stdin, parse reply.
// ---------------------------------------------------------------------------

async function runCliAdvisor(
	backend: NonNullable<BpxCouncilConfig["solo"]["backend"]>,
	userMessage: string,
	_thinkingLevel?: string,
): Promise<SoloResult> {
	const command = backend.command ?? "codex";
	const presetArgs: Record<string, string[]> = {
		codex: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
		claude: ["-p"],
		opencode: ["exec", "--sandbox", "read-only", "--skip-git-repo-check", "-"],
	};
	const args = backend.args?.length ? backend.args : presetArgs[command] ?? [];
	const timeoutMs = backend.timeoutMs ?? 120_000;
	const promptText = `${ADVISOR_SYSTEM_PROMPT}\n\n---\n\n=== User ===\n${userMessage}\n`;

	return new Promise((resolve) => {
		let stdout = "";
		let stderr = "";
		let child;

		try {
			child = spawn(command, args, { stdio: ["pipe", "pipe", "pipe"] });
		} catch (e) {
			resolve({ ok: false, error: `Failed to spawn "${command}": ${e instanceof Error ? e.message : String(e)}` });
			return;
		}

		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			resolve({ ok: false, error: `"${command}" timed out after ${timeoutMs}ms` });
		}, timeoutMs);

		child.stdout?.on("data", (d) => { stdout += d.toString(); });
		child.stderr?.on("data", (d) => { stderr += d.toString(); });
		child.on("error", (e) => {
			clearTimeout(timer);
			resolve({ ok: false, error: `"${command}" failed: ${e.message}` });
		});
		child.on("close", (code) => {
			clearTimeout(timer);
			if (code !== 0 && code !== null) {
				resolve({ ok: false, error: `"${command}" exited ${code}: ${(stderr || stdout).slice(0, 200)}` });
				return;
			}
			const text = parseCliOutput(stdout, command);
			if (!text.trim()) {
				resolve({ ok: false, error: `"${command}" returned no usable output.` });
				return;
			}
			resolve({ ok: true, text: text.trim() });
		});

		child.stdin?.on("error", () => {});
		child.stdin?.end(promptText);
	});
}

/**
 * Parse CLI stdout into advisor text. Codex/opencode emit JSONL; claude emits
 * plain text. Tolerant of junk preamble (deprecation notices, auth chatter).
 * Lifted from bpx-consult's cli-backend.ts — same defensive parsing.
 */
function parseCliOutput(stdout: string, command: string): string {
	const trimmed = stdout.trim();
	if (!trimmed) return "";

	// JSONL producers (codex, opencode): scan lines for text payloads.
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
