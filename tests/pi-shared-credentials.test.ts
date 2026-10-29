import { mkdtemp, readFile, rm, writeFile, chmod } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validSdkCredential, validSharedSdkCredential, isSdkCredentialProvider } from "../src/sdk-credentials.js";
import { PiSharedCredentials } from "../src/pi-shared-credentials.js";
import { createSdkProviderService } from "../src/sdk-provider-service.js";
import type { Credential } from "@earendil-works/pi-ai";

let root: string;
let store: PiSharedCredentials;

const anthropicLogin: Credential = { type: "oauth", access: "synthetic-anthropic-access", refresh: "synth-refresh-a", expires: 1234 };
const codexLogin = { type: "oauth", access: "header.synthetic-codex-jwt.body", refresh: "synth-refresh-c", expires: 5678, accountId: "synthetic-account", futureField: "keep-me" };
const piFile = () => ({
	"deepseek": { type: "api_key", key: "synthetic-deepseek-key" },
	"anthropic": anthropicLogin,
	"openai-codex": codexLogin,
	"zai": { type: "api_key", key: "synthetic-zai-key" },
});

beforeEach(async () => {
	root = await mkdtemp(join(realpathSync(tmpdir()), "council-pi-shared-"));
	await writeFile(join(root, "auth.json"), JSON.stringify(piFile()), { mode: 0o600 });
	await chmod(join(root, "auth.json"), 0o600);
	store = new PiSharedCredentials(root);
});
afterEach(async () => { await store.barrier.settle(); await rm(root, { recursive: true, force: true }); });

describe("credential admission for new providers", () => {
	it("admits openai-codex OAuth with and without accountId; rejects elsewhere", () => {
		expect(isSdkCredentialProvider("openai-codex")).toBe(true);
		expect(isSdkCredentialProvider("zai")).toBe(true);
		expect(validSdkCredential("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 1 })).toBe(true);
		expect(validSdkCredential("openai-codex", { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acc" })).toBe(true);
		expect(validSdkCredential("openai-codex", { type: "api_key", key: "sk-x" })).toBe(false);
		expect(validSdkCredential("openai", { type: "oauth", access: "a", refresh: "r", expires: 1, accountId: "acc" })).toBe(false);
		expect(validSdkCredential("zai", { type: "api_key", key: "zai-literal" })).toBe(true);
		expect(validSdkCredential("zai", { type: "oauth", access: "a", refresh: "r", expires: 1 })).toBe(false);
	});
	it("shared validation tolerates unknown fields; strict own-store validation does not", () => {
		expect(validSharedSdkCredential("openai-codex", codexLogin)).toBe(true);
		expect(validSdkCredential("openai-codex", codexLogin)).toBe(false); // futureField unknown to strict codec
		expect(validSharedSdkCredential("anthropic", { type: "oauth", access: "a", refresh: "r", expires: 1, novel: {} })).toBe(true);
		expect(validSharedSdkCredential("anthropic", { type: "oauth", refresh: "r", expires: 1 })).toBe(false);
		expect(validSharedSdkCredential("deepseek", { type: "api_key", key: "k" })).toBe(false); // not admitted
	});
});

describe("PiSharedCredentials store", () => {
	it("reads admitted providers and hides pi's other providers from listing", async () => {
		expect(await store.read("anthropic")).toEqual(anthropicLogin);
		await expect(store.read("deepseek" as never)).rejects.toThrow();
		const listed = await store.list();
		expect(listed.map((entry) => entry.providerId).sort()).toEqual(["anthropic", "openai-codex", "zai"]);
		expect(JSON.stringify(listed)).not.toContain("synthetic-zai-key");
	});
	it("summary reports stored state and content revisions", () => {
		expect(store.summary("openai-codex")).toMatchObject({ state: "stored", method: "oauth" });
		expect(store.summary("zai")).toMatchObject({ state: "stored", method: "api_key" });
		const before = store.summary("anthropic").revision;
		expect(store.summary("anthropic").revision).toBe(before);
	});
	it("refresh preserves unknown providers and unknown fields verbatim", async () => {
		const next: Credential = { type: "oauth", access: "rotated-access", refresh: "rotated-refresh", expires: 9999 };
		await store.modify("anthropic", async () => next);
		const file = JSON.parse(await readFile(join(root, "auth.json"), "utf8"));
		expect(file.anthropic).toEqual(next);
		expect(file.deepseek).toEqual({ type: "api_key", key: "synthetic-deepseek-key" });
		expect(file["openai-codex"]).toEqual(codexLogin); // untouched, unknown field kept
		expect(statSync(join(root, "auth.json")).mode & 0o777).toBe(0o600);
	});
	it("delete removes only the target provider's login", async () => {
		await store.delete("zai");
		const file = JSON.parse(await readFile(join(root, "auth.json"), "utf8"));
		expect(file.zai).toBeUndefined();
		expect(file.anthropic).toEqual(anthropicLogin);
		expect(store.summary("zai").state).toBe("missing");
	});
	it("revision fences notice credential changes inside an inference scope", async () => {
		const revision = store.summary("openai-codex").revision;
		await store.inferenceAction("openai-codex", revision, async () => {
			const file = JSON.parse(await readFile(join(root, "auth.json"), "utf8"));
			file["openai-codex"].access = "externally-rotated";
			await writeFile(join(root, "auth.json"), JSON.stringify(file));
			expect(() => store.assertRevision("openai-codex")).toThrow();
		});
	});
	it("rejects malformed admitted entries without touching the file", async () => {
		await rm(root, { recursive: true, force: true });
		const { mkdir } = await import("node:fs/promises");
		await mkdir(root, { recursive: true });
		await writeFile(join(root, "auth.json"), JSON.stringify({ anthropic: { type: "oauth" } }), { mode: 0o600 });
		expect(store.summary("anthropic").state).toBe("invalid");
		// One malformed admitted entry invalidates the whole shared file: safe refusal, not partial reads.
		expect(store.summary("zai").state).toBe("invalid");
	});
});

describe("SDK provider admission with shared store", () => {
	it("catalogs and prefights openai-codex and zai routes against shared logins", async () => {
		const service = createSdkProviderService({ credentials: store });
		const codexCatalog = service.catalog("openai-codex");
		expect(codexCatalog.some((model) => model.id === "gpt-6-astra" && model.thinkingLevels.includes("xhigh"))).toBe(true);
		expect(service.catalog("zai").some((model) => model.id === "glm-5.3-flash" && model.thinkingLevels.includes("max"))).toBe(true);
		expect(service.preflight({ provider: "openai-codex", model: "gpt-6-astra", effort: "xhigh" }).ok).toBe(true);
		expect(service.preflight({ provider: "zai", model: "glm-5.3-flash", effort: "max" }).ok).toBe(true);
		expect(service.preflight({ provider: "openai-codex", model: "gpt-6-astra", effort: "sideways" }).ok).toBe(false);
		expect(service.preflight({ provider: "zai", model: "gpt-6-astra", effort: undefined }).ok).toBe(false);
		expect(service.preflight({ provider: "deepseek", model: "any", effort: undefined }).ok).toBe(false);
		await service.settle();
	});
	it("inventory exposes only admitted methods for new providers", async () => {
		const service = createSdkProviderService({ credentials: store });
		const inventory = service.inventory();
		const codex = inventory.find((row) => row.id === "openai-codex");
		expect(codex?.methods).toEqual([{ id: "oauth" as const, label: expect.stringContaining("ChatGPT"), subscription: true }]);
		expect(inventory.find((row) => row.id === "zai")?.methods.map((m) => m.id)).toEqual(["api_key"]);
		expect(inventory.some((row) => row.id === "deepseek")).toBe(false);
		await service.settle();
	});
});
