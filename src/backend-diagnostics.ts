/** Local backend presence and explicit, bounded version checks. No authentication or model probes. */
import { spawn } from "node:child_process";
import { accessSync, constants, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, resolve, sep } from "node:path";
import stripAnsi from "strip-ansi";
import { CLI_BACKENDS, KNOWN_CLI_COMMANDS } from "./cli-registry.js";

/** Presence is not authentication; a version receipt is not a successful connection. */
export interface BackendDiagnostic {
	name: string;
	label: string;
	kind: "cli" | "http";
	status: "installed" | "missing" | "unusable" | "key-present" | "key-missing";
	path?: string;
	version?: string;
	detail?: string;
	check: "not-checked" | "checking" | "version-found" | "version-unavailable" | "failed" | "unsupported" | "cancelled" | "not-applicable";
}

/** Session-local diagnostics; inventory never launches a subprocess or reads auth files. */
export interface BackendDiagnostics {
	/** Inspect PATH and stock Anthropic key presence. @param extraNames Manual executable names or paths. @returns Fresh presence rows. */
	inventory(extraNames?: string[]): BackendDiagnostic[];
	/** Check allowlisted versions only. @param signal Cancellation, with awaited child cleanup. @param onUpdate Immutable partial snapshots. @param extraNames Manual executable names or paths (never executed). @returns Final presence/version rows. */
	check(signal: AbortSignal, onUpdate?: (rows: BackendDiagnostic[]) => void, extraNames?: string[]): Promise<BackendDiagnostic[]>;
}

// Deliberately independent of runArgs/list: adding an advisor preset does not authorize executing it here.
const VERSION_COMMANDS = new Set(["codex", "claude", "pi", "opencode", "cursor-agent", "gemini", "qwen", "crush", "amp"]);
const VERSION_PREFIXES: Record<string, string> = {
	codex: "codex(?:-cli)?", claude: "claude(?: code|-cli)?", pi: "pi(?: coding agent|-coding-agent)?",
	opencode: "opencode", "cursor-agent": "cursor(?:-agent)?", gemini: "gemini(?: cli)?",
	qwen: "qwen(?: code)?", crush: "crush", amp: "amp",
};
const OUTPUT_LIMIT = 16 * 1024;
const TIMEOUT_MS = 3000;
const TERM_GRACE_MS = 200;

/** Strip terminal escapes/control characters from display text. @param text Untrusted text. @returns Terminal-safe text. */
function safeText(text: string): string {
	return stripAnsi(text).replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "");
}

/** Locate an executable in-process, with no shell/which. @param name Name or explicit path. @returns Absolute executable path, if present. */
function executablePath(name: string): string | undefined {
	if (!name || name.startsWith("-") || /[\x00-\x1f\x7f]/.test(name)) return undefined;
	const pathLike = name.includes(sep) || (process.platform === "win32" && name.includes("/"));
	const candidates = pathLike ? [name] : (process.env.PATH ?? "").split(delimiter).map((dir) => join(dir || ".", name));
	const extensions = process.platform === "win32" ? ["", ...(process.env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";")] : [""];
	for (const candidate of candidates) {
		for (const ext of extensions) {
			const path = process.platform === "win32" && !candidate.toLowerCase().endsWith(ext.toLowerCase()) ? `${candidate}${ext}` : candidate;
			try {
				if (!statSync(path).isFile()) continue;
				accessSync(path, constants.X_OK);
				return resolve(path);
			} catch { /* Missing, inaccessible, or not executable. */ }
		}
	}
	return undefined;
}

/** Build presence-only rows. @param extraNames Manual executables to locate without running. @returns Fresh registry and HTTP rows. */
function inventory(extraNames: string[] = []): BackendDiagnostic[] {
	const names = [...new Set([...KNOWN_CLI_COMMANDS, ...extraNames.filter((name) => name !== "anthropic" && safeText(name) === name)])];
	const rows: BackendDiagnostic[] = names.map((name) => {
		const path = executablePath(name);
		const spec = Object.hasOwn(CLI_BACKENDS, name) ? CLI_BACKENDS[name] : undefined;
		return {
			name: safeText(name), label: safeText(spec?.label ?? name), kind: "cli",
			status: path ? spec?.unusable ? "unusable" : "installed" : "missing",
			...(path ? { path: safeText(path) } : {}),
			...(path && spec?.unusable ? { detail: spec.unusable } : {}), check: "not-checked",
		};
	});
	rows.push({ name: "anthropic", label: "Anthropic API", kind: "http",
		status: process.env.ANTHROPIC_API_KEY ? "key-present" : "key-missing", check: "not-applicable",
		detail: process.env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY set; authentication not checked" : "ANTHROPIC_API_KEY not set" });
	return rows;
}

/** Extract only a strict version ID, never a login message or arbitrary suffix. @param name Known CLI. @param output Private bounded output. @returns Version ID, or undefined. */
function extractVersion(name: string, output: string): string | undefined {
	const id = "[0-9]{1,8}(?:\\.[0-9]{1,8}){1,3}(?:-(?:alpha|beta|rc|pre|dev|next|canary)(?:[.-]?[0-9]{1,8})?)?";
	const pattern = new RegExp(`^(?:${VERSION_PREFIXES[name]}\\s+(?:version\\s+)?)?v?(${id})(?:\\s+\\(Claude Code\\))?$`, "i");
	for (const line of stripAnsi(output).split(/\r?\n/)) {
		const match = pattern.exec(safeText(line).trim());
		if (match) return match[1];
	}
	return undefined;
}

/** Detect live group members, ignoring Linux zombies pending init reaping. @param pid Group leader PID. @returns Whether executable members may remain. */
function processGroupActive(pid: number): boolean {
	try { process.kill(-pid, 0); }
	catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
	if (process.platform !== "linux") return true;
	try {
		return readdirSync("/proc").filter((entry) => /^\d+$/.test(entry)).some((entry) => {
			try {
				const stat = readFileSync(`/proc/${entry}/stat`, "utf8");
				const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
				return Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X";
			} catch { return false; /* Process disappeared while inspecting it. */ }
		});
	} catch { return true; }
}

/** Wait without blocking stream events. @param ms Delay. @returns Delay completion. */
function delay(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

/** TERM then KILL the entire detached group, including descendants without pipes. @param pid Group leader PID. @returns Whether cleanup was confirmed. */
async function cleanGroup(pid: number | undefined): Promise<boolean> {
	if (!pid) return true;
	/** Signal a possibly exited group. @param signal Unix signal. @returns Nothing. */
	const send = (signal: NodeJS.Signals): void => {
		try { process.kill(-pid, signal); } catch { /* Already exited; liveness check below decides. */ }
	};
	send("SIGTERM");
	const grace = Date.now() + TERM_GRACE_MS;
	while (processGroupActive(pid) && Date.now() < grace) await delay(10);
	if (!processGroupActive(pid)) return true;
	send("SIGKILL");
	const deadline = Date.now() + 1000;
	while (processGroupActive(pid) && Date.now() < deadline) await delay(10);
	return !processGroupActive(pid);
}

type VersionResult = Pick<BackendDiagnostic, "check" | "version" | "detail">;

/** Run only --version in a private cwd; third-party startup may still migrate global files. @param name Allowlisted name. @param path Resolved executable. @param signal Cancellation. @returns Sanitized version receipt after group and cwd cleanup. */
async function checkVersion(name: string, path: string, signal: AbortSignal): Promise<VersionResult> {
	if (signal.aborted) return { check: "cancelled", detail: "Version check cancelled" };
	let cwd: string;
	try { cwd = mkdtempSync(join(tmpdir(), "bpx-diag-service-cwd-")); }
	catch { return { check: "failed", detail: "Could not prepare private version-check directory" }; }
	try {
		return await new Promise<VersionResult>((done) => {
			let child;
			try {
				// No shell, prompt, auth reads, model requests, or generic argv fallback.
				if (signal.aborted) { done({ check: "cancelled", detail: "Version check cancelled" }); return; }
				child = spawn(path, ["--version"], { cwd, detached: true, stdio: ["ignore", "pipe", "pipe"] });
			} catch { done({ check: "failed", detail: "Could not start version check" }); return; }
			let stdout = "";
			let stderr = "";
			let bytes = 0;
			let failure: string | undefined;
			let closed = false;
			let exitCode: number | null = null;
			let cleaning = false;
			let cleaned = false;
			let cleanupConfirmed = true;
			let pipeTimer: ReturnType<typeof setTimeout> | undefined;
			/** Resolve only after process close and group cleanup. @returns Nothing. */
			const finish = (): void => {
				if (!closed || !cleaned) return;
				clearTimeout(timer);
				if (pipeTimer) clearTimeout(pipeTimer);
				signal.removeEventListener("abort", onAbort);
				if (!cleanupConfirmed) { done({ check: "failed", detail: "Version subprocess cleanup could not be confirmed" }); return; }
				if (signal.aborted) { done({ check: "cancelled", detail: "Version check cancelled" }); return; }
				if (failure) { done({ check: "failed", detail: failure }); return; }
				if (exitCode !== 0) { done({ check: "failed", detail: "Version command did not exit successfully" }); return; }
				const version = extractVersion(name, stdout) ?? extractVersion(name, stderr);
				done(version ? { check: "version-found", version } : { check: "version-unavailable", detail: "No recognizable version ID returned" });
			};
			/** Begin awaited group cleanup exactly once, even after parent closes its pipes. @returns Nothing. */
			const cleanup = (): void => {
				if (cleaning) return;
				cleaning = true;
				void cleanGroup(child.pid).then((confirmed) => {
					cleanupConfirmed = confirmed;
					cleaned = true;
					// Pipes held by an escaped descendant cannot keep this service alive indefinitely.
					if (!closed) pipeTimer = setTimeout(() => { child.stdout?.destroy(); child.stderr?.destroy(); }, 100);
					finish();
				});
			};
			/** Stop on a bounded failure without exposing subprocess output. @param detail Static safe failure. @returns Nothing. */
			const stop = (detail: string): void => {
				failure ??= detail;
				clearTimeout(timer);
				cleanup();
			};
			const timer = setTimeout(() => stop("Version check timed out after 3000ms"), TIMEOUT_MS);
			const onAbort = (): void => stop("Version check cancelled");
			signal.addEventListener("abort", onAbort, { once: true });
			/** Bound both streams before retaining bytes. @param chunk Private subprocess bytes. @returns Whether chunk fits the shared cap. */
			const retain = (chunk: Buffer): boolean => {
				bytes += chunk.length;
				if (bytes > OUTPUT_LIMIT) stop("Version output exceeded 16384 bytes");
				return !failure;
			};
			child.stdout?.on("data", (chunk: Buffer) => { if (retain(chunk)) stdout += chunk.toString("utf8"); });
			child.stderr?.on("data", (chunk: Buffer) => { if (retain(chunk)) stderr += chunk.toString("utf8"); });
			child.on("error", () => stop("Could not start version check"));
			child.on("close", (code) => {
				closed = true;
				exitCode = code;
				clearTimeout(timer);
				cleanup();
				finish();
			});
			if (signal.aborted) onAbort();
		});
	} finally {
		try { rmSync(cwd, { recursive: true, force: true }); }
		catch { return { check: "failed", detail: "Could not remove private version-check directory" }; }
	}
}

/** Clone and freeze callback rows so recipients cannot change service state or prior receipts. @param rows Current state. @returns Immutable snapshot with the frozen public API's array type. */
function snapshot(rows: BackendDiagnostic[]): BackendDiagnostic[] {
	return Object.freeze(rows.map((row) => Object.freeze({ ...row }))) as unknown as BackendDiagnostic[];
}

/** Check installed known CLIs sequentially and stop before any later spawn on cancellation. @param signal Cancellation. @param onUpdate Immutable partial snapshots. @param extraNames Manual presence-only executables. @returns Final rows after cleanup. */
async function check(signal: AbortSignal, onUpdate?: (rows: BackendDiagnostic[]) => void, extraNames?: string[]): Promise<BackendDiagnostic[]> {
	const rows = inventory(extraNames);
	onUpdate?.(snapshot(rows));
	for (let index = 0; index < rows.length; index++) {
		const row = rows[index];
		if (row.kind !== "cli" || row.status === "missing") continue;
		if (signal.aborted) break;
		let result: VersionResult;
		if (process.platform === "win32" || !VERSION_COMMANDS.has(row.name)) {
			result = { check: "unsupported", detail: "No supported version check for this executable" };
		} else {
			const path = executablePath(row.name);
			if (path) {
				rows[index] = { ...row, check: "checking" };
				onUpdate?.(snapshot(rows));
				result = await checkVersion(row.name, path, signal);
			} else {
				result = { check: "failed", detail: "Executable no longer available" };
			}
		}
		rows[index] = { ...row, ...result };
		onUpdate?.(snapshot(rows));
	}
	if (signal.aborted) {
		for (let index = 0; index < rows.length; index++) {
			const row = rows[index];
			if (row.kind === "cli" && row.status !== "missing" && row.check === "not-checked") {
				rows[index] = { ...row, check: "cancelled", detail: "Version check cancelled" };
			}
		}
		onUpdate?.(snapshot(rows));
	}
	return snapshot(rows);
}

/** Default local service; callers explicitly opt into version subprocesses via check(). */
export const defaultBackendDiagnostics: BackendDiagnostics = { inventory, check };
