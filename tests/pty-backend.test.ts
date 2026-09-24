import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { callPtyAdvisor } from "../src/pty-backend.js";

const dirs: string[] = [];
afterEach(() => {
	vi.unstubAllEnvs();
	for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

it("passes model and prompt as literal tmux argv, quoting boot command for tmux shell", async () => {
	const dir = mkdtempSync(join(tmpdir(), "bpx-tmux-"));
	dirs.push(dir);
	const marker = join(dir, "injected");
	const log = join(dir, "args.jsonl");
	const script = join(dir, "tmux");
	writeFileSync(script, `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + '\\n');
if (args[0] === 'new-session') cp.spawnSync('sh', ['-c', args[args.length - 1]], { stdio: 'ignore' });
if (args[0] === 'load-buffer') fs.writeFileSync(${JSON.stringify(join(dir, "prompt"))}, fs.readFileSync(0));
if (args[0] === 'capture-pane') process.stdout.write((fs.existsSync(${JSON.stringify(join(dir, "prompt"))}) ? fs.readFileSync(${JSON.stringify(join(dir, "prompt"))}, 'utf8').split('\\n')[0] + '\\n' : '') + '❯\\n');
`);
	chmodSync(script, 0o755);
	vi.stubEnv("PATH", `${dir}:${process.env.PATH}`);
	const command = `missing'; touch ${marker}; #`;
	const model = `opus'; touch ${marker}; #`;
	const result = await callPtyAdvisor("safe", "quote'; echo payload", {
		type: "tmux", command, model, sessionPrefix: `session'; touch ${marker}; #`, startupMs: 4000, timeoutMs: 1,
	});
	expect(result.ok).toBe(false);
	expect(existsSync(marker)).toBe(false);
	const calls = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[]);
	expect(calls.find((args) => args[0] === "new-session")?.at(-1)).toBe(`'missing'\\''; touch ${marker}; #'`);
	expect(calls).toContainEqual(expect.arrayContaining(["-l", `/${model}`]));
	expect(calls.find((args) => args[0] === "load-buffer")).toBeDefined();
	expect(readFileSync(join(dir, "prompt"), "utf8")).toContain("quote'; echo payload");
}, 15_000);
