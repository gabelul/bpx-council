import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = resolve("src/index.ts");
const loader = resolve("node_modules/tsx/dist/loader.mjs");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==", "base64");

describe("invocation-wide image transport checks", () => {
	it.each(["solo", "council", "debate"])("warns for catalog-confirmed text-only Codex in %s", (mode) => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-text-only-"));
		try {
			const command = join(dir, "codex");
			const image = join(dir, "image.png");
			writeFileSync(command, "#!/bin/sh\nif [ \"$1\" = debug ]; then printf '%s\\n' '{\"models\":[{\"slug\":\"text-only\",\"input_modalities\":[\"text\"]}]}'; exit 0; fi\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"answer\"}}'\n");
			chmodSync(command, 0o755);
			writeFileSync(image, png);
			const run = spawnSync(process.execPath, ["--import", loader, entry,
				"--mode", mode, "--backend", "codex", "--model", "text-only", "--image", image, "--no-stdin", "Q"], {
				cwd: dir, encoding: "utf8", timeout: 10_000,
				env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`, ANTHROPIC_API_KEY: "" },
			});
			if (run.error) throw run.error;
			expect(run.status).toBe(0);
			expect(run.stderr).toContain("Warning: text-only takes text only");
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it.each([
		{ name: "council unsupported HTTP synthesizer", mode: "council", seatArgs: ["--synthesizer", "openai"], error: "HTTP backend for openai not yet implemented" },
		{ name: "debate unsupported HTTP critic", mode: "debate", seatArgs: ["--critic", "google"], error: "HTTP backend for google not yet implemented" },
		{ name: "council unkeyed Anthropic synthesizer", mode: "council", seatArgs: ["--synthesizer", "anthropic"], error: "No API key found in $ANTHROPIC_API_KEY" },
		{ name: "debate unkeyed Anthropic critic", mode: "debate", seatArgs: ["--critic", "anthropic"], error: "No API key found in $ANTHROPIC_API_KEY" },
	])("$name makes zero fake backend calls", ({ mode, seatArgs, error }) => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-http-preflight-"));
		try {
			const calls = join(dir, "calls");
			const command = join(dir, "codex");
			writeFileSync(command, "#!/bin/sh\nprintf 'called\\n' >> \"$BPX_TEST_CALLS\"\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"answer\"}}'\n");
			chmodSync(command, 0o755);
			const run = spawnSync(process.execPath, ["--import", loader, entry, "--format", "json", "--mode", mode,
				"--backend", "codex", "--no-stdin", ...seatArgs, "Q"], {
				cwd: dir, encoding: "utf8", timeout: 10_000,
				env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`,
					ANTHROPIC_API_KEY: "", BPX_TEST_CALLS: calls },
			});
			if (run.error) throw run.error;
			expect(run.status).not.toBe(0);
			expect(JSON.parse(run.stdout)).toMatchObject({ status: "failed", error: expect.stringContaining(error), attempts: [], planned: [] });
			expect(existsSync(calls)).toBe(false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it.each([
		{ name: "council late member", args: ["--mode", "council", "--backends", "codex,codex", "--synthesizer", "codex"] },
		{ name: "council inherited synthesizer", args: ["--mode", "council", "--backends", "codex,codex,codex"] },
		{ name: "debate critic", args: ["--mode", "debate", "--advocate", "codex", "--synthesizer", "codex"] },
		{ name: "debate inherited synthesizer", args: ["--mode", "debate", "--advocate", "codex", "--critic", "codex"] },
	])("$name makes zero fake backend calls", ({ args }) => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-preflight-"));
		try {
			const calls = join(dir, "calls");
			const command = join(dir, "codex");
			const config = join(dir, "config.json");
			const image = join(dir, "image.png");
			writeFileSync(command, "#!/bin/sh\nprintf 'called\\n' >> \"$BPX_TEST_CALLS\"\nprintf '%s\\n' '{\"type\":\"item.completed\",\"item\":{\"type\":\"agent_message\",\"text\":\"answer\"}}'\n");
			chmodSync(command, 0o755);
			writeFileSync(config, JSON.stringify({ solo: { backend: {
				type: "cli", command: "codex", args: ["exec", "--json", "-"],
			} } }));
			writeFileSync(image, png);

			const run = spawnSync(process.execPath, ["--import", loader, entry, "--format", "json",
				"--config", config, "--image", image, "--no-stdin", ...args, "Q"], {
				cwd: dir, encoding: "utf8", timeout: 10_000,
				env: { ...process.env, HOME: dir, PATH: `${dir}:${process.env.PATH ?? ""}`,
					ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", BPX_TEST_CALLS: calls },
			});
			if (run.error) throw run.error;
			expect(run.status).not.toBe(0);
			const receipt = JSON.parse(run.stdout);
			expect(receipt).toMatchObject({ status: "failed", error: expect.stringContaining("custom CLI args cannot safely attach images"),
				attempts: [], planned: [] });
			expect(existsSync(calls)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});
