import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as backend from "../src/backend.js";
import { actionRouteLabel, defaultConfigActions as actions, parsePersonaCandidate, resolveActionBackend } from "../src/config-actions.js";
import type { BpxCouncilConfig } from "../src/config.js";
import type { RouteTarget } from "../src/config-editor.js";
import { PI_SAFETY_ARGS } from "../src/pi-backend.js";

const advisor: RouteTarget = { section: "advisor", role: "advisor" };
const member: RouteTarget = { section: "council", role: "critic", member: true };
const config = (): BpxCouncilConfig => ({ defaultMode: "solo", solo: { backend: { type: "cli", command: "claude", model: "unsaved@literal", effort: "high", timeoutMs: 2222 } } });
const candidate = { name: "builder", stance: "neutral", systemPrompt: "Find practical trade-offs." };
const dirs: string[] = [];

/** Make an offline CLI fixture; no installed advisor is invoked. @returns Disposable fixture directory. */
function fixture(): string {
	const dir = mkdtempSync(join(tmpdir(), "bpx-actions-test-"));
	dirs.push(dir);
	return dir;
}

/** Install a fake responder capturing only this fixture's invocation. @param command Preset name. @param output Reply. @param stderr Private diagnostic output. @returns Capture filename. */
function fakeCli(command: string, output: string, stderr = ""): string {
	const dir = fixture();
	const capture = join(dir, "capture.json");
	const file = join(dir, command);
	writeFileSync(file, `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),files:require('node:fs').readdirSync(process.cwd()),input}));process.stderr.write(${JSON.stringify(stderr)});console.log(${JSON.stringify(output)});});`);
	chmodSync(file, 0o755);
	vi.stubEnv("PATH", dir);
	return capture;
}

/** Install a stalled Codex fixture with an optional TERM-resistant child.
 * @param pipes Descendant pipe policy, absent for a lone process. @returns Capture and readiness paths.
 */
function fakeStalledCodex(pipes?: "inherit" | "ignore"): { capture: string; ready: string } {
	const dir = fixture();
	const capture = join(dir, "capture.json");
	const ready = join(dir, "ready");
	const child = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`;
	const spawn = pipes ? `const child=require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:${JSON.stringify(pipes)}});` : "";
	const file = join(dir, "codex");
	writeFileSync(file, `#!${process.execPath}\nlet input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{${spawn}require('node:fs').writeFileSync(${JSON.stringify(capture)},JSON.stringify({cwd:process.cwd(),pid:process.pid,childPid:${pipes ? "child.pid" : "null"},input}));${pipes ? "" : `require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');`}process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000);});`);
	chmodSync(file, 0o755);
	vi.stubEnv("PATH", dir);
	return { capture, ready };
}

/** Wait for an offline process marker without fixed startup sleeps. @param path Readiness file. @returns Settles when marker exists, or throws after two seconds. */
async function waitForFile(path: string): Promise<void> {
	const deadline = Date.now() + 2000;
	while (!existsSync(path) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
	expect(existsSync(path)).toBe(true);
}

/** Check whether a fixture process remains executable, ignoring Linux zombies.
 * @param pid Fixture PID. @returns True for a running process.
 */
function processAlive(pid: number): boolean {
	try { process.kill(pid, 0); }
	catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
	if (process.platform === "linux") {
		try { return !/[)] [ZX] /.test(readFileSync(`/proc/${pid}/stat`, "utf8")); }
		catch { return false; }
	}
	return true;
}

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
	vi.unstubAllGlobals();
	for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("action routes and preflight", () => {
	it("preserves inherited custom fields/timeouts and legacy effort on a clone", () => {
		vi.stubEnv("BPX_COUNCIL_MODEL", "");
		const draft = config();
		draft.solo.backend!.args = ["private-argument"];
		draft.solo.thinkingLevel = "low";
		const before = structuredClone(draft);
		const inherited = resolveActionBackend(draft, member);
		expect(inherited).toEqual(draft.solo.backend);
		expect(inherited).not.toBe(draft.solo.backend);
		expect(actions.preflight(draft, member).error).toContain("Custom CLI args");
		expect(draft).toEqual(before);
	});

	it("applies legacy effort after auto detection without any discovery call", () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "fake-key");
		vi.stubEnv("BPX_COUNCIL_MODEL", "");
		const draft: BpxCouncilConfig = { defaultMode: "solo", solo: { thinkingLevel: "high" } };
		expect(resolveActionBackend(draft, advisor)).toMatchObject({ type: "http", provider: "anthropic", effort: "high" });
		expect(actions.preflight(draft, advisor)).toMatchObject({ route: "anthropic:claude-opus-4-8", error: undefined });
		expect(draft.solo.backend).toBeUndefined();
	});

	it("resolves independent seat override without shared pins/custom args", () => {
		const draft = config();
		draft.solo.backend!.args = ["secret"];
		draft.solo.thinkingLevel = "max";
		draft.council = { backends: { critic: "pi:provider/model@literal@low" } };
		expect(resolveActionBackend(draft, member)).toMatchObject({ command: "pi", model: "provider/model@literal", effort: "low", timeoutMs: 120_000 });
		expect(actions.preflight(draft, member)).toEqual({ route: "pi:provider/model@literal@low", error: undefined });
		draft.council.backends!.critic = "claude";
		expect(resolveActionBackend(draft, member)).toMatchObject({ model: undefined, effort: undefined });
	});

	it("handles every independent target and encoded literal @ model", () => {
		const draft = config();
		draft.gutCheck = { backend: "claude:model@literal@" };
		draft.council = { synthesizer: "pi:p/model@high" };
		draft.debate = { advocate: "claude:a", critic: "claude:c", synthesizer: "claude:v" };
		expect(actions.preflight(draft, { section: "gut-check", role: "backend" }).route).toBe("claude:model@literal");
		expect(actions.preflight(draft, { section: "council", role: "synthesizer" }).route).toBe("pi:p/model@high");
		for (const [role, model] of [["advocate", "a"], ["critic", "c"], ["synthesizer", "v"]]) expect(actions.preflight(draft, { section: "debate", role }).route).toBe(`claude:${model}`);
	});

	it.each(["claude", "pi", "codex"])("blocks %s args, including empty args", (command) => {
		const draft = config();
		draft.solo.backend = { type: "cli", command, args: [] };
		expect(actions.preflight(draft, advisor).error).toContain("Custom CLI args");
	});

	it.each(["opencode", "gemini", "amp", "unknown"])("blocks unsafe/unusable %s without calls", (command) => {
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config();
		draft.solo.backend = { type: "cli", command };
		expect(actions.preflight(draft, advisor).error).toBeTruthy();
		expect(spy).not.toHaveBeenCalled();
	});

	it("blocks tmux, unsupported HTTP and invalid effort", () => {
		const draft = config();
		draft.solo.backend = { type: "tmux", command: "codex" };
		expect(actions.preflight(draft, advisor).error).toContain("tmux");
		draft.solo.backend = { type: "http", provider: "openai" };
		expect(actions.preflight(draft, advisor).error).toContain("not yet implemented");
		draft.solo.backend = { type: "cli", command: "pi", effort: "ultra" };
		expect(actions.preflight(draft, advisor).error).toContain("unsupported");
	});

	it.each(["BPX_COUNCIL_MODEL", "ANTHROPIC_MODEL"])("refuses conflicting ambient %s for shared draft, permits independent seats", async (name) => {
		vi.stubEnv("BPX_COUNCIL_MODEL", "");
		if (name === "ANTHROPIC_MODEL") vi.stubEnv("BPX_COUNCIL_MODEL", undefined);
		vi.stubEnv(name, "ambient-model");
		const draft = config();
		const before = structuredClone(draft);
		const spy = vi.spyOn(backend, "callAdvisor");
		expect(actions.preflight(draft, advisor).error).toContain("Clear BPX_COUNCIL_MODEL/ANTHROPIC_MODEL");
		expect(await actions.test(draft, member, new AbortController().signal)).toMatchObject({ ok: false, error: expect.stringContaining("ambient override") });
		expect(spy).not.toHaveBeenCalled();
		draft.council = { backends: { critic: "claude:selected-model" } };
		expect(actions.preflight(draft, member)).toEqual({ route: "claude:selected-model", error: undefined });
		expect(draft.solo).toEqual(before.solo);
	});

	it.each([{ baseUrl: "https://untrusted.example" }, { apiKeyEnv: "PRIVATE" }])("blocks custom HTTP endpoint/key before fetch: %j", async (custom) => {
		const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
		const draft = config();
		draft.solo.backend = { type: "http", provider: "anthropic", ...custom };
		expect(actions.preflight(draft, advisor).error).toContain("stock Anthropic endpoint");
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: false, text: "" });
		expect(fetch).not.toHaveBeenCalled();
	});

	it("labels default HTTP model actually sent, never endpoint/key name", () => {
		expect(actionRouteLabel({ type: "http", provider: "anthropic", baseUrl: "https://secret.example", apiKeyEnv: "PRIVATE" })).toBe("anthropic:claude-opus-4-8");
	});
});

describe("Codex basic connection tests", () => {
	it("passes catalog ultra effort unchanged without discovery", async () => {
		const capture = fakeCli("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK" } }));
		const draft = config();
		draft.solo.backend = { type: "cli", command: "codex", model: "catalog-model@literal", effort: "ultra" };
		expect(actions.preflight(draft, advisor)).toMatchObject({ route: "codex:catalog-model@literal@ultra", error: undefined });
		expect(existsSync(capture)).toBe(false);
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: true, route: "codex:catalog-model@literal@ultra" });
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		expect(invoked.argv).toContain("model_reasoning_effort=ultra");
		expect(invoked.argv).not.toContain("debug");
		expect(draft.solo.backend.effort).toBe("ultra");
	});

	it.each(["arbitrary", "high\nunsafe", "high;command", ""])("rejects unsafe effort %j before dispatch", async (effort) => {
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config(); draft.solo.backend = { type: "cli", command: "codex", effort };
		expect(actions.preflight(draft, advisor).error).toContain("effort");
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: false, text: "", error: expect.stringContaining("effort") });
		expect(spy).not.toHaveBeenCalled();
	});

	it("permits default/test preflight with fixed warning, refuses generation without calls", async () => {
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config();
		draft.solo.backend = { type: "cli", command: "codex", model: "unsaved@literal", effort: "high" };
		const before = structuredClone(draft);
		const expected = { route: "codex:unsaved@literal@high", error: undefined, warning: "Basic connection test only. Codex uses a read-only sandbox; tools may remain available. This call uses your Codex quota." };
		expect(actions.preflight(draft, advisor)).toEqual(expected);
		expect(actions.preflight(draft, advisor, "test")).toEqual(expected);
		expect(actions.preflight(draft, advisor, "generate")).toEqual({ route: expected.route, error: expect.stringContaining("AI persona generation") });
		expect(await actions.generate(draft, advisor, "builders", new AbortController().signal)).toMatchObject({ ok: false, text: "", error: expect.stringContaining("AI persona generation") });
		expect(spy).not.toHaveBeenCalled();
		expect(draft).toEqual(before);
	});

	it("uses normal read-only argv, exact unsaved pins, private cwd and tiny prompt without leaking output", async () => {
		vi.stubEnv("BPX_COUNCIL_MODEL", "");
		const response = JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "OK private response text" } });
		const capture = fakeCli("codex", response, "PRIVATE STDERR SECRET");
		const draft = config();
		draft.council = { backends: { critic: "codex:unsaved@literal@high" } };
		draft.personas = { hidden: { stance: "against", systemPrompt: "PRIVATE PERSONA SECRET" } };
		const before = structuredClone(draft);
		const spy = vi.spyOn(backend, "callAdvisor");
		const result = await actions.test(draft, member, new AbortController().signal);
		expect(result).toMatchObject({ ok: true, route: "codex:unsaved@literal@high", text: "Route responded." });
		expect(JSON.stringify(result)).not.toContain("private response text");
		expect(JSON.stringify(result)).not.toContain("PRIVATE STDERR SECRET");
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		expect(invoked.argv).toEqual(["exec", "--json", "-c", "project_doc_max_bytes=0", "-c", "model_reasoning_effort=high", "--model", "unsaved@literal", "--sandbox", "read-only", "--skip-git-repo-check", "-"]);
		expect(invoked.input).toContain("Reply with OK only, at most 8 tokens.");
		expect(invoked.input.endsWith("=== User ===\nReply OK.\n")).toBe(true);
		expect(invoked.input.length).toBeLessThan(200);
		expect(JSON.stringify(invoked)).not.toContain("PRIVATE PERSONA SECRET");
		expect(invoked.files).toEqual([]);
		expect(invoked.cwd).toContain("bpx-council-action-");
		expect(invoked.cwd).not.toBe(process.cwd());
		expect(existsSync(invoked.cwd)).toBe(false);
		expect(spy.mock.calls[0][2]).toMatchObject({ isolate: true, timeoutMs: 15_000, maxStdoutBytes: 4096 });
		expect(draft).toEqual(before);
	});

	it.each(["BPX_COUNCIL_MODEL", "ANTHROPIC_MODEL"])("refuses conflicting %s without dispatch, keeps independent literal @ pin", async (name) => {
		vi.stubEnv("BPX_COUNCIL_MODEL", undefined);
		vi.stubEnv("ANTHROPIC_MODEL", undefined);
		vi.stubEnv(name, "ambient-model");
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config();
		draft.solo.backend = { type: "cli", command: "codex", model: "unsaved@literal", effort: "high" };
		expect(actions.preflight(draft, advisor).error).toContain("ambient override");
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: false, text: "", error: expect.stringContaining("ambient override") });
		expect(spy).not.toHaveBeenCalled();
		draft.council = { backends: { critic: "codex:seat@literal@high" } };
		expect(actions.preflight(draft, member)).toMatchObject({ route: "codex:seat@literal@high", error: undefined });
	});

	it.each([
		{ type: "cli", command: "codex", args: [] },
		{ type: "cli", command: "codex", args: ["exec"] },
		{ type: "cli", command: "codex", images: ["private.png"] },
		{ type: "cli", command: "codex", timeoutMs: 0 },
		{ type: "tmux", command: "codex" },
	] as const)("rejects unsafe Codex route %j before calls", async (route) => {
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config(); draft.solo.backend = structuredClone(route) as BpxCouncilConfig["solo"]["backend"];
		expect(actions.preflight(draft, advisor).error).toBeTruthy();
		expect(actions.preflight(draft, advisor, "generate").error).toBeTruthy();
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: false, text: "" });
		expect(await actions.generate(draft, advisor, "builders", new AbortController().signal)).toMatchObject({ ok: false, text: "" });
		expect(spy).not.toHaveBeenCalled();
	});

	it("blocks Windows Codex calls with no warning or dispatch", async () => {
		const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config(); draft.solo.backend = { type: "cli", command: "codex" };
		try {
			Object.defineProperty(process, "platform", { value: "win32", configurable: true });
			expect(actions.preflight(draft, advisor)).toEqual({ route: "codex", error: expect.stringContaining("Windows") });
			expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: false, text: "", error: expect.stringContaining("Windows") });
			expect(spy).not.toHaveBeenCalled();
		} finally { Object.defineProperty(process, "platform", platform); }
	});

	it.each([
		{ stream: "stdout", bytes: 4097, ceiling: 4096 },
		{ stream: "stderr", bytes: 65_537, ceiling: 65_536 },
	])("bounds actual Codex $stream without output leakage and removes scratch cwd", async ({ stream, bytes, ceiling }) => {
		const capture = fakeCli("codex", stream === "stdout" ? "x".repeat(bytes) : JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "PRIVATE RESPONSE" } }), stream === "stderr" ? "x".repeat(bytes) : "");
		const draft = config(); draft.solo.backend = { type: "cli", command: "codex" };
		const result = await actions.test(draft, advisor, new AbortController().signal);
		expect(result).toMatchObject({ ok: false, text: "", error: expect.stringContaining(`${stream} exceeded ${ceiling} bytes`) });
		expect(JSON.stringify(result)).not.toContain("PRIVATE RESPONSE");
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		expect(existsSync(invoked.cwd)).toBe(false);
	});

	it.skipIf(process.platform === "win32")("times out actual Codex with smaller draft bound and cleans descendants/private cwd", async () => {
		const { capture, ready } = fakeStalledCodex("ignore");
		const draft = config(); draft.solo.backend = { type: "cli", command: "codex", timeoutMs: 600 };
		const pending = actions.test(draft, advisor, new AbortController().signal);
		await waitForFile(ready);
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		try {
			expect(await pending).toMatchObject({ ok: false, text: "", error: '"codex" timed out after 600ms' });
			expect(processAlive(invoked.pid)).toBe(false);
			expect(processAlive(invoked.childPid)).toBe(false);
			expect(existsSync(invoked.cwd)).toBe(false);
			expect(draft.solo.backend.timeoutMs).toBe(600);
		} finally { try { process.kill(-invoked.pid, "SIGKILL"); } catch { /* Fixture already reaped. */ } }
	});

	it.skipIf(process.platform === "win32").each(["inherit", "ignore"] as const)("awaits genuine abort and TERM-resistant descendant cleanup with %s pipes", async (pipes) => {
		const { capture, ready } = fakeStalledCodex(pipes);
		const draft = config(); draft.solo.backend = { type: "cli", command: "codex" };
		const controller = new AbortController();
		let settled = false;
		const pending = actions.test(draft, advisor, controller.signal).then((result) => { settled = true; return result; });
		await waitForFile(ready);
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		try {
			expect(processAlive(invoked.childPid)).toBe(true);
			controller.abort();
			await new Promise((done) => setTimeout(done, 50));
			expect(settled).toBe(false);
			expect(existsSync(invoked.cwd)).toBe(true);
			expect(await pending).toMatchObject({ ok: false, text: "", cancelled: true, error: "Action cancelled." });
			expect(processAlive(invoked.pid)).toBe(false);
			expect(processAlive(invoked.childPid)).toBe(false);
			expect(existsSync(invoked.cwd)).toBe(false);
		} finally {
			controller.abort();
			try { process.kill(-invoked.pid, "SIGKILL"); } catch { /* Fixture already reaped. */ }
			await pending;
		}
	});

	it("preaborted Codex test makes zero calls or scratch writes", async () => {
		const capture = fakeCli("codex", "OK");
		const spy = vi.spyOn(backend, "callAdvisor");
		const draft = config(); draft.solo.backend = { type: "cli", command: "codex" };
		const controller = new AbortController(); controller.abort();
		expect(await actions.test(draft, advisor, controller.signal)).toMatchObject({ ok: false, cancelled: true, text: "" });
		expect(spy).not.toHaveBeenCalled();
		expect(existsSync(capture)).toBe(false);
	});
});

describe("offline action dispatch", () => {
	it("captures guarded Claude argv, private cwd, tiny prompt and no draft secrets", async () => {
		vi.stubEnv("BPX_COUNCIL_MODEL", "");
		const capture = fakeCli("claude", "\x1b[31mprovider arbitrary reply private-key-value");
		const draft = config();
		draft.personas = { private: { stance: "for", systemPrompt: "WORKSPACE PROMPT SECRET" } };
		const before = structuredClone(draft);
		const result = await actions.test(draft, member, new AbortController().signal);
		expect(result).toMatchObject({ ok: true, route: "claude:unsaved@literal@high", text: "Route responded." });
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		expect(invoked.argv).toEqual(["--model", "unsaved@literal", "--effort", "high", "--system-prompt", expect.stringContaining("at most 8 tokens"), "--tools", "", "-p"]);
		expect(invoked.input).toBe("Reply OK.\n");
		expect(JSON.stringify(invoked)).not.toContain("WORKSPACE PROMPT SECRET");
		expect(invoked.cwd).not.toBe(process.cwd());
		expect(existsSync(invoked.cwd)).toBe(false);
		expect(draft).toEqual(before);
	});

	it("retains every Pi unconditional guard and own private cwd", async () => {
		const capture = fakeCli("pi", "OK");
		const draft = config();
		draft.solo.backend = { type: "cli", command: "pi", model: "p/model@literal", effort: "low" };
		expect((await actions.test(draft, advisor, new AbortController().signal)).ok).toBe(true);
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		expect(invoked.argv.slice(0, PI_SAFETY_ARGS.length)).toEqual(PI_SAFETY_ARGS);
		expect(invoked.argv).toContain("p/model@literal");
		expect(invoked.cwd).toContain("bpx-council-pi-");
		expect(existsSync(invoked.cwd)).toBe(false);
	});

	it("preaborted calls do not dispatch or write CLI capture", async () => {
		const capture = fakeCli("claude", "OK");
		const spy = vi.spyOn(backend, "callAdvisor");
		const abort = new AbortController(); abort.abort();
		expect(await actions.test(config(), advisor, abort.signal)).toMatchObject({ ok: false, cancelled: true });
		expect(await actions.generate(config(), advisor, "builder", abort.signal)).toMatchObject({ ok: false, cancelled: true });
		expect(spy).not.toHaveBeenCalled();
		expect(existsSync(capture)).toBe(false);
	});

	it("generates from explicit focus and schema only, using selected independent route", async () => {
		const capture = fakeCli("claude", JSON.stringify(candidate));
		const draft = config();
		draft.council = { backends: { critic: "claude:generator@low" } };
		draft.personas = { hidden: { stance: "against", systemPrompt: "hidden prompt" } };
		const before = structuredClone(draft);
		const result = await actions.generate(draft, member, "Practical builders", new AbortController().signal);
		expect(result).toMatchObject({ ok: true, candidate, route: "claude:generator@low" });
		const invoked = JSON.parse(readFileSync(capture, "utf8"));
		expect(invoked.input).toBe('Description: "Practical builders"\n');
		expect(invoked.argv).toContain("generator");
		expect(JSON.stringify(invoked)).toContain("additionalProperties");
		expect(JSON.stringify(invoked)).not.toContain("hidden prompt");
		expect(existsSync(invoked.cwd)).toBe(false);
		expect(draft).toEqual(before);
	});

	it("bounds HTTP reply/time and never sends config prompts", async () => {
		vi.stubEnv("ANTHROPIC_API_KEY", "test-only-key");
		const fetch = vi.fn().mockResolvedValue(new Response(JSON.stringify({ content: [{ type: "text", text: "OK" }] })));
		vi.stubGlobal("fetch", fetch);
		const draft = config();
		draft.solo.backend = { type: "http", provider: "anthropic", timeoutMs: 250 };
		draft.personas = { private: { stance: "for", systemPrompt: "do not send" } };
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: true, route: "anthropic:claude-opus-4-8" });
		const body = JSON.parse(fetch.mock.calls[0][1].body);
		expect(body.max_tokens).toBe(8);
		expect(body.messages).toEqual([{ role: "user", content: "Reply OK." }]);
		expect(JSON.stringify(body)).not.toContain("do not send");
	});

	it("awaits transport cancellation cleanup before deleting scratch cwd or returning", async () => {
		let done!: () => void;
		const cleanup = new Promise<void>((resolve) => { done = resolve; });
		let cwd: string | undefined;
		const spy = vi.spyOn(backend, "callAdvisor").mockImplementation(async (_system, _user, _backend, signal, scratch) => {
			cwd = scratch;
			expect(signal).toBe(controller.signal);
			await cleanup;
			return { ok: false, text: "", error: "Advisor call cancelled" };
		});
		const controller = new AbortController();
		const draft = config();
		const before = structuredClone(draft);
		let settled = false;
		const pending = actions.test(draft, advisor, controller.signal).then((result) => { settled = true; return result; });
		controller.abort();
		await Promise.resolve();
		expect(spy).toHaveBeenCalledOnce();
		expect(settled).toBe(false);
		expect(existsSync(cwd!)).toBe(true);
		done();
		expect(await pending).toMatchObject({ ok: false, cancelled: true, text: "" });
		expect(existsSync(cwd!)).toBe(false);
		expect(draft).toEqual(before);
	});

	it("preserves smaller configured timeout and reports safe transport failure", async () => {
		const spy = vi.spyOn(backend, "callAdvisor").mockResolvedValue({ ok: false, text: "", error: '"claude" timed out after 70ms' });
		const draft = config(); draft.solo.backend!.timeoutMs = 70;
		expect(await actions.test(draft, advisor, new AbortController().signal)).toMatchObject({ ok: false, error: expect.stringContaining("70ms") });
		expect(spy.mock.calls[0][2].timeoutMs).toBe(70);
		expect(draft.solo.backend!.timeoutMs).toBe(70);
	});

	it("rejects bad generated schema without mutating draft or echoing response", async () => {
		fakeCli("claude", JSON.stringify({ ...candidate, extra: "secret response" }));
		const draft = config();
		const before = structuredClone(draft);
		expect(await actions.generate(draft, advisor, "builders", new AbortController().signal)).toMatchObject({ ok: false, text: "", error: expect.stringContaining("unknown fields") });
		expect(draft).toEqual(before);
	});
});

describe("strict persona JSON parser", () => {
	it("accepts literal JSON and one Markdown fence", () => {
		expect(parsePersonaCandidate(JSON.stringify(candidate))).toEqual(candidate);
		expect(parsePersonaCandidate(`\`\`\`json\n${JSON.stringify(candidate)}\n\`\`\``)).toEqual(candidate);
	});
	it.each([
		{ ...candidate, name: "synthesizer" }, { ...candidate, name: "A" }, { ...candidate, name: "a".repeat(33) },
		{ ...candidate, stance: "maybe" }, { ...candidate, systemPrompt: " " }, { ...candidate, systemPrompt: "x".repeat(8001) },
		{ ...candidate, systemPrompt: "\x1b[31mnot terminal text" }, { ...candidate, extra: true }, [candidate], null,
	])("rejects invalid candidate %j", (value) => {
		expect(() => parsePersonaCandidate(JSON.stringify(value))).toThrow();
	});
	it("never executes content or accepts mixed prose/fences", () => {
		expect(() => parsePersonaCandidate('require("node:fs").writeFileSync("bad", "bad")')).toThrow("literal JSON");
		expect(() => parsePersonaCandidate(`Result: ${JSON.stringify(candidate)}`)).toThrow("literal JSON");
	});
});
