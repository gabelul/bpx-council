import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, relative } from "node:path";
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { defaultBackendDiagnostics, type BackendDiagnostic, type BackendDiagnostics } from "../src/backend-diagnostics.js";
import { KNOWN_CLI_COMMANDS } from "../src/cli-registry.js";

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return { ...actual, spawn: vi.fn(actual.spawn) };
});

vi.mock("node:fs", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:fs")>();
	return { ...actual, rmSync: vi.fn(actual.rmSync) };
});

let root: string;
let bin: string;
let home: string;
const diagnostics: BackendDiagnostics = defaultBackendDiagnostics;

/** Install only a fixture executable, recording argv/cwd without relying on PATH's node. @param name Fixture command. @param body Node program. @returns Fixture path. */
function fakeCli(name: string, body: string): string {
	const path = join(bin, name);
	writeFileSync(path, `#!${process.execPath}\nconst fs = require('node:fs');\nfs.appendFileSync(${JSON.stringify(join(root, "calls"))}, JSON.stringify({name:${JSON.stringify(name)}, args:process.argv.slice(2), cwd:process.cwd(), home:process.env.HOME})+'\\n');\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

/** Read fixture receipts. @returns Recorded subprocess invocations. */
function calls(): Array<{ name: string; args: string[]; cwd: string; home: string }> {
	return existsSync(join(root, "calls")) ? readFileSync(join(root, "calls"), "utf8").trim().split("\n").map((line) => JSON.parse(line)) : [];
}

/** Select a diagnostic by identity. @param rows Service results. @param name Backend identity. @returns Required row. */
function row(rows: BackendDiagnostic[], name: string): BackendDiagnostic {
	const found = rows.find((entry) => entry.name === name);
	expect(found).toBeDefined();
	return found!;
}

/** Await an observable fixture readiness marker. @param path Marker. @returns Nothing; rejects if fixture never starts. */
async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (!existsSync(path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
	expect(existsSync(path)).toBe(true);
}

/** Check executable liveness, not Linux zombies awaiting init. @param pid Fixture PID. @returns Whether fixture can still execute. */
function alive(pid: number): boolean {
	try { process.kill(pid, 0); } catch { return false; }
	if (process.platform === "linux") {
		try { return !/[)] [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); } catch { return false; }
	}
	return true;
}

beforeEach(() => {
	vi.clearAllMocks();
	root = mkdtempSync(join(tmpdir(), "bpx-diag-service-test-"));
	bin = join(root, "bin"); home = join(root, "home");
	mkdirSync(bin); mkdirSync(home);
	vi.stubEnv("PATH", bin);
	vi.stubEnv("HOME", home);
	vi.stubEnv("ANTHROPIC_API_KEY", "");
});
afterEach(() => {
	vi.restoreAllMocks(); vi.unstubAllEnvs();
	rmSync(root, { recursive: true, force: true });
});

describe("offline backend inventory", () => {
	it("includes every known CLI and only stock Anthropic key presence, with no spawning", () => {
		fakeCli("codex", "process.stdout.write('codex-cli 1.2.3')");
		fakeCli("amp", "process.stdout.write('amp 2.3.4')");
		fakeCli("which", "throw new Error('must not run')");
		vi.stubEnv("ANTHROPIC_API_KEY", "sk-secret-do-not-display");
		vi.stubEnv("OPENAI_API_KEY", "not-supported");
		const spawn = vi.mocked(childProcess.spawn);
		const rows = diagnostics.inventory();
		expect(rows.map((entry) => entry.name)).toEqual([...KNOWN_CLI_COMMANDS, "anthropic"]);
		expect(row(rows, "codex")).toMatchObject({ label: "Codex CLI", kind: "cli", status: "installed", check: "not-checked", path: join(bin, "codex") });
		expect(row(rows, "amp")).toMatchObject({ status: "unusable", check: "not-checked", detail: expect.stringContaining("executing agent") });
		expect(row(rows, "claude")).toMatchObject({ status: "missing", check: "not-checked" });
		expect(row(rows, "claude").path).toBeUndefined();
		expect(row(rows, "anthropic")).toMatchObject({ status: "key-present", kind: "http", check: "not-applicable" });
		expect(JSON.stringify(rows)).not.toContain("sk-secret");
		expect(spawn).not.toHaveBeenCalled();
		expect(calls()).toEqual([]);
	});

	it("finds executable files/symlinks in PATH order and ignores directories/nonexecutables", () => {
		const later = join(root, "later"); mkdirSync(later);
		writeFileSync(join(bin, "codex"), "not executable"); chmodSync(join(bin, "codex"), 0o644);
		mkdirSync(join(bin, "claude"));
		const target = fakeCli("custom-real", "process.exit(0)");
		symlinkSync(target, join(later, "codex"));
		vi.stubEnv("PATH", `${bin}${delimiter}${later}`);
		const rows = diagnostics.inventory([target, "custom-real", "codex", "anthropic", "absent", "-bad", "nul\0bad"]);
		expect(row(rows, "codex").path).toBe(join(later, "codex"));
		expect(row(rows, "claude").status).toBe("missing");
		expect(row(rows, target).path).toBe(target);
		expect(row(rows, "custom-real").status).toBe("installed");
		expect(row(rows, "absent").status).toBe("missing");
		expect(row(rows, "-bad").status).toBe("missing");
		expect(rows.filter((entry) => entry.name === "codex")).toHaveLength(1);
		expect(rows.filter((entry) => entry.name === "anthropic")).toHaveLength(1);
		expect(JSON.stringify(rows)).not.toContain("\\u0000");
		expect(row(rows, "anthropic").status).toBe("key-missing");
		expect(calls()).toEqual([]);
	});

	it("resolves relative and empty PATH components without which", () => {
		const path = fakeCli("codex", "process.exit(0)");
		vi.stubEnv("PATH", relative(process.cwd(), bin));
		const explicit = relative(process.cwd(), path);
		expect(row(diagnostics.inventory(), "codex").path).toBe(path);
		expect(row(diagnostics.inventory([explicit]), explicit).path).toBe(path);
		vi.stubEnv("PATH", `${delimiter}${bin}`);
		expect(row(diagnostics.inventory(), "codex").path).toBe(path);
		vi.stubEnv("PATH", "");
		expect(row(diagnostics.inventory([explicit]), explicit).path).toBe(path);
	});
});

describe.skipIf(process.platform === "win32")("explicit Unix version checks", () => {
	it("uses --version only, ignores stdin, removes private cwd, and checks unusable CLI metadata only", async () => {
		fakeCli("codex", "if (fs.readFileSync(0).length) throw new Error('stdin must be empty'); fs.writeFileSync('scratch', 'private'); process.stdout.write('codex-cli 0.123.4\\n');");
		fakeCli("amp", "process.stdout.write('amp 2.3.4\\n');");
		const rows = await diagnostics.check(new AbortController().signal);
		expect(row(rows, "codex")).toMatchObject({ check: "version-found", version: "0.123.4", status: "installed" });
		expect(row(rows, "amp")).toMatchObject({ check: "version-found", version: "2.3.4", status: "unusable" });
		expect(row(rows, "anthropic").check).toBe("not-applicable");
		for (const call of calls()) {
			expect(call.args).toEqual(["--version"]);
			expect(call.cwd).not.toBe(process.cwd());
			expect(call.cwd).toContain("bpx-diag-service-cwd-");
			expect(existsSync(call.cwd)).toBe(false);
			expect(call.home).toBe(home);
		}
		expect(existsSync(join(process.cwd(), "scratch"))).toBe(false);
	});

	it("extracts only IDs from known stdout/stderr version formats and discards terminal/login/secret chatter", async () => {
		fakeCli("codex", "process.stderr.write('Login required: sk-live-secret 8.9.0'); process.stdout.write('\\x1b[32mcodex-cli 0.12.3\\x1b[0m');");
		fakeCli("claude", "process.stdout.write('2.1.47 (Claude Code)\\n');");
		fakeCli("pi", "process.stderr.write('\\x1b]8;;https://secret.invalid\\x07v1.0.3\\x1b]8;;\\x07\\n');");
		fakeCli("opencode", "process.stdout.write('opencode version 1.2.3-rc.4\\n');");
		const rows = await diagnostics.check(new AbortController().signal);
		expect(row(rows, "codex").version).toBe("0.12.3");
		expect(row(rows, "claude").version).toBe("2.1.47");
		expect(row(rows, "pi").version).toBe("1.0.3");
		expect(row(rows, "opencode").version).toBe("1.2.3-rc.4");
		expect(JSON.stringify(rows)).not.toMatch(/secret|Login|invalid|\\u001b/);
	}, 20_000);

	it.each(["", "Login required 1.2.3: sk-secret", "version=banana", "1.2.3-sk-secret", "1.2.3 trailing-secret", "999999999.2.3"])("warns about unavailable version after successful exit: %j", async (output) => {
		fakeCli("codex", `process.stdout.write(${JSON.stringify(output)});`);
		const snapshots: BackendDiagnostic[][] = [];
		const rows = await diagnostics.check(new AbortController().signal, (partial) => snapshots.push(partial));
		expect(snapshots.map((partial) => row(partial, "codex").check)).toEqual(["not-checked", "checking", "version-unavailable"]);
		expect(row(rows, "codex")).toMatchObject({ status: "installed", check: "version-unavailable", detail: "No recognizable version ID returned" });
		expect(row(rows, "codex").version).toBeUndefined();
		expect(JSON.stringify([rows, ...snapshots])).not.toContain("sk-secret");
	});

	it("emits checking before spawn and keeps it visible until a final receipt", async () => {
		const ready = join(root, "ready"); const release = join(root, "release");
		fakeCli("codex", `process.stderr.write('private login token'); fs.writeFileSync(${JSON.stringify(ready)}, 'ready'); const timer = setInterval(() => { if (fs.existsSync(${JSON.stringify(release)})) { clearInterval(timer); process.stdout.write('codex-cli 1.2.3\\n'); } }, 10);`);
		const snapshots: BackendDiagnostic[][] = [];
		const spawnCounts: number[] = [];
		const controller = new AbortController();
		let finished = false;
		const pending = diagnostics.check(controller.signal, (partial) => {
			snapshots.push(partial);
			if (row(partial, "codex").check === "checking") spawnCounts.push(vi.mocked(childProcess.spawn).mock.calls.length);
		}).then((rows) => { finished = true; return rows; });
		try {
			await waitForFile(ready);
			expect(finished).toBe(false);
			expect(spawnCounts).toEqual([0]);
			expect(row(snapshots.at(-1)!, "codex")).toMatchObject({ check: "checking", status: "installed" });
			expect(row(snapshots.at(-1)!, "codex").version).toBeUndefined();
			expect(JSON.stringify(snapshots)).not.toMatch(/private login token|rawoutput/);
			writeFileSync(release, "finish");
			const rows = await pending;
			expect(snapshots.map((partial) => row(partial, "codex").check)).toEqual(["not-checked", "checking", "version-found"]);
			expect(row(rows, "codex")).toMatchObject({ check: "version-found", version: "1.2.3" });
			expect(JSON.stringify(rows)).not.toContain("private login token");
		} finally { controller.abort(); await pending; }
	});

	it("callback cancellation at checking prevents this and all later subprocesses", async () => {
		fakeCli("codex", "throw new Error('must not start')");
		fakeCli("claude", "throw new Error('must not start')");
		const snapshots: BackendDiagnostic[][] = [];
		const controller = new AbortController();
		const rows = await diagnostics.check(controller.signal, (partial) => {
			snapshots.push(partial);
			if (row(partial, "codex").check === "checking") controller.abort();
		});
		expect(row(rows, "codex").check).toBe("cancelled");
		expect(row(rows, "claude").check).toBe("cancelled");
		expect(snapshots.flatMap((partial) => partial.filter((entry) => entry.check === "checking").map((entry) => entry.name))).toEqual(["codex"]);
		expect(vi.mocked(childProcess.spawn)).not.toHaveBeenCalled();
		expect(calls()).toEqual([]);
	});

	it("never executes missing or manually named executables, even paths named like a known CLI", async () => {
		const custom = fakeCli("manual", "throw new Error('never execute')");
		const target = fakeCli("other-codex", "throw new Error('never execute')");
		const manual = join(root, "manual"); mkdirSync(manual);
		const knownPath = join(manual, "codex"); symlinkSync(target, knownPath);
		const snapshots: BackendDiagnostic[][] = [];
		const rows = await diagnostics.check(new AbortController().signal, (partial) => snapshots.push(partial), ["manual", custom, knownPath, "absent"]);
		expect(snapshots.every((partial) => partial.every((entry) => entry.check !== "checking"))).toBe(true);
		for (const partial of snapshots) {
			expect(row(partial, "codex").check).toBe("not-checked");
			expect(row(partial, "absent").check).toBe("not-checked");
		}
		for (const name of ["manual", custom, knownPath]) expect(row(rows, name)).toMatchObject({ status: "installed", check: "unsupported" });
		expect(row(rows, "codex")).toMatchObject({ status: "missing", check: "not-checked" });
		expect(row(rows, "absent").check).toBe("not-checked");
		expect(calls()).toEqual([]);
	});

	it("does not turn sanitized manual names into allowlisted executable identities", async () => {
		fakeCli("pi", "process.stdout.write('1.0.3');");
		fakeCli("pi\u202e", "throw new Error('manual command must never run');");
		await diagnostics.check(new AbortController().signal, undefined, ["pi\u202e"]);
		expect(calls().map(call => call.name)).toEqual(["pi"]);
	});

	it("handles executable launch failure and nonzero exit without returning stderr or fake versions", async () => {
		writeFileSync(join(bin, "codex"), "#!/definitely/missing/interpreter\n"); chmodSync(join(bin, "codex"), 0o755);
		fakeCli("claude", "process.stderr.write('claude 9.9.9\\nsecret login token'); process.exit(2);");
		const rows = await diagnostics.check(new AbortController().signal);
		expect(row(rows, "codex")).toMatchObject({ check: "failed", detail: "Could not start version check" });
		expect(row(rows, "claude")).toMatchObject({ check: "failed", detail: "Version command did not exit successfully" });
		expect(row(rows, "claude").version).toBeUndefined();
		expect(JSON.stringify(rows)).not.toMatch(/secret|token|9\.9\.9/);
	});

	it("returns failed when private cwd cleanup fails, even after successful output", async () => {
		fakeCli("codex", "process.stdout.write('codex-cli 1.2.3\\n');");
		vi.mocked(fs.rmSync).mockImplementationOnce(() => { throw new Error("private cleanup error"); });
		try {
			const rows = await diagnostics.check(new AbortController().signal);
			expect(row(rows, "codex")).toMatchObject({ check: "failed", detail: "Could not remove private version-check directory" });
			expect(row(rows, "codex").version).toBeUndefined();
			expect(JSON.stringify(rows)).not.toContain("private cleanup error");
		} finally {
			for (const call of calls()) rmSync(call.cwd, { recursive: true, force: true });
		}
	});

	it("keeps unconfirmed process cleanup failed instead of version unavailable", async () => {
		fakeCli("codex", "process.stdout.write('unknown version format');");
		const kill = process.kill.bind(process);
		vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
			if (pid < 0 && signal === 0) throw Object.assign(new Error("private liveness error"), { code: "EPERM" });
			return kill(pid, signal);
		});
		const rows = await diagnostics.check(new AbortController().signal);
		expect(row(rows, "codex")).toMatchObject({ check: "failed", detail: "Version subprocess cleanup could not be confirmed" });
		expect(row(rows, "codex").version).toBeUndefined();
		expect(JSON.stringify(rows)).not.toContain("private liveness error");
		expect(calls().every((call) => !existsSync(call.cwd))).toBe(true);
	});

	it("times out at three seconds, kills resistant child, then continues later checks", async () => {
		const pidFile = join(root, "pid");
		fakeCli("codex", `fs.writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000);`);
		fakeCli("claude", "process.stdout.write('2.0.1\\n');");
		const start = Date.now();
		const rows = await diagnostics.check(new AbortController().signal);
		expect(Date.now() - start).toBeGreaterThanOrEqual(3000);
		expect(Date.now() - start).toBeLessThan(5000);
		expect(row(rows, "codex")).toMatchObject({ check: "failed", detail: "Version check timed out after 3000ms" });
		expect(alive(Number(readFileSync(pidFile, "utf8")))).toBe(false);
		expect(row(rows, "claude").check).toBe("version-found");
		expect(calls().every((call) => !existsSync(call.cwd))).toBe(true);
	}, 7000);

	it.each(["stdout", "stderr", "combined"])("bounds %s bytes and suppresses even version-looking overflow", async (stream) => {
		const writes = stream === "combined" ? "process.stdout.write('x'.repeat(9000)); process.stderr.write('y'.repeat(9000));" : `process.${stream}.write('x'.repeat(17000));`;
		fakeCli("codex", `process.stdout.write('codex-cli 1.2.3\\n'); ${writes} setInterval(()=>{},1000);`);
		const rows = await diagnostics.check(new AbortController().signal);
		expect(row(rows, "codex")).toMatchObject({ check: "failed", detail: "Version output exceeded 16384 bytes" });
		expect(row(rows, "codex").version).toBeUndefined();
		expect(calls().every((call) => !existsSync(call.cwd))).toBe(true);
	});

	it("preabort starts no child or scratch work and returns cancel rows", async () => {
		fakeCli("pi", "throw new Error('never execute')");
		const spawn = vi.mocked(childProcess.spawn);
		const controller = new AbortController(); controller.abort();
		const rows = await diagnostics.check(controller.signal);
		expect(row(rows, "pi").check).toBe("cancelled");
		expect(row(rows, "codex").check).toBe("not-checked");
		expect(row(rows, "anthropic").check).toBe("not-applicable");
		expect(spawn).not.toHaveBeenCalled();
		expect(calls()).toEqual([]);
	});

	it.each(["inherit", "ignore"])("awaits stubborn descendant cleanup with %s pipes and removes cwd before returning", async (stdio) => {
		const ready = join(root, "ready"); const survivor = join(root, "survivor");
		const grandchild = `process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(${JSON.stringify(ready)},JSON.stringify({pid:process.pid,cwd:process.cwd()})); setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(survivor)},'alive'),800); setInterval(()=>{},1000);`;
		fakeCli("codex", `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:${JSON.stringify(stdio)}}); process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`);
		fakeCli("claude", "throw new Error('later check must not run')");
		const controller = new AbortController();
		const pending = diagnostics.check(controller.signal);
		await waitForFile(ready);
		const child = JSON.parse(readFileSync(ready, "utf8")) as { pid: number; cwd: string };
		const start = Date.now(); controller.abort();
		const rows = await pending;
		expect(Date.now() - start).toBeGreaterThanOrEqual(180);
		expect(alive(child.pid)).toBe(false);
		expect(existsSync(child.cwd)).toBe(false);
		expect(row(rows, "codex").check).toBe("cancelled");
		expect(row(rows, "claude").check).toBe("cancelled");
		expect(calls().map((call) => call.name)).toEqual(["codex"]);
		await new Promise((done) => setTimeout(done, 850));
		expect(existsSync(survivor)).toBe(false);
	});

	it("emits frozen independent partial snapshots and preserves completed rows when callback cancels", async () => {
		fakeCli("codex", "process.stdout.write('codex-cli 1.2.3\\n');");
		fakeCli("claude", "throw new Error('later check must not run')");
		const snapshots: BackendDiagnostic[][] = [];
		const controller = new AbortController();
		const rows = await diagnostics.check(controller.signal, (partial) => {
			snapshots.push(partial);
			expect(Object.isFrozen(partial)).toBe(true);
			expect(partial.every((entry) => Object.isFrozen(entry))).toBe(true);
			expect(() => { row(partial, "codex").check = "failed"; }).toThrow(TypeError);
			expect(() => { partial.push({ ...partial[0] }); }).toThrow(TypeError);
			if (row(partial, "codex").check === "version-found") controller.abort();
		});
		expect(snapshots.map((partial) => row(partial, "codex").check)).toEqual(["not-checked", "checking", "version-found", "version-found"]);
		expect(row(snapshots[0], "codex").check).toBe("not-checked");
		expect(row(snapshots[1], "codex").check).toBe("checking");
		expect(row(snapshots[1], "codex").version).toBeUndefined();
		expect(Object.isFrozen(rows)).toBe(true);
		expect(rows.every((entry) => Object.isFrozen(entry))).toBe(true);
		expect(rows).not.toBe(snapshots.at(-1));
		expect(row(rows, "codex")).toMatchObject({ check: "version-found", version: "1.2.3" });
		expect(row(rows, "claude").check).toBe("cancelled");
		expect(snapshots[0]).not.toBe(snapshots[1]);
		expect(snapshots[0][0]).not.toBe(snapshots[1][0]);
		expect(calls().map((call) => call.name)).toEqual(["codex"]);
	});
});

it("Windows inventory still works while version checking is unsupported", async () => {
	fakeCli("codex", "throw new Error('must not execute on Windows')");
	vi.spyOn(process, "platform", "get").mockReturnValue("win32");
	const spawn = vi.mocked(childProcess.spawn);
	const rows = await diagnostics.check(new AbortController().signal);
	expect(row(rows, "codex")).toMatchObject({ status: "installed", check: "unsupported" });
	expect(spawn).not.toHaveBeenCalled();
});
