import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { callCliAdvisor } from "../src/backend.js";

const node = process.execPath;

describe("CLI subprocess bounds", () => {
	it("refuses custom argv with images before launching fake Codex", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cli-image-"));
		const marker = join(dir, "spawned");
		const fake = join(dir, "codex");
		writeFileSync(fake, `#!/bin/sh\nprintf launched > ${JSON.stringify(marker)}\nprintf 'answer\\n'\n`);
		chmodSync(fake, 0o755);
		try {
			const result = await callCliAdvisor("S", "look at image", { type: "cli", command: fake,
				args: ["exec", "--json"], images: [join(dir, "image.png")] });
			expect(result).toMatchObject({ ok: false, text: "", error: expect.stringMatching(/custom CLI args cannot safely attach images/) });
			expect(existsSync(marker)).toBe(false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});
	it("times out a stalled advisor and reports failure", async () => {
		const result = await callCliAdvisor("S", "Q", {
			type: "cli", command: node, args: ["-e", "setInterval(() => {}, 1000)"], timeoutMs: 80,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("timed out after 80ms");
	});

	it.skipIf(process.platform === "win32")("kills descendant after parent exits on SIGTERM", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-tree-"));
		const marker = join(dir, "grandchild-lived");
		const grandchild = `process.on('SIGTERM',()=>{});setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),1500);setInterval(()=>{},1000)`;
		const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'inherit'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
		try {
			const result = await callCliAdvisor("S", "Q", { type: "cli", command: node, args: ["-e", parent], timeoutMs: 250 });
			expect(result.error).toContain("timed out");
			await new Promise((done) => setTimeout(done, 1700));
			expect(existsSync(marker)).toBe(false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it.skipIf(process.platform === "win32")("does not accept stdout from a signal-killed advisor", async () => {
		const result = await callCliAdvisor("S", "Q", { type: "cli", command: node,
			args: ["-e", "process.stdout.write('premature answer'); process.kill(process.pid, 'SIGTERM')"], timeoutMs: 5000 });
		expect(result).toMatchObject({ ok: false, text: "", error: expect.stringMatching(/terminated by signal SIGTERM/) });
	});

	it.skipIf(process.platform === "win32")("awaits abort cleanup even when TERM-resistant descendant closes inherited pipes", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-tree-abort-"));
		const marker = join(dir, "descendant-lived");
		const ready = join(dir, "ready");
		const grandchild = `process.on('SIGTERM',()=>{});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'alive'),1700);setInterval(()=>{},1000)`;
		const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(grandchild)}],{stdio:'ignore'});process.on('SIGTERM',()=>process.exit(0));setInterval(()=>{},1000)`;
		const controller = new AbortController();
		try {
			const pending = callCliAdvisor("S", "Q", { type: "cli", command: node, args: ["-e", parent], timeoutMs: 5000 }, controller.signal);
			const deadline = Date.now() + 2000;
			while (!existsSync(ready) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 10));
			expect(existsSync(ready)).toBe(true);
			const start = Date.now();
			controller.abort();
			expect(await pending).toMatchObject({ ok: false, text: "", error: "Advisor call cancelled" });
			expect(Date.now() - start).toBeGreaterThanOrEqual(950);
			await new Promise((done) => setTimeout(done, 900));
			expect(existsSync(marker)).toBe(false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("preaborted CLI call does not spawn or write, including Pi scratch setup", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cli-preabort-"));
		const marker = join(dir, "spawned");
		const controller = new AbortController(); controller.abort();
		try {
			expect(await callCliAdvisor("S", "Q", { type: "cli", command: node, args: ["-e", `require('node:fs').writeFileSync(${JSON.stringify(marker)},'bad')`] }, controller.signal)).toMatchObject({ ok: false, error: "Advisor call cancelled" });
			expect(await callCliAdvisor("S", "Q", { type: "cli", command: "pi" }, controller.signal)).toMatchObject({ ok: false, error: "Advisor call cancelled" });
			expect(existsSync(marker)).toBe(false);
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("uses transient cwd instead of accepting config cwd", async () => {
		const dir = mkdtempSync(join(tmpdir(), "bpx-cwd-"));
		try {
			const result = await callCliAdvisor("S", "Q", { type: "cli", command: node, args: ["-e", "process.stdout.write(process.cwd())"] }, undefined, dir);
			expect(result).toMatchObject({ ok: true, text: realpathSync(dir) });
		} finally { rmSync(dir, { recursive: true, force: true }); }
	});

	it("refuses output above the stdout cap", async () => {
		const result = await callCliAdvisor("S", "Q", {
			type: "cli", command: node,
			args: ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))"], timeoutMs: 5000,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("stdout exceeded");
	});
});
