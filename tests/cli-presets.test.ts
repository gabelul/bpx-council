import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { callCliAdvisor, openCodeAdvisorEnv, parseCliOutput } from "../src/backend.js";

const dir = mkdtempSync(join(tmpdir(), "bpx-cli-presets-"));
const oldPath = process.env.PATH;
process.env.PATH = `${dir}:${oldPath ?? ""}`;

/** Fake binaries log exact argv/env and emit answer plus irrelevant status events. */
function fake(name: string): void {
	const script = `#!/usr/bin/env node
const fs = require('node:fs');
const name = require('node:path').basename(process.argv[1]);
let input = '';
process.stdin.on('data', chunk => input += chunk);
process.stdin.on('end', () => {
 fs.writeFileSync(${JSON.stringify(join(dir, `${name}.json`))}, JSON.stringify({ args: process.argv.slice(2), input, config: process.env.OPENCODE_CONFIG_CONTENT, permission: process.env.OPENCODE_PERMISSION }));
 if (name === 'codex') {
  if (process.argv.includes('--json')) {
   console.log(JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', text: 'secret tool output' } }));
   console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'codex answer' } }));
  } else console.log('plain codex answer');
 } else if (name === 'opencode') {
  console.log(JSON.stringify({ type: 'tool', part: { text: 'secret tool output' } }));
  console.log(JSON.stringify({ type: 'text', part: { text: 'opencode answer' } }));
 } else console.log('claude answer');
});
`;
	writeFileSync(join(dir, name), script);
	chmodSync(join(dir, name), 0o755);
}
for (const name of ["codex", "opencode", "claude"]) fake(name);
afterAll(() => { process.env.PATH = oldPath; rmSync(dir, { recursive: true, force: true }); });

/** Inspect one fake CLI invocation without running a real model. */
function record(name: string): { args: string[]; input: string; config?: string; permission?: string } {
	return JSON.parse(readFileSync(join(dir, `${name}.json`), "utf8"));
}

describe("CLI preset format and safety", () => {
	it("Codex requests JSONL and ignores tool events", async () => {
		const result = await callCliAdvisor("S", "Q", { type: "cli", command: "codex" });
		expect(result).toMatchObject({ ok: true, text: "codex answer" });
		expect(record("codex").args).toContain("--json");
		expect(result.text).not.toContain("secret tool output");
	});

	it("OpenCode requests JSONL with a subprocess-only deny-all agent", async () => {
		const old = process.env.OPENCODE_CONFIG_CONTENT;
		process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { local: { baseURL: "http://localhost" } }, agent: { other: { mode: "primary" } } });
		try {
			const result = await callCliAdvisor("S", "Q", { type: "cli", command: "opencode" });
			expect(result).toMatchObject({ ok: true, text: "opencode answer" });
			const call = record("opencode");
			expect(call.args).toEqual(["run", "--format", "json", "--pure", "--agent", "bpx-council"]);
			const config = JSON.parse(call.config!);
			expect(config.provider.local.baseURL).toBe("http://localhost");
			expect(config.agent.other.mode).toBe("primary");
			expect(config.agent["bpx-council"].permission["*"]).toBe("deny");
			expect(JSON.parse(call.permission!)["*"]).toBe("deny");
			expect(process.env.OPENCODE_CONFIG_CONTENT).not.toContain("bpx-council");
		} finally {
			if (old === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
			else process.env.OPENCODE_CONFIG_CONTENT = old;
		}
	});

	it("refuses to overwrite malformed OpenCode provider env", async () => {
		const old = process.env.OPENCODE_CONFIG_CONTENT;
		process.env.OPENCODE_CONFIG_CONTENT = "{invalid";
		try { expect((await callCliAdvisor("S", "Q", { type: "cli", command: "opencode" })).error).toMatch(/invalid JSON/); }
		finally { if (old === undefined) delete process.env.OPENCODE_CONFIG_CONTENT; else process.env.OPENCODE_CONFIG_CONTENT = old; }
	});

	it("trusted custom OpenCode args keep caller env unchanged", async () => {
		const old = process.env.OPENCODE_CONFIG_CONTENT;
		process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ provider: { custom: { npm: "owned" } } });
		try {
			const result = await callCliAdvisor("S", "Q", { type: "cli", command: "opencode", args: ["run", "--format", "json"] });
			expect(result.text).toBe("opencode answer");
			const call = record("opencode");
			expect(call.config).toBe(process.env.OPENCODE_CONFIG_CONTENT);
			expect(JSON.parse(call.config!).agent).toBeUndefined();
		} finally {
			if (old === undefined) delete process.env.OPENCODE_CONFIG_CONTENT;
			else process.env.OPENCODE_CONFIG_CONTENT = old;
		}
	});

	it("Claude runs without tools and rejects image support", async () => {
		const result = await callCliAdvisor("S", "Q", { type: "cli", command: "claude" });
		expect(result.ok).toBe(true);
		expect(record("claude").args).toEqual(["--tools", "", "-p"]);
	});

	it("trusted custom args preserve plain JSON advice; JSONL keeps strict event filtering", async () => {
		const plain = await callCliAdvisor("S", "Q", { type: "cli", command: "codex", args: ["exec"] });
		expect(plain.text).toBe("plain codex answer");
		const json = await callCliAdvisor("S", "Q", { type: "cli", command: "codex", args: ["exec", "--json"] });
		expect(json.text).toBe("codex answer");
		expect(parseCliOutput('{"type":"plan","steps":["ship"]}', "codex", false)).toBe('{"type":"plan","steps":["ship"]}');
		expect(parseCliOutput('{"type":"status","text":"secret"}\nplain answer', "codex", false)).toBe('{"type":"status","text":"secret"}\nplain answer');
		expect(parseCliOutput('{"type":"item.completed","item":{"type":"command_execution","text":"secret"}}', "codex", true)).toBe("");
		expect(openCodeAdvisorEnv({ OPENCODE_CONFIG_CONTENT: "{}" }).OPENCODE_CONFIG_CONTENT).toContain("bpx-council");
	});
});
