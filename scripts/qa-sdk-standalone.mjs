import assert from "node:assert/strict";
import { copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { startMock, synthetic } from "./sdk-proof/mock.mjs";

const packageRoot = resolve(process.argv[2] ?? new URL("..", import.meta.url).pathname);
const sourceNode = process.env.BPX_QA_NODE ?? process.execPath;
const root = realpathSync(mkdtempSync(join(tmpdir(), "bpx-sdk-standalone-")));
const home = join(root, "home"); mkdirSync(home, { mode: 0o700 });
const node = join(root, "node"); copyFileSync(sourceNode, node);
const preload = join(root, "guard.mjs");
const entry = join(packageRoot, "dist/index.js");
const service = pathToFileURL(join(packageRoot, "dist/sdk-provider-service.js")).href;
assert.equal(process.platform, "darwin", "Standalone native QA requires proven macOS sandbox confinement");
assert.ok(existsSync("/usr/bin/sandbox-exec"), "sandbox-exec required; no unconfined fallback");
const mock = await startMock();
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/KEY|TOKEN|SECRET|AUTH|MODEL|NODE_OPTIONS|NODE_PATH|PI_|CLAUDE|CODEX|OPENAI|ANTHROPIC|AWS_|GOOGLE|AZURE|VERTEX/i.test(key)));
Object.assign(env, { HOME: home, PATH: "/usr/bin:/bin", TMPDIR: root, OPENAI_API_KEY: synthetic.ambient, ANTHROPIC_API_KEY: synthetic.ambient, CLAUDECODE: "1", CLAUDE_CODE_CHILD_SESSION: "1", NO_COLOR: "1" });
const profile = join(root, "sandbox.sb");
const realHome = realpathSync(homedir());
// Allow reading an explicitly selected package checkout; deny unrelated home stores.
writeFileSync(profile, `(version 1)\n(allow default)\n(deny network*)\n(allow network-outbound (remote ip "localhost:${new URL(mock.baseUrl).port}"))\n(deny file-read* file-write* (subpath ${JSON.stringify(realHome)}))\n(allow file-read* (subpath ${JSON.stringify(packageRoot)}))\n(deny process-exec)\n(allow process-exec (literal ${JSON.stringify(node)}))\n`);
writeFileSync(preload, `import { createRequire, syncBuiltinESMExports } from 'node:module';
const require=createRequire(import.meta.url);
const child=require('node:child_process');
for(const name of ['spawn','spawnSync','exec','execSync','execFile','execFileSync','fork'])child[name]=()=>{throw Error('SDK subprocess forbidden');};
syncBuiltinESMExports();
const original=globalThis.fetch;
globalThis.fetch=async(input,options)=>{
 const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);
 if(!['api.openai.com','api.anthropic.com'].includes(url.hostname))throw Error('External SDK endpoint forbidden');
 const target=new URL(url.pathname+url.search,${JSON.stringify(mock.baseUrl)});
 const headers=new Headers(options?.headers ?? (input instanceof Request?input.headers:undefined));
 if(process.env.BPX_QA_RESPONSE_MODE)headers.set('x-proof-mode',process.env.BPX_QA_RESPONSE_MODE);
 const forwarded=input instanceof Request?new Request(target,input):target;
 return original(forwarded,{...options,headers});
};
`);

/** Execute confined real CLI/SDK without Pi or advisor executables. @param {string[]} args Node args. @param {object} extra Extra synthetic environment. @returns {Promise<object>} Safe stdout/stderr/exit. */
async function run(args, extra = {}) {
	return new Promise((resolveResult, reject) => {
		const child = spawn("/usr/bin/sandbox-exec", ["-f", profile, node, "--import", preload, ...args], { env: { ...env, ...extra }, cwd: home, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "", stderr = "";
		child.stdout.on("data", value => { stdout += value; }); child.stderr.on("data", value => { stderr += value; });
		const timer = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("SDK standalone fixture deadline")); }, 20_000);
		child.on("error", reject);
		child.on("close", (code, signal) => { clearTimeout(timer); resolveResult({ code, signal, stdout, stderr }); });
	});
}
/** Run one explicit SDK question. @param {string} backend Route. @param {object} extra Synthetic environment. @returns {Promise<object>} CLI receipt. */
async function question(backend = "sdk:openai:gpt-5-mini@low", extra = {}) {
	return run([entry, "--mode", "solo", "--backend", backend, "--question", "Council fixture persona", "--format", "json", "--no-stdin"], extra);
}
/** Save synthetic own API key through production account service. @param {string} provider ID. @returns {Promise<object>} Result. */
async function saveKey(provider) {
	return run(["--input-type=module", "-e", `const {getSdkProviderService}=await import(${JSON.stringify(service)});const s=getSdkProviderService();const r=await s.setApiKey(${JSON.stringify(provider)},${JSON.stringify(synthetic.own)},new AbortController().signal);await s.settle();console.log(JSON.stringify(r));process.exitCode=r.ok?0:1;`]);
}
/** Ensure no credential text reached process outputs. @param {object} result Process result. */
function privateOutput(result) {
	for (const value of Object.values(synthetic)) assert.ok(!(`${result.stdout}${result.stderr}`).includes(value), "Synthetic credential exposed in output");
}

try {
	console.log("Evidence:", root, "Package:", packageRoot);
	const help = await run([entry, "--help"]); assert.equal(help.code, 0, help.stderr); assert.ok(!existsSync(join(home, ".bpx-council")));
	const missing = await question(); privateOutput(missing); assert.notEqual(missing.code, 0); assert.equal(mock.state.requests.length, 0);
	assert.equal(JSON.parse(missing.stdout).attempts.length, 0); assert.ok(!existsSync(join(home, ".bpx-council")));
	console.log("PASS empty HOME/no CLIs: startup makes no account files; ambient keys cannot authorize SDK");
	for (const provider of ["openai", "anthropic"]) {
		const saved = await saveKey(provider); privateOutput(saved); assert.equal(saved.code, 0, saved.stderr); assert.equal(JSON.parse(saved.stdout).changed, true);
	}
	assert.equal(statSync(join(home, ".bpx-council")).mode & 0o777, 0o700);
	assert.equal(statSync(join(home, ".bpx-council/auth.json")).mode & 0o777, 0o600);
	for (const backend of ["sdk:openai:gpt-5-mini@low", "sdk:anthropic:claude-sonnet-4-6@low"]) {
		const before = mock.state.requests.length; const result = await question(backend); privateOutput(result); assert.equal(result.code, 0, result.stderr + result.stdout);
		const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, "complete"); assert.match(receipt.advice, /Council fixture answer/);
		assert.equal(receipt.attempts[0].route.type, "sdk"); assert.equal(receipt.attempts[0].route.command, null);
		assert.equal(mock.state.requests.length, before + 1); const attempted = mock.state.requests.at(-1);
		assert.equal(attempted.ownCredentialUsed, true); assert.equal(attempted.ambientCredentialUsed, false); assert.equal(attempted.toolDeclarations, 0);
		assert.equal(attempted.personaPresent, true); assert.equal(attempted.effort, "low");
	}
	console.log("PASS real SDK OpenAI/Anthropic calls through CLI: own key, exact pins, zero tools, usage receipts, no Pi/CLI executable");
	for (const mode of ["429", "retry", "error"]) {
		const before = mock.state.requests.length; const result = await question(undefined, { BPX_QA_RESPONSE_MODE: mode }); privateOutput(result);
		assert.notEqual(result.code, 0); const receipt = JSON.parse(result.stdout); assert.equal(receipt.status, "failed");
		assert.equal(receipt.usage.reported, 0); assert.equal(receipt.usage.unknown, 1); assert.equal(receipt.usage.inputTokens, null);
		assert.equal(mock.state.requests.length, before + 1);
	}
	assert.ok(!existsSync(join(home, ".pi"))); assert.ok(!existsSync(join(home, ".claude"))); assert.ok(!existsSync(join(home, ".codex")));
	const ownFile = readFileSync(join(home, ".bpx-council/auth.json"), "utf8"); assert.ok(ownFile.includes(synthetic.own));
	writeFileSync(join(root, "requests.json"), JSON.stringify(mock.state.requests, null, 2));
	console.log("PASS provider failures make one request, safe JSON errors, no secret output or external account stores");
} finally { await mock.stop(); }
