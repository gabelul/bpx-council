import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { callCliAdvisor, type CliBackendConfig, type BackendResult } from "../src/backend.js";

// Opt-in only. This proves local transport, not account authentication or billing.
const binary = process.env.BPX_TEST_CODEX_CLI;
const installedDist = process.env.BPX_TEST_COUNCIL_DIST;
const answer = "fixture hello";
const model = "gpt-5.1";
const effort = "high";
const persona = "Answer supplied context only. Do not call tools.";
const question = "Return fixture hello.";
const expectedPrompt = `${persona}\n\n---\n\n=== User ===\n${question}\n`;
const expectedArgs = ["exec", "--json", "-c", "project_doc_max_bytes=0", "-c", "model_reasoning_effort=high",
	"--model", model, "--sandbox", "read-only", "--skip-git-repo-check", "-"];
type Caller = (system: string, user: string, backend: CliBackendConfig, signal?: AbortSignal, cwd?: string) => Promise<BackendResult>;

/** Encode Responses events as named SSE frames. @param events JSON events. @returns SSE wire body. */
function sse(events: Array<Record<string, unknown>>): string {
	return events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("");
}

/** Start a loopback-only server. @param server Fixture server. @returns Bound port. */
async function listen(server: Server): Promise<number> {
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
	});
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Fixture needs TCP loopback address");
	return address.port;
}

/** Wait for process/socket cleanup without fixed sleeps. @param check Completion predicate. @returns After completion, or throws. */
async function waitFor(check: () => boolean): Promise<void> {
	const deadline = Date.now() + 2500;
	while (!check()) {
		if (Date.now() >= deadline) throw new Error("Fixture cleanup did not complete");
		await new Promise((resolve) => setTimeout(resolve, 20));
	}
}

/** Check process existence. @param pid Native Codex PID. @returns Whether PID remains alive. */
function alive(pid: number): boolean {
	try { process.kill(pid, 0); return true; }
	catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
		throw error;
	}
}

/** Prove sandbox blocks nonloopback before launching Codex. @param profile SBPL file. @param port Fixture port. @param env Scrubbed environment. @param log Log destination. @returns After successful safety checks. */
async function checkSandbox(profile: string, port: number, env: NodeJS.ProcessEnv, log: string): Promise<void> {
	const probe = `const net = require('node:net');
async function connect(host, port) {
  return new Promise(resolve => {
    const socket = net.connect({host, port});
    socket.setTimeout(800);
    socket.once('connect', () => { socket.destroy(); resolve('connected'); });
    socket.once('error', error => resolve(error.code));
    socket.once('timeout', () => { socket.destroy(); resolve('timeout'); });
  });
}
(async () => {
  const results = {loopback: await connect('127.0.0.1', ${port}), ipv4: await connect('192.0.2.1', 443), ipv6: await connect('2001:db8::1', 443)};
  console.log(JSON.stringify(results));
  process.exit(results.loopback === 'connected' && results.ipv4 === 'EPERM' && results.ipv6 === 'EPERM' ? 0 : 1);
})().catch(error => { console.error(error); process.exit(1); });`;
	const output = await new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
		const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, process.execPath, "-e", probe], {
			env, cwd: env.HOME, stdio: ["ignore", "pipe", "pipe"],
		});
		let stdout = ""; let stderr = "";
		child.stdout.on("data", (data) => { stdout += data; });
		child.stderr.on("data", (data) => { stderr += data; });
		child.once("error", reject);
		child.once("close", (code) => resolve({ code, stdout, stderr }));
	});
	writeFileSync(log, JSON.stringify(output, null, 2));
	if (output.code !== 0) throw new Error(`Loopback-only sandbox not proven; refusing native Codex. See ${log}`);
	expect(JSON.parse(output.stdout)).toEqual({ loopback: "connected", ipv4: "EPERM", ipv6: "EPERM" });
}

describe.skipIf(!binary)("native Codex loopback transport (no real accounts)", () => {
	it("uses preset argv, EOF and JSONL; kills stalled native response, including optional installed dist", async () => {
		if (process.platform !== "darwin" || !existsSync("/usr/bin/sandbox-exec")) {
			throw new Error("Opt-in native fixture requires macOS sandbox-exec; refusing unconfined Codex");
		}
		if (!binary || !isAbsolute(binary) || !existsSync(binary)) throw new Error("BPX_TEST_CODEX_CLI must name absolute existing native binary");
		if (installedDist && !isAbsolute(installedDist)) throw new Error("BPX_TEST_COUNCIL_DIST must name absolute installed dist directory");
		const realHome = homedir();
		const root = mkdtempSync("/tmp/bpx-codex-native-");
		const home = join(root, "home"); const codexHome = join(root, "codex-home");
		const cwd = join(root, "cwd"); const bin = join(root, "bin"); const temp = join(root, "tmp");
		for (const path of [home, codexHome, cwd, bin, temp]) mkdirSync(path);
		const profile = join(root, "loopback.sb");
		writeFileSync(profile, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:*"))\n` +
			`(deny file-read* (literal ${JSON.stringify(join(realHome, ".codex/config.toml"))}) (literal ${JSON.stringify(join(realHome, ".codex/auth.json"))}))\n`);
		// Test env is allowlisted, not inherited. Claude-host marker intentionally survives.
		const env: NodeJS.ProcessEnv = {
			HOME: home, CODEX_HOME: codexHome, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"),
			TMPDIR: temp, PATH: `${bin}:/usr/bin:/bin`, LANG: "en_US.UTF-8", TERM: "dumb", NO_COLOR: "1",
			OPENAI_API_KEY: "fixture-fake-token-not-an-account", CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "fixture-host",
		};
		let stalled = false;
		const requests: Array<{ method?: string; url?: string; body: Record<string, unknown>; authorization?: string }> = [];
		const unexpected: string[] = [];
		let stallClosed = false;
		const server = createServer((request, response) => {
			if (request.method === "GET" && request.url?.startsWith("/v1/models")) {
				response.setHeader("content-type", "application/json"); response.end('{"data":[],"models":[]}'); return;
			}
			if (request.method !== "POST" || request.url !== "/v1/responses") {
				unexpected.push(`${request.method} ${request.url}`); response.writeHead(404); response.end(); return;
			}
			let body = "";
			request.on("data", (data) => { body += data; });
			request.on("end", () => {
				try {
					requests.push({ method: request.method, url: request.url, body: JSON.parse(body), authorization: request.headers.authorization });
					response.writeHead(200, { "content-type": "text/event-stream" });
					response.write(sse([{ type: "response.created", response: { id: "resp1" } }]));
					if (stalled) { response.once("close", () => { stallClosed = true; }); return; }
					response.end(sse([
						{ type: "response.output_item.done", item: { type: "message", role: "assistant", id: "m1", content: [{ type: "output_text", text: answer }] } },
						{ type: "response.completed", response: { id: "resp1", usage: { input_tokens: 0, input_tokens_details: null, output_tokens: 0, output_tokens_details: null, total_tokens: 0 } } },
					]));
				} catch (error) { unexpected.push(String(error)); response.writeHead(400); response.end(); }
			});
		});
		const savedEnv = process.env;
		try {
			const port = await listen(server);
			writeFileSync(join(codexHome, "config.toml"), `model_provider = "fixture"\nmodel = "${model}"\n` +
				`[model_providers.fixture]\nname = "Fixture"\nbase_url = "http://127.0.0.1:${port}/v1"\nwire_api = "responses"\nrequires_openai_auth = false\nsupports_websockets = false\n` +
				`[features]\napi_key_model_discovery = false\nenable_request_compression = false\n[analytics]\nenabled = false\n[feedback]\nenabled = false\n` +
				`[otel]\nexporter = "none"\ntrace_exporter = "none"\nmetrics_exporter = "none"\n`);
			await checkSandbox(profile, port, env, join(root, "sandbox-probe.json"));
			// No version probe until sandbox and scrubbed HOME are both proven usable.
			const version = spawnSync("/usr/bin/sandbox-exec", ["-f", profile, binary, "--version"], { env, cwd, encoding: "utf8", timeout: 5000 });
			writeFileSync(join(root, "version.json"), JSON.stringify({ status: version.status, stdout: version.stdout, stderr: version.stderr }));
			expect(version.status).toBe(0);
			const callers: Array<{ name: string; call: Caller }> = [{ name: "source", call: callCliAdvisor }];
			if (installedDist) {
				// Import pure backend only; index.js starts CLI and reads host config.
				const installed = await import(/* @vite-ignore */ pathToFileURL(join(installedDist, "backend.js")).href);
				callers.push({ name: "installed", call: installed.callCliAdvisor });
			}
			for (const caller of callers) {
				for (const mode of ["answer", "stall"]) {
					stalled = mode === "stall"; stallClosed = false;
					const log = join(root, `${caller.name}-${mode}`);
					// Wrapper logs and enforces isolation only. Native argv stays byte-for-byte unchanged.
					writeFileSync(join(bin, "codex"), `#!${process.execPath}\n` +
						`const fs = require('node:fs'); const {spawn} = require('node:child_process');\n` +
						`const args = process.argv.slice(2); const env = ${JSON.stringify(env)}; const log = ${JSON.stringify(log)};\n` +
						`fs.writeFileSync(log+'.argv.json', JSON.stringify(args)); fs.writeFileSync(log+'.wrapper.pid',String(process.pid));\n` +
						`fs.writeFileSync(log+'.stdout',''); fs.writeFileSync(log+'.stderr','');\n` +
						`fs.writeFileSync(log+'.env.json', JSON.stringify({HOME:process.env.HOME,CODEX_HOME:process.env.CODEX_HOME,CLAUDECODE:process.env.CLAUDECODE,CLAUDE_CODE_ENTRYPOINT:process.env.CLAUDE_CODE_ENTRYPOINT}));\n` +
						`const child = spawn('/usr/bin/sandbox-exec', ['-f', ${JSON.stringify(profile)}, ${JSON.stringify(binary)}, ...args], {env,cwd:${JSON.stringify(cwd)},stdio:['pipe','pipe','pipe']});\n` +
						`fs.writeFileSync(log+'.pid', String(child.pid));\n` +
						`process.stdin.on('data', data => {fs.appendFileSync(log+'.stdin',data);child.stdin.write(data);});\n` +
						`process.stdin.on('end',()=>{fs.writeFileSync(log+'.eof','EOF');child.stdin.end();}); child.stdin.on('error',()=>{});\n` +
						`child.stdout.on('data',data=>{fs.appendFileSync(log+'.stdout',data);process.stdout.write(data);});\n` +
						`child.stderr.on('data',data=>{fs.appendFileSync(log+'.stderr',data);process.stderr.write(data);});\n` +
						`child.on('error',error=>{fs.writeFileSync(log+'.spawn-error',String(error));process.exit(1);});\n` +
						`child.on('close',(code,signal)=>{fs.writeFileSync(log+'.exit.json',JSON.stringify({code,signal}));process.exit(code === null ? 1 : code);});\n`);
					chmodSync(join(bin, "codex"), 0o755);
					process.env = env;
					const before = requests.length;
					const timeoutMs = stalled ? 3000 : 15000;
					const started = Date.now();
					const result = await caller.call(persona, question, { type: "cli", command: "codex", model, effort, isolate: true, timeoutMs }, undefined, cwd);
					process.env = savedEnv;
					writeFileSync(log + ".result.json", JSON.stringify({ result, elapsedMs: Date.now() - started }, null, 2));
					writeFileSync(log + ".requests.json", JSON.stringify(requests.slice(before), null, 2));
					expect(JSON.parse(readFileSync(log + ".argv.json", "utf8"))).toEqual(expectedArgs);
					expect(JSON.parse(readFileSync(log + ".env.json", "utf8"))).toEqual({ HOME: home, CODEX_HOME: codexHome, CLAUDECODE: "1", CLAUDE_CODE_ENTRYPOINT: "fixture-host" });
					expect(readFileSync(log + ".eof", "utf8")).toBe("EOF");
					expect(readFileSync(log + ".stdin", "utf8")).toBe(expectedPrompt);
					expect(unexpected).toEqual([]);
					expect(requests.length - before).toBe(1);
					const request = requests[before];
					expect(request.body.model).toBe(model);
					expect(request.body.stream).toBe(true);
					expect(request.body.reasoning).toMatchObject({ effort });
					expect(!request.authorization || request.authorization === `Bearer ${env.OPENAI_API_KEY}`).toBe(true);
					const input = request.body.input as Array<{ role?: string; content?: Array<{ type?: string; text?: string }> }>;
					expect(input.filter((item) => item.role === "user").flatMap((item) => item.content ?? [])
						.filter((part) => part.type === "input_text").map((part) => part.text)).toContain(expectedPrompt);
					if (stalled) {
						expect(result).toEqual({ ok: false, text: "", error: `"codex" timed out after ${timeoutMs}ms` });
						expect(Date.now() - started).toBeLessThan(timeoutMs + 2500);
						const pid = Number(readFileSync(log + ".pid", "utf8"));
						await waitFor(() => !alive(pid) && stallClosed);
						writeFileSync(log + ".termination.json", JSON.stringify({ nativePid: pid, alive: alive(pid), responseClosed: stallClosed }));
					} else {
						expect(result).toEqual({ ok: true, text: answer });
						const events = readFileSync(log + ".stdout", "utf8").trim().split("\n").map((line) => JSON.parse(line));
						expect(events).toContainEqual(expect.objectContaining({ type: "item.completed", item: expect.objectContaining({ type: "agent_message", text: answer }) }));
					}
				}
			}
		} finally {
			process.env = savedEnv;
			// Ensure failed assertions cannot leave any fixture process alive.
			for (const name of ["source", "installed"]) for (const mode of ["answer", "stall"]) {
				const pidFile = join(root, `${name}-${mode}.wrapper.pid`);
				if (existsSync(pidFile)) {
					try { process.kill(-Number(readFileSync(pidFile, "utf8")), "SIGKILL"); }
					catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
				}
			}
			server.closeAllConnections();
			await new Promise<void>((resolve) => server.close(() => resolve()));
			for (const path of [home, codexHome, cwd, bin, temp]) rmSync(path, { recursive: true, force: true });
			console.error(`Native Codex fixture logs: ${root}`);
		}
	}, 60000);
});
