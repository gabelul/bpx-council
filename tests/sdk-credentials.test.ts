import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, chmod, mkdir, symlink, link, writeFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SdkCredentials, SdkOperationBarrier } from "../src/sdk-credentials.js";
import type { Credential } from "@earendil-works/pi-ai";

let root: string;
let store: SdkCredentials;
const expired: Credential = { type: "oauth", access: "sk-ant-oat-synthetic-access", refresh: "synthetic-refresh", expires: 0 };

/** Commit synthetic explicit account without provider calls. @param target Own store. @param provider ID. @param credential Fixture. @returns Commit marker. */
async function put(target: SdkCredentials, provider: string, credential: Credential): Promise<{ changed: boolean }> {
	const receipt = { changed: false };
	await target.accountAction({ provider, expectedRevision: target.summary(provider).revision, receipt }, () => target.modify(provider, async () => credential));
	return receipt;
}

/** Await observable task start. @param predicate Check. @returns Completion. */
async function until(predicate: () => boolean): Promise<void> {
	const end = Date.now() + 5000;
	while (!predicate()) { if (Date.now() > end) throw new Error("Fixture observation deadline."); await delay(5); }
}

beforeEach(async () => { root = await mkdtemp(join(realpathSync(tmpdir()), "council-credentials-")); store = new SdkCredentials(join(root, "accounts")); });
afterEach(async () => { await store.barrier.settle(); await rm(root, { recursive: true, force: true }); });

describe("Council SDK CredentialStore", () => {
	it("reads missing accounts without writes and keeps DTOs secret-free", async () => {
		expect(store.summary("openai")).toEqual({ state: "missing", method: undefined, revision: "missing" });
		expect(await store.read("openai")).toBeUndefined(); expect(await store.list()).toEqual([]);
		expect(await readdir(root)).toEqual([]);
		await put(store, "openai", { type: "api_key", key: "sk-synthetic-only-key" });
		expect(JSON.stringify(store.summary("openai"))).not.toContain("sk-synthetic-only-key");
		expect(await store.list()).toEqual([{ providerId: "openai", type: "api_key" }]);
		expect(statSync(store.directory).mode & 0o777).toBe(0o700);
		expect(statSync(join(store.directory, "auth.json")).mode & 0o777).toBe(0o600);
		expect((await readdir(store.directory)).sort()).toEqual(["auth.json"]);
	});

	it("changes opaque generation only on explicit login/key/logout, retaining tombstones", async () => {
		await put(store, "anthropic", expired);
		const first = store.summary("anthropic").revision;
		await store.modify("anthropic", async current => ({ ...current as typeof expired, access: "rotated-synthetic", expires: Date.now() + 3_600_000 }));
		expect(store.summary("anthropic").revision).toBe(first);
		await put(store, "anthropic", { type: "api_key", key: "synthetic-key" });
		const second = store.summary("anthropic").revision; expect(second).not.toBe(first);
		await store.delete("anthropic");
		const tombstone = store.summary("anthropic"); expect(tombstone.state).toBe("missing"); expect(tombstone.revision).not.toBe(second);
		await expect(store.accountAction({ provider: "anthropic", expectedRevision: second, receipt: { changed: false } },
			() => store.modify("anthropic", async () => expired))).rejects.toMatchObject({ code: "stale" });
		await expect(store.modify("anthropic", async () => expired)).rejects.toMatchObject({ code: "credential" });
		expect(store.summary("anthropic")).toEqual(tombstone);
	});

	it("rejects unknown providers, helper commands, env overrides and unsupported OAuth", async () => {
		await expect(store.read("amazon-bedrock")).rejects.toMatchObject({ code: "provider" });
		for (const credential of [{ type: "api_key", key: "!echo secret" }, { type: "api_key", key: "" },
			{ type: "api_key", key: "synthetic", env: { OPENAI_API_KEY: "ambient" } }, expired]) {
			await expect(put(store, "openai", credential as Credential)).rejects.toBeDefined();
		}
		expect(store.summary("openai").state).toBe("missing");
	});

	it("refuses malformed and oversized files without overwriting or leaking content", async () => {
		await put(store, "openai", { type: "api_key", key: "sk-synthetic-secret" });
		for (const content of ["{secret-synthetic-malformed", "x".repeat(1024 * 1024 + 1),
			JSON.stringify({ version: 1, accounts: { evil: { generation: "fake", credential: { type: "api_key", key: "!helper" } } } })]) {
			await writeFile(join(store.directory, "auth.json"), content, { mode: 0o600 });
			expect(store.summary("openai").state).toBe("invalid");
			await expect(put(store, "openai", { type: "api_key", key: "sk-replacement" })).rejects.toThrow("Council account storage is unavailable or invalid.");
			expect(await readFile(join(store.directory, "auth.json"), "utf8")).toBe(content);
			expect(JSON.stringify(store.summary("openai"))).not.toContain("synthetic");
		}
	});

	it("rejects symlink files, directories, lock paths, hardlinks and permissive modes", async () => {
		await mkdir(store.directory, { mode: 0o700 });
		const outside = join(root, "outside"); await writeFile(outside, "private-fixture", { mode: 0o600 });
		await symlink(outside, join(store.directory, "auth.json"));
		expect(store.summary("openai").state).toBe("invalid");
		await expect(put(store, "openai", { type: "api_key", key: "sk-fixture" })).rejects.toBeDefined();
		expect(await readFile(outside, "utf8")).toBe("private-fixture");
		await rm(join(store.directory, "auth.json"));
		await symlink(outside, join(store.directory, "auth.json.lock"));
		await expect(put(store, "openai", { type: "api_key", key: "sk-fixture" })).rejects.toBeDefined();
		await rm(join(store.directory, "auth.json.lock"));
		await put(store, "openai", { type: "api_key", key: "sk-fixture" });
		await chmod(join(store.directory, "auth.json"), 0o644);
		expect(store.summary("openai").state).toBe("invalid");
		await chmod(join(store.directory, "auth.json"), 0o600);
		await link(join(store.directory, "auth.json"), join(root, "hardlink"));
		expect(store.summary("openai").state).toBe("invalid");
		await rm(join(root, "hardlink"));
		await chmod(store.directory, 0o755);
		expect(store.summary("openai").state).toBe("invalid");
		const linked = join(root, "linked"); await symlink(store.directory, linked);
		expect(new SdkCredentials(linked).summary("openai").state).toBe("invalid");
	});

	it("registers lease synchronously; cancelled lock wait does no callback/write", async () => {
		await put(store, "anthropic", expired);
		let release!: () => void;
		let started = false;
		const holding = store.modify("anthropic", async () => { started = true; await new Promise<void>(resolve => { release = resolve; }); return undefined; });
		await until(() => started);
		const abort = new AbortController(); let called = false;
		const queued = store.barrier.scope(() => store.modify("anthropic", async () => { called = true; return expired; }, { signal: abort.signal }));
		let settled = false; const shutdown = store.barrier.settle().then(() => { settled = true; });
		expect(settled).toBe(false);
		abort.abort(); await expect(queued).rejects.toBeDefined(); expect(called).toBe(false);
		expect(settled).toBe(false); release(); await holding; await shutdown;
		expect((await readdir(store.directory)).sort()).toEqual(["auth.json"]);
	});

	it("awaits refresh and persistence before operation return, but not unrelated leases", async () => {
		await put(store, "anthropic", expired);
		let release!: () => void; let started = false;
		const scope = store.barrier.scope(async () => {
			void store.modify("anthropic", async () => { started = true; await new Promise<void>(resolve => { release = resolve; }); return { ...expired, access: "rotated" }; });
			return "terminal-native-result";
		});
		await until(() => started); let done = false; void scope.then(() => { done = true; });
		await store.barrier.scope(async () => undefined); expect(done).toBe(false);
		release(); expect(await scope).toBe("terminal-native-result");
		expect((await store.read("anthropic") as { access: string }).access).toBe("rotated");
	});

	it("serializes logout after refresh and blocks stale concurrent login", async () => {
		await put(store, "anthropic", expired);
		const revision = store.summary("anthropic").revision;
		let release!: () => void; let started = false;
		const refresh = store.modify("anthropic", async () => { started = true; await new Promise<void>(resolve => { release = resolve; }); return { ...expired, access: "rotation" }; });
		await until(() => started);
		const receipt = { changed: false };
		const logout = store.accountAction({ provider: "anthropic", expectedRevision: revision, receipt }, () => store.delete("anthropic"));
		release(); await Promise.all([refresh, logout]); expect(receipt.changed).toBe(true);
		expect(await store.read("anthropic")).toBeUndefined();
		await expect(store.accountAction({ provider: "anthropic", expectedRevision: revision, receipt: { changed: false } },
			() => store.modify("anthropic", async () => expired))).rejects.toMatchObject({ code: "stale" });
	});

	it("rechecks confirmed generation inside locked modify before running refresh callback", async () => {
		await put(store, "anthropic", expired);
		const revision = store.summary("anthropic").revision;
		await put(store, "anthropic", { type: "api_key", key: "changed-account" });
		let refreshCalled = false;
		await expect(store.inferenceAction("anthropic", revision, () => store.modify("anthropic", async () => {
			refreshCalled = true; return expired;
		}))).rejects.toMatchObject({ code: "stale" });
		expect(refreshCalled).toBe(false);
		expect(await store.read("anthropic")).toEqual({ type: "api_key", key: "changed-account" });
	});

	it.each(["rotation", "logout", "different-provider"])("fences compromised late refresh after second process %s", async action => {
		await put(store, "anthropic", expired);
		const revision = store.summary("anthropic").revision;
		let release!: () => void; let started = false; let callbacks = 0;
		const late = store.modify("anthropic", async () => {
			started = true; callbacks++; await new Promise<void>(resolve => { release = resolve; }); return { ...expired, access: "first-rotation" };
		});
		await until(() => started);
		await rm(join(store.directory, "auth.json.lock"), { recursive: true });
		const script = `
		import { SdkCredentials } from ${JSON.stringify(new URL("../src/sdk-credentials.ts", import.meta.url).href)};
		const store = new SdkCredentials(process.env.FIXTURE_DIRECTORY);
		if (process.env.FIXTURE_ACTION === 'logout') await store.delete('anthropic');
		else if (process.env.FIXTURE_ACTION === 'different-provider') {
		  await store.accountAction({ provider: 'openai', expectedRevision: store.summary('openai').revision, receipt: { changed: false } },
		    () => store.modify('openai', async () => ({ type: 'api_key', key: 'sk-different-provider-key' })));
		} else await store.modify('anthropic', async current => ({ ...current, access: 'newer-rotation', expires: Date.now() + 3600000 }));
		await store.barrier.settle();
		`;
		await new Promise<void>((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
				cwd: process.cwd(), env: { HOME: root, PATH: "", FIXTURE_DIRECTORY: store.directory, FIXTURE_ACTION: action }, stdio: ["ignore", "pipe", "pipe"] });
			child.on("error", reject); child.on("close", code => { if (code === 0) resolve(); else reject(new Error(`Fixture worker exit ${code}.`)); });
		});
		const before = await readFile(join(store.directory, "auth.json"), "utf8");
		release();
		if (action === "different-provider") {
			expect((await late as { access: string }).access).toBe("first-rotation");
			expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-different-provider-key" });
			expect(store.summary("anthropic").revision).toBe(revision);
		} else {
			await expect(late).rejects.toThrow("Council credential synchronization failed; reconnect account before trying again.");
			expect(await readFile(join(store.directory, "auth.json"), "utf8")).toBe(before);
		}
		expect(callbacks).toBe(1);
		if (action === "rotation") {
			expect(store.summary("anthropic").revision).toBe(revision);
			expect((await store.read("anthropic") as { access: string }).access).toBe("newer-rotation");
		} else if (action === "logout") {
			expect(store.summary("anthropic").revision).not.toBe(revision);
			expect(await store.read("anthropic")).toBeUndefined();
		}
		expect(await readdir(store.directory)).toEqual(["auth.json"]);
	}, 15_000);

	it("preserves same and different-provider cross-process updates under whole-file lock", async () => {
		await put(store, "anthropic", expired);
		const script = `
		import { SdkCredentials } from ${JSON.stringify(new URL("../src/sdk-credentials.ts", import.meta.url).href)};
		import { appendFile } from 'node:fs/promises';
		const store = new SdkCredentials(process.env.FIXTURE_DIRECTORY);
		await store.modify('anthropic', async current => {
		  if (current.expires !== 0) return undefined;
		  await new Promise(resolve => setTimeout(resolve, 80));
		  await appendFile(process.env.FIXTURE_COUNT, 'refresh\\n');
		  return { ...current, access: 'cross-process-rotation', expires: Date.now() + 3600000 };
		});
		if (process.env.FIXTURE_OTHER) {
		  const receipt = { changed: false };
		  await store.accountAction({ provider: 'openai', expectedRevision: store.summary('openai').revision, receipt },
		    () => store.modify('openai', async () => ({ type: 'api_key', key: 'sk-cross-process-key' })));
		}
		await store.barrier.settle();
		`;
		/** Spawn Node worker using only synthetic HOME and explicit fixture paths. @param other Whether to update second provider. @returns Safe process output. */
		const worker = (other: boolean): Promise<string> => new Promise((resolve, reject) => {
			const child = spawn(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], { cwd: process.cwd(),
				env: { HOME: root, PATH: "", FIXTURE_DIRECTORY: store.directory, FIXTURE_COUNT: join(root, "count"), FIXTURE_OTHER: other ? "1" : "" }, stdio: ["ignore", "pipe", "pipe"] });
			let output = ""; child.stdout.on("data", data => { output += data; }); child.stderr.on("data", data => { output += data; });
			child.on("error", reject); child.on("close", code => { if (code === 0) resolve(output); else reject(new Error(`Fixture worker exit ${code}: ${output}`)); });
		});
		const logs = await Promise.all([worker(true), worker(false)]);
		expect(logs.join("")).not.toContain("sk-cross-process-key");
		expect(await readFile(join(root, "count"), "utf8")).toBe("refresh\n");
		expect((await store.read("anthropic") as { access: string }).access).toBe("cross-process-rotation");
		expect(await store.read("openai")).toEqual({ type: "api_key", key: "sk-cross-process-key" });
		expect(statSync(join(store.directory, "auth.json")).mode & 0o777).toBe(0o600);
	}, 15_000);
});

// Separate store exercise proves shutdown tracking without filesystem or SDK defaults.
it("tracks arbitrary owned work synchronously before first await", async () => {
	const barrier = new SdkOperationBarrier(); let release!: () => void;
	const owned = barrier.track(() => new Promise<void>(resolve => { release = resolve; }));
	let finished = false; const shutdown = barrier.settle().then(() => { finished = true; });
	await until(() => !!release); expect(finished).toBe(false); release(); await owned; await shutdown;
});
