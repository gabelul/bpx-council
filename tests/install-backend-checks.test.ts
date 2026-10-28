import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { offerInstallBackendChecks, runInstall } from "../src/install.js";
import type { BackendDiagnostic, BackendDiagnostics } from "../src/backend-diagnostics.js";

const rows: BackendDiagnostic[] = [
	{ name: "codex", label: "Codex", kind: "cli", status: "installed", path: "/fixture/codex", check: "not-checked" },
	{ name: "pi", label: "Pi", kind: "cli", status: "missing", check: "not-checked" },
	{ name: "anthropic", label: "Anthropic", kind: "http", status: "key-missing", check: "not-applicable" },
];
/** Provide fake-only diagnostics and capture setup output.
 * @returns Injectable service and console spies.
 */
function fixture() {
	const diagnostics: BackendDiagnostics = { inventory: vi.fn(() => structuredClone(rows)), check: vi.fn(async () => structuredClone(rows)) };
	return { diagnostics, log: vi.spyOn(console, "log").mockImplementation(() => {}), error: vi.spyOn(console, "error").mockImplementation(() => {}) };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe("manual installation backend checks", () => {
	it("shows installation facts but never runs checks when default-No is declined", async () => {
		const { diagnostics, log } = fixture();
		const ask = vi.fn(async () => false);
		expect(await offerInstallBackendChecks(diagnostics, ask)).toBe(0);
		expect(ask).toHaveBeenCalledWith("Check installed CLI versions now?", false);
		expect(diagnostics.check).not.toHaveBeenCalled();
		const output = log.mock.calls.flat().join("\n");
		expect(output).toContain("codex: Installed"); expect(output).toContain("pi: Not found"); expect(output).toContain("API key missing");
		expect(output).not.toContain("login not verified");
	});
	it("prints deduplicated safe start/end progress without private subprocess details", async () => {
		const { diagnostics, log } = fixture();
		vi.mocked(diagnostics.check).mockImplementation(async (_signal, update) => {
			const checking: BackendDiagnostic[] = [{ ...rows[0], check: "checking", detail: "private provider message" }];
			update?.(checking); update?.(checking);
			const finished: BackendDiagnostic[] = [{ ...rows[0], check: "version-unavailable", detail: "private provider message" }];
			update?.(finished); return finished;
		});
		expect(await offerInstallBackendChecks(diagnostics, async () => true)).toBe(0);
		const output = log.mock.calls.flat().join("\n"); expect(output).toContain("Checking codex…");
		expect(output.match(/Checking codex…/g)).toHaveLength(1); expect(output).toContain("Version unavailable");
		expect(output).not.toContain("private provider message");
	});
	it("discards typeahead and restores raw state after Ctrl-C cleanup", async () => {
		const { diagnostics } = fixture(); const input = process.stdin;
		const tty = Object.getOwnPropertyDescriptor(input, "isTTY");
		const raw = Object.getOwnPropertyDescriptor(input, "setRawMode");
		const setRawMode = vi.fn((_raw: boolean) => input); const before = input.listenerCount("data");
		let signal!: AbortSignal; let done!: (value: BackendDiagnostic[]) => void;
		Object.defineProperty(input, "isTTY", { configurable: true, value: true });
		Object.defineProperty(input, "setRawMode", { configurable: true, value: setRawMode });
		vi.spyOn(input, "resume").mockReturnValue(input); vi.spyOn(input, "pause").mockReturnValue(input);
		vi.mocked(diagnostics.check).mockImplementation(s => { signal = s; return new Promise(resolve => { done = resolve; }); });
		try {
			let finished = false;
			const job = offerInstallBackendChecks(diagnostics, async () => true).then(code => { finished = true; return code; });
			await Promise.resolve(); input.emit("data", Buffer.from("7\rtyped"));
			expect(signal.aborted).toBe(false); expect(finished).toBe(false);
			input.emit("data", Buffer.from("\x03")); expect(signal.aborted).toBe(true); expect(finished).toBe(false);
			done([{ ...rows[0], check: "cancelled" }]); expect(await job).toBe(130);
			expect(setRawMode.mock.calls.map(call => call[0])).toEqual([true, false]); expect(input.listenerCount("data")).toBe(before);
		} finally {
			if (tty) Object.defineProperty(input, "isTTY", tty); else Reflect.deleteProperty(input, "isTTY");
			if (raw) Object.defineProperty(input, "setRawMode", raw); else Reflect.deleteProperty(input, "setRawMode");
		}
	});
	it("runs local checks only after explicit acceptance", async () => {
		const { diagnostics, log } = fixture();
		vi.mocked(diagnostics.check).mockResolvedValue([{ ...rows[0], version: "1.2.3", check: "version-found" }]);
		expect(await offerInstallBackendChecks(diagnostics, async () => true)).toBe(0);
		expect(diagnostics.check).toHaveBeenCalledOnce();
		expect(log.mock.calls.flat().join("\n")).toContain("codex: Installed · 1.2.3");
	});
	it("awaits cancellation cleanup before returning 130 and removes its SIGINT listener", async () => {
		const { diagnostics } = fixture();
		let cleanup!: (value: BackendDiagnostic[]) => void;
		let signal!: AbortSignal;
		vi.mocked(diagnostics.check).mockImplementation(s => { signal = s; return new Promise(resolve => { cleanup = resolve; }); });
		const previous = process.listenerCount("SIGINT");
		let done = false;
		const result = offerInstallBackendChecks(diagnostics, async () => true).then(code => { done = true; return code; });
		await Promise.resolve();
		process.emit("SIGINT");
		expect(signal.aborted).toBe(true); expect(done).toBe(false);
		cleanup([{ ...rows[0], check: "cancelled" }]);
		expect(await result).toBe(130);
		expect(process.listenerCount("SIGINT")).toBe(previous);
	});
	it("failed local checks don't silently test a model or prevent setup", async () => {
		const { diagnostics, error } = fixture();
		vi.mocked(diagnostics.check).mockRejectedValue(new Error("private provider message"));
		expect(await offerInstallBackendChecks(diagnostics, async () => true)).toBe(0);
		expect(error.mock.calls.flat().join("\n")).toContain("Local CLI checks failed");
		expect(error.mock.calls.flat().join("\n")).not.toContain("private provider message");
	});
	it("headless dry-run never offers or runs CLI metadata checks", async () => {
		const { diagnostics } = fixture();
		const home = mkdtempSync(join(tmpdir(), "bpx-install-diag-"));
		vi.stubEnv("HOME", home);
		try {
			await runInstall({ dryRun: true, agents: ["codex"], scope: "project", cwd: home }, diagnostics);
			expect(diagnostics.inventory).not.toHaveBeenCalled(); expect(diagnostics.check).not.toHaveBeenCalled();
		} finally { rmSync(home, { recursive: true, force: true }); }
	});
});
