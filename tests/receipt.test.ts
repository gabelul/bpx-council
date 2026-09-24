import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { anthropicUsage, callHttpAdvisor } from "../src/http-backend.js";
import { addAttempt, newReceipt, seatAttempt, settleReceipt } from "../src/receipt.js";
import { runCouncil } from "../src/council.js";

let root: string;
let home: string;
const entry = resolve("src/index.ts");
const loader = resolve("node_modules/tsx/dist/loader.mjs");

/** Run consult from isolated home with fake local advisor, never real provider credentials. */
function invoke(args: string[], input = "", env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(process.execPath, ["--import", loader, entry, ...args], {
		cwd: root, input, encoding: "utf8", timeout: 10_000,
		env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...env },
	});
	if (result.error) throw result.error;
	return result;
}

/** Install shell advisor. Prompt is piped unless CLI preset selects argv. */
function advisor(name: string, body: string): string {
	const path = join(root, name);
	writeFileSync(path, `#!/bin/sh\n${body}\n`);
	chmodSync(path, 0o755);
	return path;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bpx-receipt-"));
	home = mkdtempSync(join(tmpdir(), "bpx-receipt-home-"));
	mkdirSync(join(root, ".git"));
});
afterEach(() => {
	vi.unstubAllGlobals();
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

/** Require exact one object, not stray prose or multiple JSON lines. */
function json(result: ReturnType<typeof invoke>) {
	const lines = result.stdout.trim().split("\n");
	expect(lines).toHaveLength(1);
	const value = JSON.parse(lines[0]);
	expect(value).toMatchObject({ schemaVersion: 1, invocationId: expect.any(String) });
	expect(value.invocationId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
	return value;
}

describe("consult receipt boundaries", () => {
	it("emits one JSON object and fresh UUID on solo success; default markdown stays unchanged", () => {
		const cmd = advisor("fake", "printf 'Model answer\\n'");
		const args = ["--backend", cmd, "--no-stdin", "Q"];
		const first = invoke(["--format", "json", ...args]);
		const second = invoke(["--format", "json", ...args]);
		const a = json(first);
		expect(first.status).toBe(0);
		expect(a).toMatchObject({ mode: "solo", status: "complete", advice: "Model answer", error: null,
			usage: { attempted: 1, reported: 0, unknown: 1, inputTokens: null, outputTokens: null } });
		expect(a.attempts[0]).toMatchObject({ seat: "advisor", round: null, status: "complete",
			route: { type: "cli", label: cmd, model: null, effort: null }, usage: null });
		expect(json(second).invocationId).not.toBe(a.invocationId);
		const markdown = invoke(args);
		expect(markdown.status).toBe(0);
		expect(markdown.stdout).toBe("Model answer\n");
	});

	it.each([
		[["--format", "json", "--bogus", "Q"], /unknown option/, null],
		[["--format", "json"], /question is required/, null],
		[["--format", "json", "--config", "/nonexistent/bpx.json", "Q"], /config file not found/, null],
		[["--format", "json", "--file", "/nonexistent/context.txt", "Q"], /nonexistent/, null],
		[["--format", "json", "--backend", "openai", "Q"], /not yet implemented/, "solo"],
		[["--format", "json", "--version"], /cannot be combined/, null],
	])("serializes failure %j without stdout diagnostics", (args, error, mode) => {
		const result = invoke(args);
		const receipt = json(result);
		expect(result.status).not.toBe(0);
		expect(receipt).toMatchObject({ mode, status: "failed", advice: null, error: expect.stringMatching(error) });
	});

	it("keeps malformed config excerpts out of machine receipts", () => {
		const file = join(root, "malformed.json");
		writeFileSync(file, '{"credential":"SECRET-credential",');
		const result = invoke(["--format", "json", "--config", file, "--no-stdin", "Q"]);
		expect(result.status).not.toBe(0);
		expect(json(result).error).toContain("invalid JSON");
		expect(result.stdout + result.stderr).not.toContain("SECRET-credential");
	});

	it.each([
		{ "SECRET-property": 1 },
		{ personas: { "SECRET-property": { stance: "for", systemPrompt: "S" } } },
		{ council: { backends: { "SECRET-property": "anthropic" } } },
	])("does not echo secret config key in receipts or stderr: %j", (config) => {
		const file = join(root, "secret-key.json");
		writeFileSync(file, JSON.stringify(config));
		const result = invoke(["--format", "json", "--config", file, "--no-stdin", "Q"]);
		expect(result.status).not.toBe(0);
		expect(json(result).error).toMatch(/unknown property|unsafe name|unsafe persona name/);
		expect(result.stdout + result.stderr).not.toContain("SECRET-property");
	});

	it("does not echo a syntactically valid custom persona name from an invalid definition", () => {
		const file = join(root, "secret-persona.json");
		writeFileSync(file, JSON.stringify({ personas: { secretproperty: { stance: "for", systemPrompt: " " } } }));
		const result = invoke(["--format", "json", "--config", file, "--no-stdin", "Q"]);
		expect(result.status).not.toBe(0);
		expect(json(result).error).toContain("personas entry.systemPrompt");
		expect(result.stdout + result.stderr).not.toContain("secretproperty");
	});

	it.each([
		['{"SECRET-json":"secret",', "invalid JSON"],
		[JSON.stringify({ "SECRET-key": "secret" }), "unknown property"],
	])("wizard refuses invalid config without printing secret bytes", (contents, diagnostic) => {
		const file = join(root, "wizard.json");
		writeFileSync(file, contents);
		advisor("codex", "exit 0");
		const result = invoke(["config", "--yes", "--backend", "codex", "--config", file], "", { PATH: `${root}:${process.env.PATH}` });
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(diagnostic);
		expect(result.stdout + result.stderr).not.toContain("SECRET-");
	});

	it("does not attribute model or effort pins bypassed by custom CLI arguments", () => {
		const attempt = seatAttempt("advisor", null, { type: "cli", command: "codex", args: ["exec", "--model", "old"],
			model: "new", effort: "high" }, { ok: true, text: "answer" });
		expect(attempt.route).toMatchObject({ label: "codex", model: null, effort: null });
	});

	it("keeps config/setup/install outside JSON protocol", () => {
		for (const command of ["config", "setup", "install"]) {
			const result = invoke([command, "--format", "json"]);
			expect(result.status).not.toBe(0);
			expect(result.stdout).toBe("");
			expect(result.stderr).toContain("--format");
		}
	});

	it("serializes stdin timeout without leaking prompt bytes", async () => {
		const child = spawn(process.execPath, ["--import", loader, entry, "--format", "json", "--mode", "debate", "Q"], {
			cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "" },
		});
		let stdout = "";
		child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
		child.stdin.write("unclosed context");
		const exit = await new Promise<number | null>((done) => child.on("close", done));
		child.stdin.destroy();
		expect(exit).not.toBe(0);
		const receipt = JSON.parse(stdout);
		expect(receipt).toMatchObject({ mode: "debate", status: "failed", error: expect.stringMatching(/stdin did not end/) });
		expect(stdout.trim().split("\n")).toHaveLength(1);
	});

	it("records ordered council seats, failed member, successful synthesis as partial exit zero", () => {
		const good = advisor("good", "printf 'An answer\\n'");
		const bad = advisor("bad", "printf 'broken\\n' >&2; exit 2");
		const result = invoke(["--format", "json", "--mode", "council", "--backend", good,
			"--backends", `${good},${bad},${good}`, "--synthesizer", good, "--no-stdin", "Q"]);
		const receipt = json(result);
		expect(result.status).toBe(0);
		expect(receipt.status).toBe("partial");
		expect(receipt.error).toBeNull();
		expect(receipt.attempts.map((a: { seat: string; status: string }) => [a.seat, a.status])).toEqual([
			["architect", "complete"], ["critic", "failed"], ["simplifier", "complete"], ["synthesizer", "complete"],
		]);
		expect(receipt.usage).toMatchObject({ attempted: 4, reported: 0, unknown: 4 });
		expect(receipt.advice).toContain("### Verdict");
		expect(result.stderr).toContain("architect");
		expect(result.stderr).toContain("answered");
	});

	it("excludes secret echoes from CLI failure receipts and markdown errors", () => {
		const secret = "credential-from-prompt-123";
		const cmd = advisor("leaky", `printf '${secret}\\n' >&2; printf '${secret}\\n'; exit 42`);
		const args = ["--backend", cmd, "--no-stdin", "Q"];
		const result = invoke(["--format", "json", ...args]);
		const receipt = json(result);
		expect(result.status).not.toBe(0);
		expect(receipt.error).toContain("exited 42");
		expect(receipt.attempts[0].error).toContain("exited 42");
		expect(result.stdout + result.stderr).not.toContain(secret);
		const markdown = invoke(args);
		expect(markdown.status).not.toBe(0);
		expect(markdown.stderr).not.toContain(secret);
	});

	it("salvages council synthesis and debate bailout, with nonzero exits", () => {
		const good = advisor("good", "printf 'An answer\\n'");
		const bad = advisor("bad", "exit 2");
		const council = json(invoke(["--format", "json", "--mode", "council", "--backend", good,
			"--synthesizer", bad, "--no-stdin", "Q"]));
		expect(council).toMatchObject({ status: "partial", error: expect.stringMatching(/Synthesis failed/) });
		expect(council.advice).toContain("### architect");
		expect(council.attempts.at(-1).seat).toBe("synthesizer");
		const debateResult = invoke(["--format", "json", "--mode", "debate", "--rounds", "4", "--backend", good,
			"--critic", bad, "--no-stdin", "Q"]);
		const debate = json(debateResult);
		expect(debateResult.status).not.toBe(0);
		expect(debate).toMatchObject({ status: "partial", error: expect.stringMatching(/Critic failed/) });
		expect(debate.advice).toContain("### Advocate (round 1)");
		expect(debate.attempts.map((a: { seat: string; round: number }) => [a.seat, a.round])).toEqual([
			["advocate", 1], ["critic", 1],
		]);
		expect(debate.planned).toHaveLength(9);
		expect(debate.notRun).toEqual([
			{ seat: "advocate", round: 2 }, { seat: "critic", round: 2 },
			{ seat: "advocate", round: 3 }, { seat: "critic", round: 3 },
			{ seat: "advocate", round: 4 }, { seat: "critic", round: 4 },
			{ seat: "synthesizer", round: null },
		]);
		expect(debate.usage).toMatchObject({ attempted: 2, reported: 0, unknown: 2 });
	});
});

describe("provider usage", () => {
	it("redacts non-2xx body and fetch error messages while retaining safe status", async () => {
		const before = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake";
		const backend = { type: "http" as const, provider: "anthropic" as const, model: "test" };
		try {
			vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 401,
				text: async () => '{"error":"secret-key-or-prompt"}',
			}));
			const rejected = await callHttpAdvisor("S", "Q", backend);
			expect(rejected.error).toBe("anthropic API HTTP 401");
			expect(JSON.stringify(rejected)).not.toContain("secret-key-or-prompt");
			vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("secret-key-or-prompt")));
			const network = await callHttpAdvisor("S", "Q", backend);
			expect(network.error).toBe("anthropic HTTP request failed");
		} finally {
			if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = before;
		}
	});

	it("marks Council synthesis skipped when all members fail", () => {
		const bad = advisor("bad", "exit 2");
		const result = invoke(["--format", "json", "--mode", "council", "--backend", bad, "--no-stdin", "Q"]);
		const receipt = json(result);
		expect(result.status).not.toBe(0);
		expect(receipt).toMatchObject({ status: "failed", advice: null, usage: { attempted: 3, reported: 0, unknown: 3 } });
		expect(receipt.planned).toHaveLength(4);
		expect(receipt.notRun).toEqual([{ seat: "synthesizer", round: null }]);
	});
	it("aggregates HTTP reports alongside unknown CLI calls in actual council", async () => {
		const cmd = advisor("fake", "printf 'CLI answer\\n'");
		const before = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake";
		let calls = 0;
		vi.stubGlobal("fetch", vi.fn().mockImplementation(async () => ({ ok: true, json: async () => {
			const call = ++calls;
			return { content: [{ type: "text", text: `HTTP answer ${call}` }],
				usage: call === 1
					? { input_tokens: 7, output_tokens: 3, cache_creation_input_tokens: 1024, cache_read_input_tokens: 256 }
					: { input_tokens: 7, output_tokens: 3 } };
		} })));
		try {
			const receipt = newReceipt();
			const result = await runCouncil({ question: "Q", config: { defaultMode: "council", solo: {
				backend: { type: "http", provider: "anthropic", model: "claude-test" },
			} }, backends: ["anthropic:claude-test", cmd, cmd], onAttempt: (attempt) => addAttempt(receipt, attempt) });
			expect(result.ok).toBe(true);
			expect(receipt.attempts.map((attempt) => attempt.seat)).toEqual(["architect", "critic", "simplifier", "synthesizer"]);
			expect(settleReceipt(receipt, result)).toMatchObject({ status: "complete", usage: {
				attempted: 4, reported: 2, unknown: 2, inputTokens: 14, outputTokens: 6,
				cacheCreationInputTokens: 1024, cacheReadInputTokens: 256,
				cacheCreationReported: 1, cacheReadReported: 1,
			} });
		} finally {
			if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = before;
		}
	});

	it("attributes unpinned Anthropic HTTP receipt to request default", async () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake";
		const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: "answer" }] }) });
		vi.stubGlobal("fetch", fetchMock);
		try {
			const backend = { type: "http" as const, provider: "anthropic" as const, model: "" };
			const result = await callHttpAdvisor("S", "Q", backend);
			const sentModel = JSON.parse(fetchMock.mock.calls[0][1].body).model;
			expect(sentModel).toBe("claude-opus-4-8");
			expect(seatAttempt("advisor", null, backend, result).route.model).toBe(sentModel);
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});

	it("keeps reported tokens on HTTP error responses", async () => {
		const before = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake";
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429,
			text: async () => JSON.stringify({ error: "busy", usage: { input_tokens: 4, output_tokens: 0 } }),
		}));
		try {
			const result = await callHttpAdvisor("S", "Q", { type: "http", provider: "anthropic", model: "test" });
			expect(result).toMatchObject({ ok: false, usage: { inputTokens: 4, outputTokens: 0 } });
		} finally {
			if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = before;
		}
	});

	it("accepts only exact Anthropic token counts, including zero", async () => {
		expect(anthropicUsage({ input_tokens: 0, output_tokens: 2 })).toEqual({ inputTokens: 0, outputTokens: 2 });
		expect(anthropicUsage({ input_tokens: 8, output_tokens: 9,
			cache_creation_input_tokens: 1024, cache_read_input_tokens: 256 })).toEqual({
			inputTokens: 8, outputTokens: 9, cacheCreationInputTokens: 1024, cacheReadInputTokens: 256,
		});
		expect(anthropicUsage({ input_tokens: "3", output_tokens: 2 })).toBeUndefined();
		expect(anthropicUsage({ input_tokens: 1, output_tokens: -2 })).toBeUndefined();
		expect(anthropicUsage({ input_tokens: 1, output_tokens: 2, cache_read_input_tokens: "0" })).toEqual({
			inputTokens: 1, outputTokens: 2,
		});
		vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({
			content: [{ type: "text", text: "hello" }], usage: { input_tokens: 7, output_tokens: 3 },
		}) }));
		const before = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake";
		try {
			const result = await callHttpAdvisor("S", "Q", { type: "http", provider: "anthropic", model: "test" });
			expect(result).toMatchObject({ ok: true, text: "hello", usage: { inputTokens: 7, outputTokens: 3 } });
			const receipt = newReceipt();
			addAttempt(receipt, seatAttempt("advisor", null, { type: "http", provider: "anthropic", model: "test" }, result));
			addAttempt(receipt, seatAttempt("retry", null, { type: "cli", command: "fake" }, { ok: false, text: "", error: "failed" }));
			expect(settleReceipt(receipt, { ok: true, text: "hello" })).toMatchObject({ status: "partial", usage: {
				attempted: 2, reported: 1, unknown: 1, inputTokens: 7, outputTokens: 3,
				cacheCreationInputTokens: null, cacheReadInputTokens: null,
				cacheCreationReported: 0, cacheReadReported: 0,
			} });
		} finally {
			if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = before;
		}
	});
});
