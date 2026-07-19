/**
 * pty-backend — drive a CLI agent (codex/claude) in INTERACTIVE mode via tmux.
 *
 * Subscription-preserving: runs the agent in its interactive TUI (the same mode
 * you use manually), so it draws from subscription quota, not API credits.
 *
 * Patterns adopted from primeline-ai/claude-tmux-orchestration (proven in
 * production): literal send-keys + separate Enter, paste-buffer for multiline,
 * ANSI stripping before parsing, busy/idle detection via spinner/prompt
 * patterns, delivery verification via capture-pane.
 */

import { execSync } from "node:child_process";

export interface PtyBackendConfig {
	type: "tmux";
	command: string; // "codex" | "claude" | "opencode"
	model?: string; // set via /model if specified
	sessionPrefix?: string;
	timeoutMs?: number;
	startupMs?: number;
}

export interface PtyResult {
	ok: boolean;
	text: string;
	error?: string;
}

const DEFAULT_STARTUP_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 2_000;

/** Patterns that indicate the agent is BUSY (processing). */
const BUSY_PATTERNS = /(?:Running|thinking|Searching|Reading|Writing|Editing|Generating|Compiling|Analyzing)/i;

/** Patterns that indicate the agent is IDLE (waiting for input). */
const IDLE_PATTERNS = /(?:❯[\s ]*$|›[\s\S]|>\s*$|waiting for input|claude\s+code\s+v[0-9.]+|codex\s+v[0-9.]+|\$\s*$)/i;

/**
 * Strip ANSI escape sequences from terminal output. Must run BEFORE any regex
 * matching. Covers CSI (cursor/color), OSC (title/hyperlinks), DCS (device
 * control), charset switches, SI/SO control chars.
 *
 * Ported from primeline-ai/claude-tmux-orchestration's strip_ansi().
 */
function stripAnsi(text: string): string {
	return text
		.replace(/\x1b\[[0-9;:?<=>]*[a-zA-Z]/g, "")
		.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "")
		.replace(/\x1bP[^\x1b]*(\x1b\\|$)/g, "")
		.replace(/\x1b[()][0-9A-Za-z]/g, "")
		.replace(/[\x0e\x0f]/g, "");
}

/** Capture the tmux pane content, ANSI-stripped. */
function capturePane(session: string, scrollback = 50): string | undefined {
	try {
		const raw = execSync(`tmux capture-pane -t ${session} -p -S -${scrollback}`, {
			timeout: 3_000, stdio: "pipe",
		}).toString();
		return stripAnsi(raw);
	} catch {
		return undefined;
	}
}

/** Check if the pane is idle (ready for input). */
function isPaneIdle(session: string): boolean {
	const captured = capturePane(session, 12);
	if (!captured) return false;
	// Busy patterns take precedence (spinner overrides idle-looking output).
	if (BUSY_PATTERNS.test(captured)) return false;
	return IDLE_PATTERNS.test(captured);
}

/**
 * Send a prompt to the tmux pane. Uses literal send-keys + separate Enter,
 * and paste-buffer for multiline content (send-keys breaks on newlines).
 * Verifies delivery via capture-pane. Retries up to 3 times.
 */
function sendToPane(session: string, message: string): boolean {
	const bufferName = `bpx-${Date.now()}`;
	for (let attempt = 0; attempt < 3; attempt++) {
		try {
			// Multiline: load-buffer + paste-buffer (clean newline handling).
			// -p = bracket paste mode, -d = delete buffer after paste.
			execSync(`printf '%s' '${message.replace(/'/g, "'\\''")}' | tmux load-buffer -b ${bufferName} -`, {
				timeout: 3_000, stdio: "pipe",
			});
			execSync(`tmux paste-buffer -p -d -b ${bufferName} -t ${session}`, {
				timeout: 3_000, stdio: "pipe",
			});
		} catch {
			// Fallback: literal send-keys (single-line only).
			try {
				const escaped = message.replace(/'/g, "'\\''").replace(/\n/g, " ");
				execSync(`tmux send-keys -t ${session} -l '${escaped}'`, { timeout: 3_000, stdio: "pipe" });
			} catch { continue; }
		}
		// Separate Enter (prevents input-buffer race condition).
		try {
			execSync(`sleep 0.5 && tmux send-keys -t ${session} Enter`, { timeout: 3_000, stdio: "pipe" });
		} catch { /* continue anyway */ }

		// Verify delivery: check the first 40 chars appear in the pane.
		const captured = capturePane(session, 5);
		if (captured && captured.includes(message.slice(0, 40).split("\n")[0])) {
			return true;
		}
	}
	return false;
}

/**
 * Run one advisor call via tmux interactive mode.
 *
 * Flow: spawn agent → wait for boot → set model → send prompt → poll for idle
 * (model finished) → capture + extract response → clean up session.
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
	// --dangerously-skip-permissions: prevents interactive prompts from blocking.
	const bootCmd = command === "claude"
		? `${command} --dangerously-skip-permissions`
		: command;

	// 1. Spawn the agent in a detached tmux session.
	try {
		execSync(`tmux new-session -d -s ${session} '${bootCmd}'`, { timeout: 5_000, stdio: "pipe" });
	} catch (e) {
		return { ok: false, text: "", error: `Failed to start "${command}" in tmux: ${e instanceof Error ? e.message : String(e)}. Is tmux installed?` };
	}

	try {
		// 2. Wait for boot — poll for idle prompt (max startupMs).
		const bootDeadline = Date.now() + startupMs;
		let booted = false;
		while (Date.now() < bootDeadline) {
			await sleep(3_000);
			if (isPaneIdle(session)) { booted = true; break; }
		}
		if (!booted) {
			return { ok: false, text: "", error: `"${command}" didn't reach idle state within ${startupMs / 1000}s.` };
		}

		// Dismiss any welcome/trust prompts (double-Enter protocol).
		tmuxSendKeys(session, "Enter");
		await sleep(500);
		tmuxSendKeys(session, "Enter");
		await sleep(500);

		// 3. Set the model if specified.
		if (backend.model) {
			tmuxSendKeys(session, `-l`, `/${backend.model}`);
			await sleep(500);
			tmuxSendKeys(session, "Enter");
			await sleep(3_000); // let it switch
		}

		// 4. Send the prompt wrapped in a sentinel marker — the sentinel uniquely
		// identifies the response boundary in the captured pane, cutting through
		// boot banner, MCP errors, and hook noise.
		const SENTINEL = "[BPX-COUNCIL-RESPONSE-START]";
		const fullPrompt = `${systemPrompt}\n\n---\n\n${userMessage}\n\n${SENTINEL}`;
		const delivered = sendToPane(session, fullPrompt);
		if (!delivered) {
			return { ok: false, text: "", error: `Failed to deliver prompt to "${command}" after 3 attempts.` };
		}

		// 5. Poll for completion — wait until the pane goes idle again (model
		// finished responding). The busy-then-idle transition is the signal.
		const deadline = Date.now() + timeoutMs;
		let sawBusy = false;
		let response = "";

		while (Date.now() < deadline) {
			await sleep(POLL_INTERVAL_MS);
			const captured = capturePane(session, 100);
			if (!captured) continue;

			// Track the busy → idle transition.
			if (BUSY_PATTERNS.test(captured)) {
				sawBusy = true;
				continue;
			}
			if (sawBusy && IDLE_PATTERNS.test(captured)) {
				// Model was busy, now idle → response complete.
				await sleep(500); // let rendering settle
				response = capturePane(session, 200) ?? "";
				break;
			}
			// Also detect completion via token count change (codex status bar).
			if (/[1-9]\d*\s*(?:out|output)/i.test(captured) && IDLE_PATTERNS.test(captured)) {
				await sleep(500);
				response = capturePane(session, 200) ?? "";
				break;
			}
		}

		if (!response) {
			return { ok: false, text: "", error: `"${command}" timed out after ${timeoutMs / 1000}s.` };
		}

		// 6. Extract the response from the pane.
		const text = extractResponse(response, SENTINEL);
		if (!text.trim()) {
			return { ok: false, text: "", error: `"${command}" responded but output couldn't be parsed.` };
		}
		return { ok: true, text: text.trim() };
	} finally {
		// 7. Clean up.
		try { execSync(`tmux kill-session -t ${session}`, { timeout: 3_000, stdio: "pipe" }); } catch { /* gone */ }
	}
}

/** Raw tmux send-keys (no processing). */
function tmuxSendKeys(session: string, ...args: string[]): void {
	try {
		execSync(`tmux send-keys -t ${session} ${args.map((a) => `'${a}'`).join(" ")}`, {
			timeout: 3_000, stdio: "pipe",
		});
	} catch { /* best effort */ }
}

/**
 * Extract the advisor's response using the sentinel boundary.
 *
 * The sentinel [BPX-COUNCIL-RESPONSE-START] is appended to the prompt. After
 * the agent echoes it, everything between the sentinel and the next idle cursor
 * is the response — minus known noise (hook errors, MCP warnings) that
 * intersperse. This is far more reliable than content-matching the prompt.
 */
function extractResponse(pane: string, sentinel: string): string {
	// Find the sentinel in the captured output.
	const sentinelIdx = pane.lastIndexOf(sentinel);
	if (sentinelIdx === -1) {
		// Sentinel not found — fallback to filtering noise from the whole pane.
		return filterNoise(pane);
	}

	// Take everything after the sentinel.
	const afterSentinel = pane.slice(sentinelIdx + sentinel.length);

	// Cut at the first idle cursor (end of response).
	const cursorMatch = afterSentinel.match(/\n[❯›>]\s/);
	const responseBlock = cursorMatch
		? afterSentinel.slice(0, cursorMatch.index)
		: afterSentinel;

	return filterNoise(responseBlock);
}

/** Filter known noise patterns from a response block. */
function filterNoise(text: string): string {
	const NOISE_PATTERNS = [
		/^\s*[╭╰│─┬┴├┤┐└┘]+.*$/gm, // box-drawing borders
		/^\s*✨.*$/gm, // update notices
		/^\s*(Tip|tip):.*$/gm, // tips
		/^\s*(Update|update) available.*$/gm,
		/^\s*(Run npm|See full) .*$/gm,
		/^\s*>_ .*$/gm, // codex banner (>_ OpenAI Codex)
		/^\s*model:.*$/gm,
		/^\s*directory:.*$/gm,
		/^\s*or directory.*os error.*$/gm,
		/^\s*⚠.*$/gm, // warnings
		/^\s*error: hook exited.*$/gm, // hook errors
		/^\s*• (Session|User|Stop|Post)\w* hook.*$/gm, // hook status lines
		/^\s*MCP (client|server|startup).*$/gm, // MCP errors
		/^\s*\[rmcp::.*$/gm, // rmcp transport errors
		/^\s*can still see.*$/gm, // skill warnings
		/^\s*skills or plugins.*$/gm, // skill warning fragment
		/^\s*You have \d+ usage.*$/gm, // usage notices
		/^\s*---\s*$/gm, // separators
		/^\s*\[BPX-COUNCIL.*$/gm, // our own sentinel
		/^\s*http:\/\/.*$/gm, // URLs from errors
	];

	let cleaned = text;
	for (const pattern of NOISE_PATTERNS) {
		cleaned = cleaned.replace(pattern, "");
	}

	return cleaned
		.split("\n")
		.map((l) => l.replace(/^[•│└├─\s]+/, "").trim())
		.filter(Boolean)
		.join("\n");
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Check if tmux is installed and available on PATH. */
export function isTmuxAvailable(): boolean {
	try {
		execSync("which tmux", { timeout: 2_000, stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}
