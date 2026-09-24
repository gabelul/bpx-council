/** Entry-point coverage: parsed seat flags must reach real CLI subprocesses. */
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BpxCouncilConfig } from "../src/config.js";

interface CallRecord { command: string; args: string[]; prompt: string }
let dir: string;
let configPath: string;
let logPath: string;
const PNG_1PX = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");

/** Run the source entry point with fake CLI executables and a private config. */
function invoke(args: string[], config: object): { status: number | null; stdout: string; stderr: string; calls: CallRecord[] } {
	writeFileSync(configPath, JSON.stringify(config));
	const env = { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, BPX_SEAT_LOG: logPath };
	delete env.ANTHROPIC_API_KEY;
	delete env.OPENAI_API_KEY;
	delete env.BPX_COUNCIL_MODEL;
	delete env.ANTHROPIC_MODEL;
	const result = spawnSync(process.execPath, [
		"--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/index.ts"), "--config", configPath, ...args,
	], { cwd: dir, env, input: "", encoding: "utf8", timeout: 20_000 });
	if (result.error) throw result.error;
	const calls = readFileSync(logPath, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as CallRecord);
	return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls };
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "bpx-seat-cli-"));
	configPath = join(dir, "config.json");
	logPath = join(dir, "calls.jsonl");
	writeFileSync(logPath, "");
	const executable = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (path.basename(process.argv[1]) === 'codex' && process.argv[2] === 'debug' && process.argv[3] === 'models') {
  console.log(JSON.stringify({ models: [] }));
  process.exit(0);
}
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { prompt += chunk; });
process.stdin.on('end', () => {
  const command = path.basename(process.argv[1]);
  fs.appendFileSync(process.env.BPX_SEAT_LOG, JSON.stringify({ command, args: process.argv.slice(2), prompt }) + '\\n');
  if (command === 'codex') console.log(JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'answer from codex' } }));
  else console.log('answer from ' + command);
});
`;
	for (const name of ["codex", "claude", "opencode"]) {
		const path = join(dir, name);
		writeFileSync(path, executable);
		chmodSync(path, 0o755);
	}
});

afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("consult CLI seat dispatch", () => {
	it("uses the saved default Debate mode and independent seat models", () => {
		const result = invoke(["--rounds", "1", "Q"], {
			defaultMode: "debate", solo: { backend: { type: "cli", command: "codex", model: "shared" } },
			debate: { advocate: "codex:adv", critic: "claude:critic", synthesizer: "codex:judge" },
		});
		expect(result.status).toBe(0);
		expect(result.calls.map((call) => call.command)).toEqual(["codex", "claude", "codex"]);
		expect(result.calls.map((call) => call.args[call.args.indexOf("--model") + 1]))
			.toEqual(["adv", "critic", "judge"]);
		expect(result.stdout).toContain("### Verdict · codex:judge");
	});

	it("lets explicit --mode solo override a saved Debate default", () => {
		const result = invoke(["--mode", "solo", "Q"], {
			defaultMode: "debate", solo: { backend: { type: "cli", command: "codex", model: "shared" } },
		});
		expect(result.status).toBe(0);
		expect(result.calls).toHaveLength(1);
		expect(result.calls[0]?.args).toContain("shared");
	});

	it("lets Debate flags override saved seats without inheriting the shared model", () => {
		const result = invoke(["--mode", "debate", "--rounds", "1", "--advocate", "codex:new-adv",
			"--critic", "claude:new-critic", "--synthesizer", "codex:new-judge", "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "codex", model: "shared" } },
			debate: { advocate: "claude:old-adv", critic: "codex:old-critic", synthesizer: "claude:old-judge" },
		});
		expect(result.status).toBe(0);
		expect(result.calls.map((call) => call.args[call.args.indexOf("--model") + 1]))
			.toEqual(["new-adv", "new-critic", "new-judge"]);
	});

	it("honors Council synthesizer CLI override separately from member backends", () => {
		const result = invoke(["--mode", "council", "--backends", "claude,codex,claude",
			"--synthesizer", "codex:judge", "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "codex", model: "shared" } },
			council: { synthesizer: "claude:configured" },
		});
		expect(result.status).toBe(0);
		expect(result.calls.slice(0, 3).map((call) => call.command).sort()).toEqual(["claude", "claude", "codex"]);
		expect(result.calls[3]?.command).toBe("codex");
		expect(result.calls[3]?.args).toContain("judge");
		expect(result.stdout).toContain("### Verdict · codex:judge");
	});

	it("delivers an image path to each Codex seat", () => {
		const image = join(dir, "layout.png");
		writeFileSync(image, PNG_1PX);
		const result = invoke(["--mode", "debate", "--rounds", "1", "--image", image,
			"--advocate", "codex:adv", "--critic", "codex:critic", "--synthesizer", "codex:judge", "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "codex" } },
		});
		expect(result.status).toBe(0);
		expect(result.calls[0]?.args).toContain(image);
		expect(result.calls[1]?.args).toContain(image);
		expect(result.calls[2]?.args).toContain(image);
	});

	it("allows fully specified image-capable seats on an image-blind Solo backend", () => {
		const image = join(dir, "layout.png");
		writeFileSync(image, PNG_1PX);
		const result = invoke(["--mode", "debate", "--rounds", "1", "--image", image,
			"--advocate", "codex", "--critic", "codex", "--synthesizer", "codex", "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "opencode" } },
		});
		expect(result.status).toBe(0);
		expect(result.calls.map((call) => call.command)).toEqual(["codex", "codex", "codex"]);
	});

	it("rejects Claude image input before spawning its no-tools preset", () => {
		const image = join(dir, "claude-image.png");
		writeFileSync(image, PNG_1PX);
		const result = invoke(["--backend", "claude", "--image", image, "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "codex" } },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("can't take images");
		expect(result.calls).toEqual([]);
	});

	it("rejects an image-blind seat before spawning any advisor", () => {
		const image = join(dir, "layout.png");
		writeFileSync(image, PNG_1PX);
		const result = invoke(["--mode", "debate", "--image", image, "--critic", "opencode", "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "codex" } },
		});
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("can't take images");
		expect(result.calls).toEqual([]);
	});

	it("returns member answers but fails when Council synthesis cannot run", () => {
		const result = invoke(["--mode", "council", "--synthesizer", "missing-advisor", "Q"], {
			defaultMode: "solo", solo: { backend: { type: "cli", command: "codex" } },
		});
		expect(result.status).not.toBe(0);
		expect(result.calls).toHaveLength(3);
		expect(result.stdout).toContain("### architect [for]");
		expect(result.stdout).not.toContain("### Verdict");
		expect(result.stderr).toContain("Synthesis failed");
	});

	it("keeps seat assignments during a headless config change", () => {
		writeFileSync(configPath, JSON.stringify({
			defaultMode: "debate", solo: { backend: { type: "cli", command: "codex" } },
			council: { backends: { architect: "claude" }, synthesizer: "codex:judge" },
			debate: { advocate: "claude:adv", critic: "codex:critic" },
		}));
		const result = spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"),
			resolve("src/index.ts"), "config", "--config", configPath, "--backend", "codex", "--mode", "solo", "--yes"], {
			cwd: dir, env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}` },
			input: "", encoding: "utf8", timeout: 20_000,
		});
		if (result.error) throw result.error;
		expect(result.status).toBe(0);
		const saved = JSON.parse(readFileSync(configPath, "utf8")) as BpxCouncilConfig;
		expect(saved.council).toEqual({ backends: { architect: "claude" }, synthesizer: "codex:judge" });
		expect(saved.debate).toEqual({ advocate: "claude:adv", critic: "codex:critic" });
	});

	it("rejects irrelevant or malformed seats before spawning an advisor", () => {
		const config = { defaultMode: "solo", solo: { backend: { type: "cli", command: "codex" } } };
		const irrelevant = invoke(["--critic", "claude", "Q"], config);
		expect(irrelevant.status).not.toBe(0);
		expect(irrelevant.stderr).toContain("require --mode debate");
		expect(irrelevant.calls).toEqual([]);
		const invalid = invoke(["--mode", "debate", "--synthesizer", ":bad", "Q"], config);
		expect(invalid.status).not.toBe(0);
		expect(invalid.stderr).toContain("Invalid backend spec");
		expect(invalid.calls).toEqual([]);
	});
});
