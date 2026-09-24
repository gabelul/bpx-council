import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mergeConfigs, resolveConfig, type BpxCouncilConfig } from "../src/config.js";
import { callHttpAdvisor } from "../src/http-backend.js";

const callAdvisor = vi.fn();
vi.mock("../src/backend.js", async (importOriginal) => {
	const original = await importOriginal<typeof import("../src/backend.js")>();
	return { ...original, callAdvisor: (...args: unknown[]) => callAdvisor(...args) };
});
const { runCouncil } = await import("../src/council.js");
let root: string;
let home: string;
let oldHome: string | undefined;

/** Isolate config discovery and subprocess tests from real settings and keys. */
beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bpx-roster-"));
	home = mkdtempSync(join(tmpdir(), "bpx-roster-home-"));
	mkdirSync(join(root, ".git"));
	oldHome = process.env.HOME;
	process.env.HOME = home;
	callAdvisor.mockReset();
	callAdvisor.mockResolvedValue({ ok: true, text: "Advice" });
	vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});
afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

/** Run entrypoint without inherited credentials or live advisor routes. */
function invoke(args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/index.ts"), ...args], {
		cwd: root, input: "", encoding: "utf8", timeout: 10_000,
		env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...env },
	});
	if (result.error) throw result.error;
	return result;
}

/** Install inert advisor that prints its own identity. */
function advisor(name: string): string {
	const path = join(root, name);
	writeFileSync(path, `#!/bin/sh\nprintf '${name} answer\\n'\n`);
	chmodSync(path, 0o755);
	return path;
}

const base: BpxCouncilConfig = { defaultMode: "council", solo: { backend: { type: "cli", command: "codex" } } };

describe("persona definitions and ordered roster", () => {
	it("keeps bundled default order and replaces definitions by name", async () => {
		const config = mergeConfigs(base, { personas: { critic: { stance: "neutral", systemPrompt: "Check assumptions." } } });
		const result = await runCouncil({ question: "Q", config });
		expect(callAdvisor.mock.calls.slice(0, 3).map((c) => c[0])).toEqual([
			expect.stringContaining("architect advisor"), "Check assumptions.", expect.stringContaining("simplifier advisor"),
		]);
		expect(result.ok && result.text).toContain("critic [neutral]");
	});

	it("merges definitions by name, replaces roster atomically, routes by name after position", async () => {
		const config = mergeConfigs(mergeConfigs(base, {
			personas: { reviewer: { stance: "against", systemPrompt: "Review deployment." } },
			council: { members: ["reviewer", "architect"], backends: { reviewer: "claude" } },
		}), { council: { members: ["architect", "reviewer"] }, personas: { critic: { stance: "neutral", systemPrompt: "Audit." } } });
		expect(config.council?.members).toEqual(["architect", "reviewer"]);
		expect(Object.keys(config.personas ?? {})).toEqual(["reviewer", "critic"]);
		const result = await runCouncil({ question: "Q", config, backends: ["opencode"] });
		expect(callAdvisor.mock.calls.map((c) => (c[2] as { command: string }).command)).toEqual(["opencode", "claude", "codex"]);
		expect(result.ok && result.text).toContain("reviewer [against] · claude");
	});

	it("rejects excess positional specs and undefined names before calling advisors", async () => {
		const config = mergeConfigs(base, { council: { members: ["critic"] } });
		await expect(runCouncil({ question: "Q", config, backends: ["codex", "claude"] })).rejects.toThrow("2 specs for 1");
		await expect(runCouncil({ question: "Q", config: mergeConfigs(config, { council: { members: ["missing"] } }) })).rejects.toThrow("Unknown council persona");
		expect(callAdvisor).not.toHaveBeenCalled();
	});

	it("keeps closing synthesis distinct when a custom roster wholly fails", () => {
		const bad = join(root, "bad");
		writeFileSync(bad, "#!/bin/sh\nexit 2\n"); chmodSync(bad, 0o755);
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: bad } },
			personas: { skeptic: { stance: "against", systemPrompt: "Review." } },
			council: { members: ["skeptic", "architect"] } }));
		const result = invoke(["--mode", "council", "--format", "json", "--no-stdin", "Q"]);
		const receipt = JSON.parse(result.stdout);
		expect(result.status).not.toBe(0);
		expect(receipt.attempts.map((attempt: { seat: string }) => attempt.seat)).toEqual(["skeptic", "architect"]);
		expect(receipt.notRun).toEqual([{ seat: "synthesizer", round: null }]);
	});

	it("keeps custom identities in partial answer and JSON receipt", () => {
		const good = advisor("good");
		const bad = join(root, "bad");
		writeFileSync(bad, "#!/bin/sh\nexit 2\n"); chmodSync(bad, 0o755);
		const file = join(home, ".bpx-council.json");
		writeFileSync(file, JSON.stringify({ solo: { backend: { type: "cli", command: good } },
			personas: { skeptic: { stance: "against", systemPrompt: "Skeptic prompt." } },
			council: { members: ["skeptic", "architect"], backends: { architect: bad }, synthesizer: bad } }));
		const result = invoke(["--mode", "council", "--format", "json", "--no-stdin", "Q"]);
		const receipt = JSON.parse(result.stdout);
		expect(result.status).not.toBe(0);
		expect(receipt.planned.map((s: { seat: string }) => s.seat)).toEqual(["skeptic", "architect", "synthesizer"]);
		expect(receipt.attempts.map((s: { seat: string }) => s.seat)).toEqual(["skeptic", "architect", "synthesizer"]);
		expect(receipt.advice).toContain("### skeptic [against]");
		expect(receipt.advice).not.toContain("### architect [for]");
	});
});

describe("project trust and validation", () => {
	it.each([
		[{ personas: { skeptic: { stance: "against", systemPrompt: "Injected" } } }, "personas"],
		[{ council: { members: ["skeptic"] } }, "council.members"],
		[{ council: { members: ["architect", "architect"] } }, "council.members"],
		[{ council: { members: [] } }, "council.members"],
		[{ council: { members: ["__proto__"] } }, "council.members"],
		[{ council: { members: ["synthesizer"] } }, "council.members"],
		[{ gutCheck: { backend: "codex" } }, "gutCheck.backend"],
		[{ gutCheck: { maxOutputTokens: 4097 } }, "gutCheck.maxOutputTokens"],
	])("rejects unsafe project config %j", (value, key) => {
		const file = join(root, ".bpx-council.json");
		writeFileSync(file, JSON.stringify(value));
		expect(() => resolveConfig(undefined, root)).toThrow(`${file}: ${key}`);
	});

	it("allows project bundled reorder over trusted global custom definitions without selecting custom persona", () => {
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ personas: { skeptic: { stance: "against", systemPrompt: "Trusted" } }, council: { members: ["skeptic"] } }));
		writeFileSync(join(root, ".bpx-council.json"), JSON.stringify({ council: { members: ["simplifier", "critic"] }, gutCheck: { backend: "anthropic:claude-opus-4-8", maxOutputTokens: 80 } }));
		const config = resolveConfig(undefined, root);
		expect(config.council?.members).toEqual(["simplifier", "critic"]);
		expect(config.personas?.skeptic.systemPrompt).toBe("Trusted");
		expect(config.gutCheck).toEqual({ backend: "anthropic:claude-opus-4-8", maxOutputTokens: 80 });
	});

	it.each([
		[{ council: { members: Array.from({ length: 9 }, (_, i) => `seat${i}`) } }, "council.members"],
		[{ personas: { "bad name": { stance: "for", systemPrompt: "S" } } }, "personas contains an unsafe name"],
		[{ personas: { custom: { stance: "for", systemPrompt: " " } } }, "personas entry.systemPrompt"],
		[{ personas: { synthesizer: { stance: "neutral", systemPrompt: "Collision." } } }, "personas.synthesizer"],
		[{ council: { backends: { synthesizer: "codex" } } }, "council.backends.synthesizer"],
		[{ personas: { custom: { stance: "for", systemPrompt: "x".repeat(8001) } } }, "personas entry.systemPrompt"],
	])("rejects invalid trusted definition %j", (value, key) => {
		const file = join(root, "trusted.json");
		writeFileSync(file, JSON.stringify(value));
		expect(() => resolveConfig(file, root)).toThrow(`${file}: ${key}`);
	});
});

describe("wizard preservation", () => {
	it("headless edit keeps advanced fields and CLI-specific settings in file", () => {
		const codex = join(root, "codex");
		writeFileSync(codex, "#!/bin/sh\nprintf 'mock\\n'\n"); chmodSync(codex, 0o755);
		const file = join(root, "trusted.json");
		writeFileSync(file, JSON.stringify({ defaultMode: "council",
			solo: { backend: { type: "cli", command: "codex", args: ["exec", "--json"], timeoutMs: 9000, model: "old" } },
			personas: { reviewer: { stance: "neutral", systemPrompt: "Review." } },
			council: { members: ["reviewer", "critic"], backends: { reviewer: "codex" } },
			gutCheck: { backend: "anthropic:claude-opus-4-8", maxOutputTokens: 80 },
		}));
		const result = invoke(["config", "--config", file, "--backend", "codex", "--model", "new", "--mode", "solo", "--yes"],
			{ PATH: `${root}:${process.env.PATH}` });
		expect(result.status).toBe(0);
		const saved = JSON.parse(readFileSync(file, "utf8"));
		expect(saved.solo.backend).toMatchObject({ args: ["exec", "--json"], timeoutMs: 9000, model: "new" });
		expect(saved.personas.reviewer.systemPrompt).toBe("Review.");
		expect(saved.council.members).toEqual(["reviewer", "critic"]);
		expect(saved.gutCheck).toEqual({ backend: "anthropic:claude-opus-4-8", maxOutputTokens: 80 });
	});
});

describe("independent gut-check", () => {
	it("uses saved route, explicit --backend, then Solo, with receipt identity", () => {
		const solo = advisor("solo");
		const saved = advisor("saved");
		const forced = advisor("forced");
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: solo } }, gutCheck: { backend: saved, maxOutputTokens: 24 } }));
		const result = invoke(["--mode", "gut-check", "--format", "json", "--no-stdin", "Q"]);
		expect(JSON.parse(result.stdout)).toMatchObject({ advice: "saved answer", attempts: [{ seat: "gut-check", route: { label: saved } }] });
		const overridden = invoke(["--mode", "gut-check", "--format", "json", "--backend", forced, "--no-stdin", "Q"]);
		expect(JSON.parse(overridden.stdout)).toMatchObject({ advice: "forced answer", attempts: [{ route: { label: forced } }] });
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: solo } }, gutCheck: { backend: null } }));
		const inherited = invoke(["--mode", "gut-check", "--format", "json", "--no-stdin", "Q"]);
		expect(JSON.parse(inherited.stdout)).toMatchObject({ advice: "solo answer", attempts: [{ route: { label: solo } }] });
	});

	it("applies run-wide timeout to an independently saved gut-check route", () => {
		const saved = join(root, "slow-gut");
		writeFileSync(saved, "#!/bin/sh\nsleep 2\nprintf 'too late\\n'\n");
		chmodSync(saved, 0o755);
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: advisor("solo") } }, gutCheck: { backend: saved } }));
		const result = invoke(["--mode", "gut-check", "--format", "json", "--timeout", "50", "--no-stdin", "Q"]);
		expect(result.status).not.toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ attempts: [{ seat: "gut-check", error: expect.stringContaining("timed out after 50ms") }] });
	});

	it("treats CLI output ceiling as a prompt request, without cutting the finding", () => {
		const command = join(root, "echo-prompt");
		writeFileSync(command, "#!/bin/sh\ncat\n"); chmodSync(command, 0o755);
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command } }, gutCheck: { maxOutputTokens: 20 } }));
		const result = invoke(["--mode", "gut-check", "--format", "json", "--no-stdin", "Full findings stay here"]);
		const receipt = JSON.parse(result.stdout);
		expect(receipt.advice).toContain("Full findings stay here");
		expect(receipt.advice).toContain("prompt request, not an enforced limit");
	});

	it("accepts images on saved gut route despite image-blind Solo", () => {
		const blind = advisor("blind");
		const codex = join(root, "codex");
		writeFileSync(codex, '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"Image reviewed"}}\'\n');
		chmodSync(codex, 0o755);
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: blind } }, gutCheck: { backend: "codex" } }));
		const image = join(root, "small.png");
		writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F40AAAAASUVORK5CYII=", "base64"));
		const result = invoke(["--mode", "gut-check", "--format", "json", "--image", image, "--no-stdin", "Q"], { PATH: `${root}:${process.env.PATH}` });
		expect(result.status).toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ advice: "Image reviewed", attempts: [{ route: { command: "codex" } }] });
	});

	it("uses actual gut route for image checks before any call", () => {
		const blind = advisor("blind");
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "codex" } }, gutCheck: { backend: blind } }));
		const image = join(root, "small.png");
		// Minimal valid PNG fixture isn't needed: validation catches an image-blind route after file inspection.
		writeFileSync(image, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/F40AAAAASUVORK5CYII=", "base64"));
		const result = invoke(["--mode", "gut-check", "--format", "json", "--image", image, "--no-stdin", "Q"]);
		expect(result.status).not.toBe(0);
		expect(JSON.parse(result.stdout)).toMatchObject({ attempts: [], error: expect.stringContaining("can't take images") });
		expect(result.stdout).not.toContain("codex can't take images");
	});

	it("sets HTTP max_tokens on request, without truncating text", async () => {
		const previous = process.env.ANTHROPIC_API_KEY;
		process.env.ANTHROPIC_API_KEY = "fake";
		const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ content: [{ type: "text", text: "Full finding, not cut." }] }) });
		vi.stubGlobal("fetch", fetch);
		try {
			const result = await callHttpAdvisor("S", "Q", { type: "http", provider: "anthropic", model: "test", maxOutputTokens: 45 });
			expect(result.text).toBe("Full finding, not cut.");
			expect(JSON.parse(fetch.mock.calls[0][1].body).max_tokens).toBe(45);
		} finally {
			if (previous === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = previous;
		}
	});
});
