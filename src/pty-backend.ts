/**
 * pty-backend — drive a CLI agent (codex/claude) in INTERACTIVE mode via tmux.
 *
 * This is the subscription-preserving backend. Unlike the pipe backend
 * (`codex exec -`, `claude -p`) which may bill from a separate credit pool,
 * the PTY/tmux backend runs the agent in its interactive TUI — the same mode
 * you use manually — so it draws from your subscription quota. Free.
 *
 * Flow: spawn the agent in a tmux session → send the prompt via send-keys →
 * poll capture-pane until the status bar shows non-zero output tokens (the
 * model has responded) → extract the response lines → clean up.
 *
 * Validated by live spike: codex interactive via tmux answered "2+2" correctly
 * on subscription quota (weekly usage, not API credits).
 */

import { execSync } from "node:child_process";

export interface PtyBackendConfig {
	type: "tmux";
	command: string; // "codex" | "claude" | "opencode"
	model?: string; // set via /model if specified
	sessionPrefix?: string; // tmux session name prefix (default: bpx-council)
	timeoutMs?: number; // max wait for response (default: 120s)
	startupMs?: number; // wait for agent to boot (default: 8s)
}

export interface PtyResult {
	ok: boolean;
	text: string;
	error?: string;
}

const DEFAULT_STARTUP_MS = 8_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;
const STABILIZE_MS = 2_000; // extra wait after detection for rendering to settle

/**
 * Run one advisor call via tmux interactive mode. Spawns the agent, sends the
 * prompt, polls for completion, extracts the response. Never throws.
 */
export async function callPtyAdvisor(
	systemPrompt: string,
	userMessage: string,
	backend: PtyBackendConfig,
): Promise<PtyResult> {
	const session = `${backend.sessionPrefix ?? "bpx-council"}-${Date.now()}`;
	const command = backend.command;
	const startupMs = backend.startupMs ?? DEFAULT_STARTUP_MS;
	const timeoutMs = backend.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	// 1. Start the agent in a detached tmux session.
	try {
		execSync(`tmux new-session -d -s ${session} '${command}'`, { timeout: 5_000, stdio: "pipe" });
	} catch (e) {
		return { ok: false, text: "", error: `Failed to start "${command}" in tmux: ${e instanceof Error ? e.message : String(e)}. Is tmux installed?` };
	}

	// 2. Wait for the agent to boot (MCP init, skill loading, etc.).
	await sleep(startupMs);

	try {
		// 3. Set the model if specified (e.g., /model opus for Claude Code).
		if (backend.model) {
			execSync(`tmux send-keys -t ${session} '/model ${backend.model}' Enter`, { timeout: 3_000, stdio: "pipe" });
			await sleep(3_000); // let it switch
		}

		// 4. Send the combined prompt (system + user message).
		const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}`;
		// tmux send-keys with literal text (escape special chars).
		const escaped = fullPrompt.replace(/'/g, "'\\''");
		execSync(`tmux send-keys -t ${session} '${escaped}' Enter`, { timeout: 5_000, stdio: "pipe" });

		// 5. Poll for completion: watch the status bar for non-zero output tokens,
		//    OR the prompt cursor (›) reappearing after the response.
		const deadline = Date.now() + timeoutMs;
		let response = "";

		while (Date.now() < deadline) {
			await sleep(POLL_INTERVAL_MS);
			const pane = capturePane(session);
			if (!pane) continue;

			// Detect completion: status bar shows non-zero "out" tokens (codex)
			// or the prompt cursor reappeared after content (claude/codex).
			const hasOutput = /[1-9]\d*\s*(out|output)/i.test(pane);
			const hasCursor = /›/.test(pane.split("\n").pop() ?? "");

			if (hasOutput || hasCursor) {
				// Wait one more cycle for rendering to settle.
				await sleep(STABILIZE_MS);
				response = capturePane(session) ?? "";
				break;
			}
		}

		if (!response) {
			return { ok: false, text: "", error: `"${command}" timed out after ${timeoutMs}ms — no response detected.` };
		}

		// 6. Extract the response from the captured pane.
		const text = extractResponse(response, fullPrompt);
		if (!text.trim()) {
			return { ok: false, text: "", error: `"${command}" responded but the output couldn't be parsed from the terminal.` };
		}

		return { ok: true, text: text.trim() };
	} finally {
		// 7. Clean up the tmux session.
		try {
			execSync(`tmux kill-session -t ${session}`, { timeout: 3_000, stdio: "pipe" });
		} catch { /* session may already be gone */ }
	}
}

/**
 * Capture the tmux pane content as plain text.
 */
function capturePane(session: string): string | undefined {
	try {
		return execSync(`tmux capture-pane -t ${session} -p`, { timeout: 3_000, stdio: "pipe" }).toString();
	} catch {
		return undefined;
	}
}

/**
 * Extract the advisor's response from the captured terminal pane.
 *
 * The pane contains: boot noise (MCP warnings, hook errors) → the echoed
 * prompt → the response (bullet-prefixed lines in codex, or indented text in
 * claude) → the next prompt cursor (›). We extract everything between the
 * prompt and the cursor.
 */
function extractResponse(pane: string, sentPrompt: string): string {
	const lines = pane.split("\n");

	// Find the line where the prompt was echoed (contains a distinctive fragment).
	const promptFragment = sentPrompt.slice(-60).split("\n")[0].trim();
	const promptLineIdx = lines.findIndex((l) => l.includes(promptFragment.slice(0, 30)));

	if (promptLineIdx === -1) {
		// Fallback: take everything after the last "›" before the prompt cursor.
		// This handles cases where the prompt echo isn't found verbatim.
		return lines
			.filter((l) => l.trim().startsWith("•") || l.trim().startsWith("│"))
			.map((l) => l.replace(/^[•│\s]+/, ""))
			.join("\n");
	}

	// Take lines after the prompt, stop at the next prompt cursor (›) or status bar.
	const responseLines: string[] = [];
	for (let i = promptLineIdx + 1; i < lines.length; i++) {
		const line = lines[i];
		// Stop at the next prompt cursor.
		if (/^›/.test(line.trim())) break;
		// Stop at the status bar (contains "Context" and "left").
		if (/Context.*left/i.test(line)) break;
		// Skip empty lines and bullet markers — keep the content.
		const cleaned = line.replace(/^[•│\s]+/, "").trim();
		if (cleaned) responseLines.push(cleaned);
	}

	return responseLines.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if tmux is installed and available. */
export function isTmuxAvailable(): boolean {
	try {
		execSync("which tmux", { timeout: 2_000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}
