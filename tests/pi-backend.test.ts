import { spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { advisorTransportError, callCliAdvisor } from "../src/backend.js";
import { CLI_BACKENDS } from "../src/cli-registry.js";
import { availableBackends, backendLabel, detectBackend, parseBackendArg } from "../src/detect.js";
import { backendListsModels, listEfforts, listModels } from "../src/models-list.js";
import { parsePiModels, piArgs, PI_SAFETY_ARGS, PI_THINKING_LEVELS, preparePiInvocation } from "../src/pi-backend.js";

const fixtures: string[] = [];
const table = "provider model context max-out thinking images\nanthropic claude-test 200K 64K yes yes\nopenrouter vendor/model:revision 1.5M 8192 no no\n";

/** Create an executable fake CLI without using private accounts or live providers. */
function fakeCli(body: string, name = "pi"): { dir: string; capture: string } {
	const dir = mkdtempSync(join(tmpdir(), "bpx-pi-test-"));
	fixtures.push(dir);
	const capture = join(dir, "capture.json");
	const script = join(dir, name);
	writeFileSync(script, `#!${process.execPath}\n${body}\n`);
	chmodSync(script, 0o755);
	vi.stubEnv("PATH", `${dir}${delimiter}/usr/bin${delimiter}/bin`);
	vi.stubEnv("PI_CAPTURE", capture);
	return { dir, capture };
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
	for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Pi advisor preset", () => {
	it("uses guarded stdin text mode, provider/model pins and static thinking levels", async () => {
		const spec = CLI_BACKENDS.pi;
		expect(spec.prompt).toBe("stdin");
		expect(spec.runArgs({ model: "openrouter/vendor/model", effort: "max", isolate: false })).toEqual([
			...PI_SAFETY_ARGS, "--system-prompt", "", "--append-system-prompt", "",
			"--model", "openrouter/vendor/model", "--thinking", "max",
		]);
		expect(backendListsModels("pi")).toBe(true);
		expect(await listEfforts("pi", "anything")).toEqual({ levels: PI_THINKING_LEVELS });
		expect(PI_THINKING_LEVELS).not.toContain("ultra");
	});

	it.each([false, true])("passes persona literally in private file, isolate=%s", async (isolate) => {
		const { dir, capture } = fakeCli(`
const fs = require('node:fs');
const args = process.argv.slice(2);
const path = args[args.indexOf('--system-prompt') + 1];
let input = '';
process.stdin.on('data', d => input += d);
process.stdin.on('end', () => {
 fs.writeFileSync(process.env.PI_CAPTURE, JSON.stringify({ args, path, cwd: process.cwd(), input, persona: fs.readFileSync(path, 'utf8'), mode: fs.statSync(path).mode & 511, dirMode: fs.statSync(process.cwd()).mode & 511 }));
 process.stdout.write('Advisor response');
});`);
		const persona = join(dir, "existing.md");
		writeFileSync(persona, "SECRET FILE CONTENT");
		const result = await callCliAdvisor(persona, "Question", { type: "cli", command: "pi", isolate, model: "anthropic/claude-test", effort: "high" });
		expect(result).toEqual({ ok: true, text: "Advisor response" });
		const seen = JSON.parse(readFileSync(capture, "utf8"));
		expect(seen.persona).toBe(persona);
		expect(seen.input).toBe("Question\n");
		expect(seen.args).toEqual([...PI_SAFETY_ARGS, "--system-prompt", seen.path, "--append-system-prompt", "", "--model", "anthropic/claude-test", "--thinking", "high"]);
		expect(seen.mode).toBe(0o600);
		expect(seen.dirMode).toBe(0o700);
		expect(seen.cwd).not.toBe(process.cwd());
		expect(seen.args).not.toContain(persona);
		expect(existsSync(seen.cwd)).toBe(false);
	});

	it.each([[[]], [["--tools", "bash"]], [["--extension", "malicious.ts"]]])("refuses all custom args before spawning: %j", async (args) => {
		const { capture } = fakeCli("require('node:fs').writeFileSync(process.env.PI_CAPTURE, 'spawned')");
		const config = { type: "cli" as const, command: "pi", args };
		expect(advisorTransportError(config)).toMatch(/custom CLI args are not allowed/);
		expect(await callCliAdvisor("SECRET", "Q", config)).toMatchObject({ ok: false, text: "" });
		expect(existsSync(capture)).toBe(false);
	});

	it("rejects invalid thinking levels before any seat executes without echoing input", async () => {
		const { capture } = fakeCli("require('node:fs').writeFileSync(process.env.PI_CAPTURE, 'spawned')");
		for (const effort of ["ultra", "", "SECRET invalid effort"]) {
			const backend = { type: "cli" as const, command: "pi", effort };
			expect(advisorTransportError(backend)).toMatch(/thinking level unsupported/);
			const result = await callCliAdvisor("SECRET", "Q", backend);
			expect(result.ok).toBe(false);
			expect(result.error).not.toContain("SECRET");
		}
		expect(existsSync(capture)).toBe(false);
	});

	it("treats provider failure as failure, gives compatibility advice, cleans prompt", async () => {
		const { capture } = fakeCli(`const fs = require('node:fs'); fs.writeFileSync(process.env.PI_CAPTURE, process.cwd()); process.stdout.write('premature answer'); process.stderr.write('SECRET prompt and token'); process.exit(1);`);
		const result = await callCliAdvisor("SECRET", "Q", { type: "cli", command: "pi" });
		expect(result).toMatchObject({ ok: false, text: "", error: expect.stringMatching(/Pi exited 1.*compatibility.*safety flags were not relaxed/) });
		expect(JSON.stringify(result)).not.toContain("SECRET");
		expect(existsSync(readFileSync(capture, "utf8"))).toBe(false);
	});

	it.skipIf(process.platform === "win32")("timeout kills resistant descendant and removes private cwd/persona", async () => {
		const { capture } = fakeCli(`
const fs = require('node:fs'); const cp = require('node:child_process');
const args = process.argv.slice(2); const prompt = args[args.indexOf('--system-prompt') + 1];
const info = {cwd:process.cwd(), prompt, leader:process.pid};
const code = "process.on('SIGTERM',()=>{}); const fs=require('node:fs'); fs.writeFileSync(process.env.PI_CAPTURE, " + JSON.stringify(JSON.stringify(info)) + "); setTimeout(()=>fs.writeFileSync(process.env.PI_CAPTURE+'.survived','alive'),2000); setInterval(()=>{},1000)";
cp.spawn(process.execPath, ['-e',code], {stdio:'inherit'});
process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`);
		let seen: { cwd: string; prompt: string; leader: number } | undefined;
		try {
			const result = await callCliAdvisor("SECRET persona", "Q", { type: "cli", command: "pi", timeoutMs: 800 });
			expect(result).toMatchObject({ ok: false, text: "", error: '"pi" timed out after 800ms' });
			seen = JSON.parse(readFileSync(capture, "utf8"));
			expect(existsSync(seen!.cwd)).toBe(false); expect(existsSync(seen!.prompt)).toBe(false);
			await new Promise(resolve => setTimeout(resolve, 2300));
			expect(existsSync(`${capture}.survived`)).toBe(false);
			expect(JSON.stringify(result)).not.toContain("SECRET");
		} finally {
			if (seen) { try { process.kill(-seen.leader, "SIGKILL"); } catch { /* Group already gone. */ } }
		}
	}, 10000);
	it("detects Pi as trusted explicit and installed choice without changing auto order", () => {
		fakeCli("process.exit(0)");
		vi.stubEnv("ANTHROPIC_API_KEY", "");
		const spec = parseBackendArg("pi:openrouter/vendor/model@high");
		expect(detectBackend(spec)).toMatchObject({ type: "cli", command: "pi", model: "openrouter/vendor/model", effort: "high" });
		expect(backendLabel(detectBackend(spec))).toBe("pi:openrouter/vendor/model@high");
		expect(availableBackends()).toContainEqual({ name: "pi", kind: "cli", detail: "Pi coding agent · on PATH · tools/extensions disabled by preset" });
		expect(() => detectBackend()).toThrow(/No advisor backend detected/);
	});
});

describe("Pi model discovery", () => {
	it("validates six columns, strips ANSI, keeps provider qualification, drops notices", () => {
		expect(parsePiModels(`NOTICE fake 200K 64K yes yes\n\x1b[32m${table}\x1b[0m\n${table}\nwrong bad ?? 64K yes yes\na b 1K 2K maybe yes\nSECRET garbage\n`)).toEqual(["anthropic/claude-test", "openrouter/vendor/model:revision"]);
		expect(parsePiModels("No models available. Login first.")).toEqual([]);
	});

	it("lists asynchronously with full guards and a private empty system override", async () => {
		const { capture } = fakeCli(`const fs = require('node:fs'); const args = process.argv.slice(2); const prompt = args[args.indexOf('--system-prompt')+1]; fs.writeFileSync(process.env.PI_CAPTURE, JSON.stringify({args, cwd:process.cwd(), persona:fs.readFileSync(prompt,'utf8')})); process.stdout.write(${JSON.stringify(table)});`);
		const result = await listModels("pi");
		expect(result).toEqual(["anthropic/claude-test", "openrouter/vendor/model:revision"]);
		const seen = JSON.parse(readFileSync(capture, "utf8"));
		expect(seen.persona).toBe("");
		expect(seen.args.slice(0, PI_SAFETY_ARGS.length)).toEqual(PI_SAFETY_ARGS);
		expect(seen.args).toContain("--list-models");
		expect(seen.args.at(-1)).toBe("--list-models");
		expect(existsSync(seen.cwd)).toBe(false);
	});

	it("accepts a normal Pi stderr catalog above diagnostic-log size", async () => {
		const rows = Array.from({ length: 1000 }, (_, index) => `provider vendor/${"model-".repeat(10)}${index} 200K 64K yes no`).join("\n");
		const catalog = `provider model context max-out thinking images\n${rows}\n`;
		expect(Buffer.byteLength(catalog)).toBeGreaterThan(64 * 1024);
		fakeCli(`process.stderr.write(${JSON.stringify(catalog)})`);
		expect(await listModels("pi")).toHaveLength(1000);
	});
	it("skips pre-aborted discovery without spawning", async () => {
		const { capture } = fakeCli("require('node:fs').writeFileSync(process.env.PI_CAPTURE, 'spawned')");
		const controller = new AbortController();
		controller.abort();
		expect(await listModels("pi", controller.signal)).toEqual([]);
		expect(existsSync(capture)).toBe(false);
	});

	it("remains responsive and cancellation cleans private cwd", async () => {
		const { capture } = fakeCli("require('node:fs').writeFileSync(process.env.PI_CAPTURE, process.cwd()); setInterval(()=>{},1000)");
		const controller = new AbortController();
		const pending = listModels("pi", controller.signal);
		await vi.waitFor(() => expect(existsSync(capture)).toBe(true));
		controller.abort();
		expect(await pending).toEqual([]);
		expect(existsSync(readFileSync(capture, "utf8"))).toBe(false);
	});

	it("times out stalled discovery and clears timers before returning", async () => {
		const { capture } = fakeCli("require('node:fs').writeFileSync(process.env.PI_CAPTURE, process.cwd()); setInterval(()=>{},1000)");
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const pending = listModels("pi");
		await vi.waitFor(() => expect(existsSync(capture)).toBe(true));
		await vi.advanceTimersByTimeAsync(15000);
		await vi.advanceTimersByTimeAsync(1000);
		expect(await pending).toEqual([]);
		expect(vi.getTimerCount()).toBe(0);
		expect(existsSync(readFileSync(capture, "utf8"))).toBe(false);
	});

	it("removes successful discovery's abort listener and timeout", async () => {
		fakeCli(`process.stdout.write(${JSON.stringify(table)})`);
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const controller = new AbortController();
		expect(await listModels("pi", controller.signal)).toContain("anthropic/claude-test");
		expect(vi.getTimerCount()).toBe(0);
		const kill = vi.spyOn(process, "kill");
		try {
			controller.abort();
			await vi.advanceTimersByTimeAsync(16000);
			expect(kill).not.toHaveBeenCalled();
		} finally { kill.mockRestore(); }
	});

	it.skipIf(process.platform === "win32")("cancellation kills descendant even after leader exits on SIGTERM", async () => {
		const { dir, capture } = fakeCli(`
const fs = require('node:fs'); const cp = require('node:child_process');
const child = cp.spawn(process.execPath, ['-e', "process.on('SIGTERM',()=>{}); require('node:fs').writeFileSync(process.env.PI_CAPTURE,'ready'); setTimeout(()=>require('node:fs').writeFileSync(process.env.PI_CAPTURE+'.survived','alive'),1500); setInterval(()=>{},1000)"], {stdio:'inherit'});
process.on('SIGTERM',()=>process.exit(0)); setInterval(()=>{},1000);`);
		const controller = new AbortController();
		const pending = listModels("pi", controller.signal);
		try {
			await vi.waitFor(() => expect(existsSync(capture)).toBe(true));
			controller.abort();
			expect(await pending).toEqual([]);
			await new Promise((resolve) => setTimeout(resolve, 1700));
			expect(existsSync(join(dir, "capture.json.survived"))).toBe(false);
		} finally { controller.abort(); }
	});

	it.each(["stdout", "stderr"])("bounds %s without exposing partial output or secrets", async (stream) => {
		fakeCli(`process.stdout.write(${JSON.stringify(table)}); process.${stream}.write('SECRET'.repeat(250000)); setInterval(()=>{},1000);`);
		expect(await listModels("pi")).toEqual([]);
	});

	it("returns manual entry fallback on nonzero exit and empty output", async () => {
		fakeCli(`process.stdout.write(${JSON.stringify(table)}); process.stderr.write('SECRET'); process.exit(1)`);
		expect(await listModels("pi")).toEqual([]);
		fakeCli("process.exit(0)");
		expect(await listModels("pi")).toEqual([]);
	});

	it("uses async cancellable per-model Codex efforts, falling back to static levels", async () => {
		fakeCli("setInterval(()=>{},1000)", "codex");
		const controller = new AbortController();
		const pending = listEfforts("codex", "model", controller.signal);
		controller.abort();
		expect(await pending).toEqual({ levels: ["low", "medium", "high", "xhigh"] });
	});
});

// Opt in with an absolute Pi CLI entry path; never discover a user's configured wrapper.
const installedCli = process.env.BPX_TEST_PI_CLI ?? "";
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const supportsInstalledPi = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 19);

/** Seed a reproducible custom chat model; offline discovery needs no remote catalog. */
function seedPiModel(agent: string, baseUrl = "http://127.0.0.1:1/v1"): void {
	writeFileSync(join(agent, "models.json"), JSON.stringify({ providers: { "mock-provider": {
		baseUrl, api: "openai-completions", apiKey: "fixture-not-a-key",
		models: [{ id: "mock-model", name: "Local fixture", reasoning: false, input: ["text"],
			contextWindow: 8192, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
	} } }));
}

describe.skipIf(!supportsInstalledPi || !installedCli || !existsSync(installedCli))("installed Pi startup, isolated HOME only", () => {
	it("proves native startup migrations still run, guards stop extension execution", () => {
		const home = mkdtempSync(join(tmpdir(), "bpx-pi-installed-"));
		fixtures.push(home);
		const agent = join(home, ".pi", "agent");
		const cwd = join(home, "project");
		const marker = join(home, "extension-ran");
		for (const base of [agent, join(cwd, ".pi")]) {
			mkdirSync(join(base, "commands"), { recursive: true });
			mkdirSync(join(base, "extensions"), { recursive: true });
			writeFileSync(join(base, "extensions", "trap.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); throw new Error('extension executed');`);
			writeFileSync(join(base, "SYSTEM.md"), "IGNORED SYSTEM");
			writeFileSync(join(base, "APPEND_SYSTEM.md"), "IGNORED APPEND");
		}
		// Synthetic legacy credential, never a user's auth file; no provider requests.
		writeFileSync(join(agent, "settings.json"), JSON.stringify({ apiKeys: { anthropic: "fixture-not-a-key" } }));
		seedPiModel(agent);
		const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: dirname(process.execPath), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1" };
		const native = spawnSync(process.execPath, [installedCli, ...piArgs(), "--list-models"], { cwd, env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
		expect(native.status, native.stderr).toBe(0);
		expect(existsSync(marker)).toBe(false);
		expect(existsSync(join(cwd, ".pi", "prompts"))).toBe(true);
		expect(existsSync(join(agent, "prompts"))).toBe(true);
		expect(existsSync(join(agent, "auth.json"))).toBe(true);
		// Pi 1.0.0's guarded metadata invocation takes over stdout and sends its table to stderr.
		expect(parsePiModels(`${native.stdout}\n${native.stderr}`)).toContain("mock-provider/mock-model");
		const prepared = preparePiInvocation("literal persona");
		try {
			expect(statSync(prepared.systemPromptFile).mode & 0o777).toBe(0o600);
			const guarded = spawnSync(process.execPath, [installedCli, ...piArgs(prepared), "--list-models"], { cwd: prepared.cwd, env, encoding: "utf8", timeout: 15000, maxBuffer: 1024 * 1024 });
			expect(guarded.status, guarded.stderr).toBe(0);
			expect(parsePiModels(`${guarded.stdout}\n${guarded.stderr}`)).toContain("mock-provider/mock-model");
			expect(existsSync(marker)).toBe(false);
		} finally { prepared.cleanup(); }
	}, 35000);

	it("runs actual Pi through adapter against loopback SSE only, with literal persona and no tools or inherited prompts", async () => {
		const requests: Array<{ url?: string; authorization?: string; body: Record<string, any> }> = [];
		const server = createServer((req, res) => {
			let body = "";
			req.on("data", (chunk) => { body += chunk; });
			req.on("end", () => {
				requests.push({ url: req.url, authorization: req.headers.authorization, body: JSON.parse(body) });
				res.writeHead(200, { "content-type": "text/event-stream" });
				const chunk = { id: "fixture-chat", object: "chat.completion.chunk", created: 1, model: "mock-model" };
				res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: "assistant", content: "Local SSE advisor token" }, finish_reason: null }] })}\n\n`);
				res.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 8, completion_tokens: 5, total_tokens: 13 } })}\n\n`);
				res.end("data: [DONE]\n\n");
			});
		});
		await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
		const address = server.address();
		if (!address || typeof address === "string") throw new Error("Loopback fixture did not bind TCP");
		try {
			const home = mkdtempSync(join(tmpdir(), "bpx-pi-sse-"));
			fixtures.push(home);
			const agent = join(home, ".pi", "agent");
			const marker = join(home, "extension-ran");
			mkdirSync(join(agent, "extensions"), { recursive: true });
			writeFileSync(join(agent, "extensions", "trap.ts"), `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(marker)}, 'loaded'); throw new Error('extension executed');`);
			for (const name of ["SYSTEM.md", "APPEND_SYSTEM.md", "AGENTS.md"]) writeFileSync(join(agent, name), `GLOBAL_INHERITED_${name}`);
			seedPiModel(agent, `http://127.0.0.1:${address.port}/v1`);
			const env = { HOME: home, PI_CODING_AGENT_DIR: agent, PATH: dirname(process.execPath), PI_OFFLINE: "1", PI_TELEMETRY: "0", PI_SKIP_VERSION_CHECK: "1", NO_PROXY: "127.0.0.1" };
			// Wrapper drops all inherited credentials/proxy settings; only the synthetic fixture survives.
			const { capture } = fakeCli(`
const fs = require('node:fs'); const path = require('node:path'); const cp = require('node:child_process');
const cwd = process.cwd(); const args = process.argv.slice(2);
fs.mkdirSync(path.join(cwd, '.pi'), { recursive: true });
for (const name of ['SYSTEM.md','APPEND_SYSTEM.md']) fs.writeFileSync(path.join(cwd, '.pi', name), 'PROJECT_INHERITED_' + name);
fs.writeFileSync(path.join(cwd, 'AGENTS.md'), 'PROJECT_INHERITED_AGENTS');
fs.writeFileSync(process.env.PI_CAPTURE, JSON.stringify({cwd, args}));
const child = cp.spawn(${JSON.stringify(process.execPath)}, [${JSON.stringify(installedCli)}, ...args], {stdio:'inherit', env:${JSON.stringify(env)}});
child.on('error', () => process.exit(1)); child.on('exit', code => process.exit(code ?? 1));`);
			const models = await listModels("pi");
			expect(models).toContain("mock-provider/mock-model");
			expect(requests).toHaveLength(0);
			const listCapture = JSON.parse(readFileSync(capture, "utf8"));
			expect(existsSync(listCapture.cwd)).toBe(false);
			const persona = join(home, "literal-persona.md");
			writeFileSync(persona, "PERSONA_FILE_MUST_NOT_BE_READ");
			const result = await callCliAdvisor(persona, "Review this fixture", { type: "cli", command: "pi", model: "mock-provider/mock-model", effort: "off", isolate: false, timeoutMs: 15000 });
			expect(result).toEqual({ ok: true, text: "Local SSE advisor token" });
			expect(requests).toHaveLength(1);
			const request = requests[0];
			expect(request.url).toBe("/v1/chat/completions");
			expect(request.authorization).toBe("Bearer fixture-not-a-key");
			expect(request.body.model).toBe("mock-model");
			expect(request.body.stream).toBe(true);
			expect(request.body.tools ?? []).toEqual([]);
			const messages = request.body.messages as Array<{ role: string; content: unknown }>;
			const system = messages.filter((m) => m.role === "system" || m.role === "developer");
			expect(system).toHaveLength(1);
			expect(JSON.stringify(system)).toContain(persona);
			expect(JSON.stringify(request.body)).not.toMatch(/INHERITED|PERSONA_FILE_MUST_NOT_BE_READ/);
			expect(JSON.stringify(messages.filter((m) => m.role === "user"))).toContain("Review this fixture");
			expect(existsSync(marker)).toBe(false);
			const callCapture = JSON.parse(readFileSync(capture, "utf8"));
			expect(callCapture.args.slice(0, PI_SAFETY_ARGS.length)).toEqual(PI_SAFETY_ARGS);
			expect(existsSync(callCapture.cwd)).toBe(false);
			expect(existsSync(join(agent, "sessions"))).toBe(false);
		} finally {
			server.closeAllConnections();
			await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
		}
	}, 35000);
});
