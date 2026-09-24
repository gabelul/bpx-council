import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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

	it("refuses output above the stdout cap", async () => {
		const result = await callCliAdvisor("S", "Q", {
			type: "cli", command: node,
			args: ["-e", "process.stdout.write('x'.repeat(4 * 1024 * 1024 + 1))"], timeoutMs: 5000,
		});
		expect(result.ok).toBe(false);
		expect(result.error).toContain("stdout exceeded");
	});
});
