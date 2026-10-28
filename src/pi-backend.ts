import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Required for every Pi subprocess, independent of the caller's isolation setting. */
export const PI_SAFETY_ARGS = [
	"--print", "--mode", "text", "--no-session", "--no-tools", "--no-extensions",
	"--no-skills", "--no-prompt-templates", "--no-themes", "--no-context-files",
	"--no-approve", "--offline",
];

/** CLI-supported levels; Pi clamps these to the selected model's capabilities. */
export const PI_THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** Build guarded Pi argv. Raw persona text must never enter its text-or-path option. */
export function piArgs(opts: { model?: string; effort?: string; systemPromptFile?: string } = {}): string[] {
	return [
		...PI_SAFETY_ARGS,
		"--system-prompt", opts.systemPromptFile ?? "", "--append-system-prompt", "",
		...(opts.model ? ["--model", opts.model] : []),
		...(opts.effort ? ["--thinking", opts.effort] : []),
	];
}

/**
 * Create a private persona file and scratch cwd, avoiding Pi's project startup migrations.
 * @param persona - Literal advisor instructions, even when they name an existing file.
 * @returns Subprocess cwd, prompt file and idempotent cleanup. Pi's global migrations still apply.
 */
export function preparePiInvocation(persona: string): { cwd: string; systemPromptFile: string; cleanup(): void } {
	const cwd = mkdtempSync(join(tmpdir(), "bpx-council-pi-"));
	const systemPromptFile = join(cwd, "system.md");
	try {
		writeFileSync(systemPromptFile, persona, { mode: 0o600, flag: "wx" });
	} catch {
		rmSync(cwd, { recursive: true, force: true });
		throw new Error("Could not prepare private Pi advisor prompt");
	}
	return { cwd, systemPromptFile, cleanup: () => rmSync(cwd, { recursive: true, force: true }) };
}

/**
 * Parse Pi's global auth-filtered, extension-disabled chat-model table, not session state or entitlement.
 * @param stdout - Six-column `--list-models` output, possibly with ANSI decoration or startup notices.
 * @returns Deduplicated provider/model IDs; no valid rows means manual model entry.
 */
export function parsePiModels(stdout: string): string[] {
	const clean = stdout.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");
	const models: string[] = [];
	let table = false;
	for (const line of clean.split(/\r?\n/)) {
		const cols = line.trim().split(/\s+/);
		if (cols.join(" ") === "provider model context max-out thinking images") { table = true; continue; }
		if (!table || cols.length !== 6) continue;
		const [provider, model, context, maxOut, thinking, images] = cols;
		if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(provider) || !/^[a-zA-Z0-9~][a-zA-Z0-9._/:@+~-]*$/.test(model)) continue;
		if (![context, maxOut].every((count) => /^\d+(?:\.\d+)?[KM]?$/.test(count))) continue;
		if (![thinking, images].every((flag) => flag === "yes" || flag === "no")) continue;
		models.push(`${provider}/${model}`);
	}
	return [...new Set(models)];
}
