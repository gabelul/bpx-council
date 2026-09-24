import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseArgs } from "../src/args.js";
import { doctorRoutes, runDoctor } from "../src/doctor.js";
import { isOnPath } from "../src/detect.js";
import type { BpxCouncilConfig } from "../src/config.js";

let root: string;
let home: string;
let previous: NodeJS.ProcessEnv;

/** Run real entrypoint, with all advisor invocations confined to fake binaries. */
function cli(args: string[], env: NodeJS.ProcessEnv = {}) {
	const result = spawnSync(process.execPath, ["--import", resolve("node_modules/tsx/dist/loader.mjs"), resolve("src/index.ts"), ...args], {
		cwd: root, input: "", encoding: "utf8", timeout: 15_000,
		env: { ...process.env, HOME: home, PATH: `${root}:/usr/bin:/bin`, ANTHROPIC_API_KEY: "", ...env },
	});
	if (result.error) throw result.error;
	return result;
}

/** Install an inert fake CLI; marker proves number of advisor calls. */
function fakeCodex() {
	const marker = join(root, "calls");
	const command = join(root, "codex");
	writeFileSync(command, `#!/bin/sh\necho called >> '${marker}'\nprintf '%s\\n' '{"type":"item.completed","item":{"type":"agent_message","text":"OK"}}'\n`);
	chmodSync(command, 0o755);
	return marker;
}

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "bpx-doctor-"));
	home = mkdtempSync(join(tmpdir(), "bpx-doctor-home-"));
	mkdirSync(join(root, ".git"));
	previous = { ...process.env };
	process.env.HOME = home;
});
afterEach(() => {
	process.env = previous;
	vi.restoreAllMocks();
	rmSync(root, { recursive: true, force: true });
	rmSync(home, { recursive: true, force: true });
});

describe("doctor command", () => {
	it("is offline even with present key, CLI, piped stdin and configured seats", () => {
		const marker = fakeCodex();
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "codex" } },
			gutCheck: { backend: "anthropic" }, council: { backends: { critic: "anthropic" } }, debate: { advocate: "codex" } }));
		const result = cli(["doctor"], { ANTHROPIC_API_KEY: "fake-key" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Council/critic: anthropic:claude-opus-4-8 — API key present; authentication unverified");
		expect(result.stdout).toContain("Debate/advocate: codex");
		expect(result.stdout).not.toContain("fake-key");
		expect(existsSync(marker)).toBe(false);
	});

	it("rejects consult/setup/install flags without executing probe", () => {
		const marker = fakeCodex();
		for (const args of [["doctor", "--probe", "--mode", "council"], ["doctor", "--format", "json"], ["doctor", "--version"], ["doctor", "--probe", "--file", "x"]]) {
			const result = cli(args);
			expect(result.status).toBe(1);
			expect(result.stderr).toContain("unknown option");
		}
		expect(existsSync(marker)).toBe(false);
		expect(parseArgs(["doctor", "--probe", "--config", "trusted.json"])).toMatchObject({ command: "doctor", probe: true, configPath: "trusted.json" });
	});

	it("warns before exactly one bounded Solo call, never other seats", () => {
		const marker = fakeCodex();
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "codex" } },
			council: { backends: { architect: "claude" } }, debate: { advocate: "claude" } }));
		const result = cli(["doctor", "--probe"]);
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("Probe route: codex. One advisor call; may charge");
		expect(result.stdout).toContain("Probe response received.");
		expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("reports project trust errors without calling an advisor or echoing JSON", () => {
		const marker = fakeCodex();
		writeFileSync(join(root, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "codex" } } }));
		const result = cli(["doctor", "--probe"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("solo.backend.command");
		expect(existsSync(marker)).toBe(false);
		writeFileSync(join(root, ".bpx-council.json"), '{"secret":"do-not-echo",');
		const malformed = cli(["doctor"]);
		expect(malformed.stderr).toContain("invalid JSON");
		expect(malformed.stderr).not.toContain("do-not-echo");
	});

	it("uses trusted custom paths for detection without shell expansion or execution", () => {
		const marker = join(root, "SHOULD-NOT-EXIST");
		const command = join(root, `advisor; touch ${marker.replaceAll("/", "_")}`);
		writeFileSync(command, `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(command, 0o755);
		expect(isOnPath(command)).toBe(true);
		expect(existsSync(marker)).toBe(false);
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command } } }));
		const result = cli(["doctor", "--probe"]);
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("no bounded, tool-disabled smoke preset");
		expect(existsSync(marker)).toBe(false);
	});

	it("marks unsupported HTTP unavailable and refuses a probe", () => {
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "http", provider: "openai", model: "x" } } }));
		const offline = cli(["doctor"], { OPENAI_API_KEY: "fake" });
		expect(offline.status).toBe(1);
		expect(offline.stdout).toContain("unavailable (HTTP provider not implemented)");
		const result = cli(["doctor", "--probe"], { OPENAI_API_KEY: "fake" });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("unavailable (HTTP provider not implemented)");
		expect(result.stderr).toContain("Probe skipped");
	});

	it("keeps null-reset seats and reports unknown custom persona", () => {
		const config: BpxCouncilConfig = { defaultMode: "solo", solo: { backend: { type: "cli", command: "codex" } },
			council: { members: ["mystery", "critic"], backends: { critic: null } }, debate: { critic: null } };
		const routes = doctorRoutes(config);
		expect(routes.find((route) => route.seat === "Council/mystery")?.error).toBe("unknown council persona");
		expect(routes.find((route) => route.seat === "Council/critic")?.backend).toMatchObject({ command: "codex" });
		expect(routes.find((route) => route.seat === "Debate/critic")?.backend).toMatchObject({ command: "codex" });
	});

	it("offline inspection never fetches, even with an API key", async () => {
		process.env.ANTHROPIC_API_KEY = "private-key";
		const fetch = vi.fn();
		vi.stubGlobal("fetch", fetch);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const config = join(home, "trusted.json");
		writeFileSync(config, JSON.stringify({ solo: { backend: { type: "http", provider: "anthropic", model: "test" } } }));
		expect(await runDoctor(config, root, false)).toBe(0);
		expect(fetch).not.toHaveBeenCalled();
		expect(output.mock.calls.flat().join(" ")).toContain("API key present; authentication unverified");
		vi.unstubAllGlobals();
	});

	it("probe refuses configured image paths before calling a backend", () => {
		const image = join(root, "private.png");
		const marker = join(root, "called");
		writeFileSync(join(root, "codex"), `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(join(root, "codex"), 0o755);
		writeFileSync(join(home, ".bpx-council.json"), JSON.stringify({ solo: { backend: { type: "cli", command: "codex", images: [image] } } }));
		const result = cli(["doctor", "--probe"]);
		expect(result.status).not.toBe(0);
		expect(result.stderr).toContain("solo.backend.images");
		expect(existsSync(marker)).toBe(false);
	});

	it("offline inspection never executes a PATH-selected which helper", () => {
		const marker = join(root, "which-ran");
		writeFileSync(join(root, "which"), `#!/bin/sh\ntouch '${marker}'\n`);
		chmodSync(join(root, "which"), 0o755);
		fakeCodex();
		const result = cli(["doctor"]);
		expect(result.status).toBe(0);
		expect(existsSync(marker)).toBe(false);
	});

	it("a parseable login warning is not presented as verified authentication", () => {
		writeFileSync(join(root, "codex"), '#!/bin/sh\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"login required"}}\'\n');
		chmodSync(join(root, "codex"), 0o755);
		const result = cli(["doctor", "--probe"]);
		expect(result.stdout).toContain("Authentication and model selection are not independently verified");
		expect(result.stdout).not.toContain("Authentication worked");
	});

	it("CLI probe caps stdout and hides discarded output", () => {
		const marker = join(root, "calls");
		writeFileSync(join(root, "codex"), `#!/bin/sh\necho called >> '${marker}'\nawk 'BEGIN {for(i=0;i<10000;i++) printf "S"}'\n`);
		chmodSync(join(root, "codex"), 0o755);
		const result = cli(["doctor", "--probe"]);
		expect(result.status).toBe(1);
		expect(result.stdout).not.toContain("SSSSSSSS");
		expect(result.stderr).toContain("Probe failed");
		expect(readFileSync(marker, "utf8").trim().split("\n")).toHaveLength(1);
	});

	it("HTTP probe sends one low-token request, never prints body or key", async () => {
		process.env.ANTHROPIC_API_KEY = "private-key";
		const fetch = vi.fn(async (_url: string, init: RequestInit) => {
			expect(JSON.parse(init.body as string)).toMatchObject({ max_tokens: 32, messages: [{ role: "user", content: "Reply OK." }] });
			return { ok: true, json: async () => ({ content: [{ type: "text", text: "sensitive answer" }] }) };
		});
		vi.stubGlobal("fetch", fetch);
		const output = vi.spyOn(console, "log").mockImplementation(() => {});
		const config = join(home, "trusted.json");
		writeFileSync(config, JSON.stringify({ solo: { backend: { type: "http", provider: "anthropic", model: "test" } } }));
		expect(await runDoctor(config, root, true)).toBe(0);
		expect(fetch).toHaveBeenCalledTimes(1);
		expect(output.mock.calls.flat().join(" ")).not.toMatch(/private-key|sensitive answer/);
		vi.unstubAllGlobals();
	});
});
