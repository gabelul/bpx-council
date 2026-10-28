import { spawn } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it } from "vitest";

/** Await observable phase rather than guessing process timing. @param check Phase predicate. @returns Completion. */
async function until(check: () => boolean): Promise<void> {
	const end = Date.now() + 12_000;
	while (!check()) { if (Date.now() > end) throw new Error("Native SIGINT fixture phase deadline"); await delay(10); }
}

describe("native inference SIGINT", () => {
	it("drains real synthetic OAuth refresh + mixed CLI cleanup, repeats SIGINT safely, flushes partial JSON to slow reader", async () => {
		const root = await mkdtemp(join(realpathSync(tmpdir()), "council-native-signal-"));
		const fast = resolve("tests/fixtures/sdk-signal/fast-cli.cjs"); const slow = resolve("tests/fixtures/sdk-signal/slow-cli.cjs");
		await chmod(fast, 0o755); await chmod(slow, 0o755);
		const route = { type: "sdk", provider: "anthropic", model: "claude-sonnet-4-6", effort: "low", timeoutMs: 8000 };
		const file = join(root, "config.json");
		await writeFile(file, JSON.stringify({ defaultMode: "council", solo: { backend: route }, council: { members: ["architect", "critic", "simplifier"], backends: { architect: fast, critic: "sdk:anthropic:claude-sonnet-4-6@low", simplifier: slow } } }));
		const child = spawn(process.execPath, ["--import", "tsx", "--import", resolve("tests/fixtures/sdk-signal/register.mjs"), resolve("src/index.ts"), "--mode", "council", "--config", file, "--format", "json", "Synthetic question"], {
			cwd: process.cwd(), env: { ...process.env, SDK_SIGNAL_DIRECTORY: root, BPX_COUNCIL_MODEL: "", ANTHROPIC_MODEL: "", BPX_COUNCIL_NO_UPDATE_CHECK: "1" }, stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin.end();
		let stderr = ""; let stdout = ""; let closed = false; let slowReader = false;
		child.stdout.on("data", chunk => { stdout += chunk.toString(); if (slowReader) { child.stdout.pause(); setTimeout(() => child.stdout.resume(), 15); } });
		child.stderr.on("data", chunk => { stderr += chunk.toString(); });
		const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
			child.once("error", reject); child.once("close", (code, signal) => { closed = true; resolveExit({ code, signal }); });
		});
		try {
			await until(() => (stderr.includes("fixture-refresh-start") && stderr.includes("architect (") && stderr.includes("answered")) || closed);
			if (closed) throw new Error(`Fixture ended before calls: ${JSON.stringify(await exit)} ${stderr} ${stdout}`);
			child.stdout.pause(); child.kill("SIGINT"); child.kill("SIGINT"); await delay(100); expect(closed).toBe(false);
			await until(() => stderr.includes("fixture-storage-drain") || closed); expect(closed, stderr).toBe(false);
			child.kill("SIGINT"); await until(() => stderr.includes("fixture-drained") || closed); expect(closed, stderr).toBe(false);
			// Receipt is larger than pipe capacity. Repeat interrupt during backpressure, then read slowly.
			await delay(100); child.kill("SIGINT"); expect(closed).toBe(false);
			slowReader = true; child.stdout.resume();
			expect(await exit).toEqual({ code: 130, signal: null });
			const receipt = JSON.parse(stdout);
			expect(receipt.status).toBe("partial"); expect(receipt.advice).toContain("Earned CLI answer"); expect(receipt.advice.length).toBeGreaterThan(256 * 1024);
			expect(receipt.attempts.map((row: { seat: string }) => row.seat)).toEqual(["architect", "critic", "simplifier"]);
			expect(receipt.notRun).toEqual([{ seat: "synthesizer", round: null }]);
			expect(receipt.attempts[0].status).toBe("complete"); expect(receipt.attempts.slice(1).every((row: { status: string }) => row.status === "failed")).toBe(true);
			expect(await readFile(join(root, "cli-cleaned"), "utf8")).toBe("done");
			expect(JSON.parse(await readFile(join(root, "drained.json"), "utf8"))).toMatchObject({ oauthRequests: 1, inferenceRequests: 0 });
			const accountPath = join(root, "accounts/auth.json"); const bytes = await readFile(accountPath, "utf8"); const before = await stat(accountPath);
			expect(bytes).toContain("fixture-rotated-refresh-secret"); await delay(200);
			expect(await readFile(accountPath, "utf8")).toBe(bytes); expect((await stat(accountPath)).mtimeMs).toBe(before.mtimeMs);
		} finally { if (!closed) { child.kill("SIGKILL"); await exit; } await rm(root, { recursive: true, force: true }); }
	}, 20_000);
});
