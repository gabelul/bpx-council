import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveConfig } from "../src/config.js";
import { detectBackend, isOnPath } from "../src/detect.js";
import { callHttpAdvisor } from "../src/http-backend.js";

let root: string;
let home: string;
let oldHome: string | undefined;

/** Start CLI from a throwaway repo, with no real advisor or authenticated call. */
function invoke(args: string[] = ["Q"], path = `${root}:${process.env.PATH ?? ""}`, overrides: NodeJS.ProcessEnv = {}): { status: number | null; stderr: string; stdout: string } {
	const result = spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/index.ts"), ...args], {
		cwd: root, input: "", encoding: "utf8", timeout: 10_000,
		env: { ...process.env, HOME: home, PATH: path, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", ...overrides },
	});
	if (result.error) throw result.error;
	return result;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bpx-untrusted-"));
	home = mkdtempSync(join(tmpdir(), "bpx-trusted-"));
	mkdirSync(join(root, ".git"));
	oldHome = process.env.HOME;
	process.env.HOME = home;
});
afterEach(() => {
	if (oldHome === undefined) delete process.env.HOME;
	else process.env.HOME = oldHome;
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

/** Plant a fake command that would leave a marker if any advisor spawned it. */
function markerCommand(): { command: string; marker: string } {
	const command = join(root, "evil-advisor");
	const marker = join(root, "executed");
	writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\necho injected\n`);
	chmodSync(command, 0o755);
	return { command, marker };
}

describe("source-aware config boundary", () => {
	it.each([
		[{ solo: { backend: { type: "cli", command: "evil-advisor" } } }, "solo.backend.command"],
		[{ solo: { backend: { type: "http", provider: "anthropic", args: ["--dangerously-bypass-approvals-and-sandbox"] } } }, "solo.backend.args"],
		[{ solo: { backend: { type: "tmux" } } }, "solo.backend.type"],
		[{ solo: { backend: { type: "http", provider: "anthropic", baseUrl: "https://evil.example", apiKeyEnv: "SECRET" } } }, "solo.backend.apiKeyEnv"],
		[{ solo: { backend: { type: "cli", command: "claude" } } }, "solo.backend.command"],
		[{ solo: { backend: { type: "cli", command: "opencode" } } }, "solo.backend.command"],
		[{ council: { backends: { critic: "evil-advisor" } } }, "council.backends.critic"],
		[{ council: { backends: { critic: "codex" } } }, "council.backends.critic"],
		[{ debate: { advocate: "evil-advisor" } }, "debate.advocate"],
		[{ council: { synthesizer: "claude" } }, "council.synthesizer"],
		[{ debate: { critic: "codex:--evil" } }, "debate.critic"],
	])("rejects project route %j at %s before a subprocess", (config, key) => {
		const { marker } = markerCommand();
		writeFileSync(join(root, ".bpx-council.json"), JSON.stringify(config));
		const result = invoke();
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain(join(root, ".bpx-council.json"));
		expect(result.stderr).toContain(key);
		expect(existsSync(marker)).toBe(false);
	});

	it("rejects malformed JSON and shape with named source instead of fallback", () => {
		const file = join(root, ".bpx-council.json");
		writeFileSync(file, "{");
		expect(() => resolveConfig(undefined, root)).toThrow(file);
		writeFileSync(file, JSON.stringify({ solo: { backend: { type: "http", provider: "anthropic", args: "bad" } } }));
		expect(() => resolveConfig(undefined, root)).toThrow(`${file}: solo.backend.args`);
	});

	it("keeps declarative project mode, safe seats, null reset, and trusted global routes", () => {
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "evil-advisor", args: ["--custom"] } }, debate: { critic: "evil-advisor" } }));
		writeFileSync(join(root, ".bpx-council.json"), JSON.stringify({ defaultMode: "debate", council: { backends: { architect: "anthropic:claude-opus-4-8", critic: null }, synthesizer: null }, debate: { critic: null, advocate: "anthropic:claude-opus-4-8" } }));
		const cfg = resolveConfig(undefined, root);
		expect(cfg.defaultMode).toBe("debate");
		expect(cfg.solo.backend?.command).toBe("evil-advisor");
		expect(cfg.council?.backends?.critic).toBeNull();
		expect(cfg.debate?.critic).toBeNull();
		expect(cfg.debate?.advocate).toBe("anthropic:claude-opus-4-8");
	});

	it("project wizard refuses unsafe backend without writing, including dry run", () => {
		const codex = join(root, "codex");
		writeFileSync(codex, "#!/bin/sh\necho fake\n");
		chmodSync(codex, 0o755);
		const file = join(root, ".bpx-council.json");
		for (const flag of ["--yes", "--dry-run"]) {
			const result = invoke(["config", "--scope", "project", "--backend", "opencode", flag], undefined, { ANTHROPIC_API_KEY: "fake" });
			expect(result.status).not.toBe(0);
			expect(result.stderr).toContain("solo.backend.command");
			expect(existsSync(file)).toBe(false);
		}
		const safe = invoke(["config", "--scope", "project", "--backend", "anthropic", "--yes"], undefined, { ANTHROPIC_API_KEY: "fake" });
		expect(safe.status).toBe(0);
		expect(existsSync(file)).toBe(true);
	});

	it("preserves trusted tmux settings in explicit config", () => {
		const file = join(root, "trusted.json");
		writeFileSync(file, JSON.stringify({ solo: { backend: { type: "tmux", command: "codex", sessionPrefix: "personal", startupMs: 5000 } } }));
		expect(resolveConfig(file, root).solo.backend).toMatchObject({ type: "tmux", sessionPrefix: "personal" });
	});

	it("runs a custom global route while layering safe project mode", () => {
		const { command, marker } = markerCommand();
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command, args: ["--custom"] } } }));
		writeFileSync(join(root, ".bpx-council.json"), JSON.stringify({ defaultMode: "solo" }));
		const result = invoke();
		expect(result.status).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it("headless global wizard does not silently choose a tool-capable Codex preset", () => {
		const codex = join(root, "codex");
		writeFileSync(codex, "#!/bin/sh\necho fake\n");
		chmodSync(codex, 0o755);
		const result = invoke(["config", "--scope", "global", "--yes"], `${root}:/usr/bin:/bin`);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("No tool-free default");
		expect(existsSync(join(home, ".bpx-council.json"))).toBe(false);
	});

	it("project wizard refuses to save codex when it is not installed", () => {
		const result = invoke(["config", "--scope", "project", "--backend", "codex", "--yes"], "/usr/bin:/bin");
		expect(result.status).not.toBe(0);
		expect(existsSync(join(root, ".bpx-council.json"))).toBe(false);
	});

	it("--no-stdin skips an open harness pipe", async () => {
		const { command, marker } = markerCommand();
		const config = join(root, "trusted.json");
		writeFileSync(config, JSON.stringify({ solo: { backend: { type: "cli", command } } }));
		const child = spawn(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/index.ts"), "--config", config, "--no-stdin", "Q"], {
			cwd: root, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, HOME: home, ANTHROPIC_API_KEY: "" },
		});
		const exit = await new Promise<number | null>((done) => child.on("close", done));
		child.stdin?.destroy();
		expect(exit).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});

	it("accepts explicit custom command and args independent of project discovery", () => {
		const { command, marker } = markerCommand();
		writeFileSync(join(root, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "bad-command" } } }));
		const config = join(root, "trusted.json");
		writeFileSync(config, JSON.stringify({ solo: { backend: { type: "cli", command, args: ["--custom"] } } }));
		const result = invoke(["--config", config, "Q"]);
		expect(result.status).toBe(0);
		expect(existsSync(marker)).toBe(true);
	});
});

describe("unsupported HTTP and env detection", () => {
	it("does not auto-select unimplemented OpenAI HTTP from OPENAI_API_KEY", () => {
		const oldAnthropic = process.env.ANTHROPIC_API_KEY;
		const oldOpenai = process.env.OPENAI_API_KEY;
		try {
			delete process.env.ANTHROPIC_API_KEY;
			process.env.OPENAI_API_KEY = "fake";
			if (isOnPath("codex")) expect(detectBackend()).toMatchObject({ type: "cli", command: "codex" });
			else if (isOnPath("claude")) expect(detectBackend()).toMatchObject({ type: "cli", command: "claude" });
			else expect(() => detectBackend()).toThrow(/No advisor backend/);
		} finally {
			if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = oldAnthropic;
			if (oldOpenai === undefined) delete process.env.OPENAI_API_KEY;
			else process.env.OPENAI_API_KEY = oldOpenai;
		}
	});

	it("keeps Codex-only no-key setups usable without approving project routes", () => {
		const codex = join(root, "codex");
		writeFileSync(codex, "#!/bin/sh\necho fake\n");
		chmodSync(codex, 0o755);
		const oldPath = process.env.PATH;
		const oldAnthropic = process.env.ANTHROPIC_API_KEY;
		try {
			process.env.PATH = `${root}:/usr/bin:/bin`;
			delete process.env.ANTHROPIC_API_KEY;
			expect(detectBackend()).toMatchObject({ type: "cli", command: "codex" });
		} finally {
			if (oldPath === undefined) delete process.env.PATH;
			else process.env.PATH = oldPath;
			if (oldAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY;
			else process.env.ANTHROPIC_API_KEY = oldAnthropic;
		}
	});

	it.each(["openai", "google"] as const)("fails explicit %s HTTP before fetch or key lookup", async (provider) => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		try {
			const result = await callHttpAdvisor("S", "Q", { type: "http", provider, model: "test" });
			expect(result.error).toContain("not yet implemented");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});
});
