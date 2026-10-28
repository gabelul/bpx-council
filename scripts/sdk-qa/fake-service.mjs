import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";

const directory = join(homedir(), ".bpx-sdk-ui-fixture");
const file = join(directory, "accounts.json");
const pending = new Set();

/** Read synthetic accounts only. @returns {Record<string, object>} Fixture map. */
function accounts() {
	try { return JSON.parse(readFileSync(file, "utf8")); }
	catch (error) { if (error.code === "ENOENT") return {}; throw error; }
}
/** Persist fixture accounts without touching routing config. @param {object} value Synthetic accounts. */
function persist(value) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
}
/** Record safe operation metadata, never secret input. @param {object} event Fixture event. */
function record(event) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const log = join(directory, "operations.jsonl");
	let previous = "";
	try { previous = readFileSync(log, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
	writeFileSync(log, `${previous}${JSON.stringify(event)}\n`, { mode: 0o600 });
}
/** Return secret-free account state. @param {string} provider Provider ID. @returns {object} Summary. */
function summary(provider) {
	const value = accounts()[provider];
	return value ? { state: "stored", method: value.method, revision: value.revision } : { state: "missing", revision: "missing" };
}
/** Track whole fixture operation for exit cleanup. @param {Function} task Operation. @returns {Promise<object>} Result. */
function track(task) {
	const promise = Promise.resolve().then(task);
	pending.add(promise);
	promise.then(() => pending.delete(promise), () => pending.delete(promise));
	return promise;
}
/** Wait for observable cancellation cleanup. @returns {Promise<void>} Delay. */
function cleanup() { return new Promise(resolve => setTimeout(resolve, 180)); }
/** Consume SDK-shaped prompt while owning cancellation. @param {object} interaction UI bridge. @param {AbortSignal} signal Signal. @returns {Promise<string>} Code. */
function askCode(interaction, signal) {
	return new Promise((resolve, reject) => {
		/** Reject pending interaction once. */
		const abort = () => reject(new Error("Fixture cancelled"));
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		Promise.resolve(interaction.prompt({ label: "Paste OAuth code", secret: true })).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
	});
}

const service = {
	/** Read fixture provider/account inventory. @returns {object[]} Summaries. */
	inventory() {
		return [
			{ id: "openai", label: "OpenAI", methods: [{ id: "api_key", label: "API key" }], account: summary("openai") },
			{ id: "anthropic", label: "Anthropic", methods: [{ id: "api_key", label: "API key" }, { id: "oauth", label: "Claude subscription", subscription: true }], account: summary("anthropic") },
		];
	},
	/** Return static synthetic chat models. @param {string} provider Provider ID. @returns {object[]} Models. */
	catalog(provider) {
		return [{ id: provider === "openai" ? "gpt-sdk-fixture" : "claude-sdk-fixture", label: "Fixture model", thinkingLevels: ["off", "low", "high"] }];
	},
	/** Validate exact fixture route without calls. @param {object} route Requested route. @returns {object} Eligibility. */
	preflight(route) {
		const account = summary(route.provider);
		const error = account.state !== "stored" ? "Configure a Council direct-provider account first" : !route.model ? "Choose a direct-provider model" : undefined;
		return { ok: !error, ...(error ? { error } : {}), revision: account.revision };
	},
	/** Store transient synthetic key. @param {string} provider Provider ID. @param {string} key Key. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Receipt. */
	setApiKey(provider, key, signal) {
		return track(async () => {
			if (signal.aborted) { await cleanup(); return { ok: false, changed: false, cancelled: true, account: summary(provider) }; }
			const all = accounts(); all[provider] = { method: "api_key", key, revision: randomUUID() }; persist(all);
			record({ type: "save-key", provider });
			return { ok: true, changed: true, account: summary(provider) };
		});
	},
	/** Run callback-shaped OAuth fixture, without browser or network. @param {string} provider Provider ID. @param {string} method Method. @param {object} interaction UI callbacks. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Receipt. */
	authenticate(provider, method, interaction, signal) {
		return track(async () => {
			record({ type: "login-start", provider, method });
			interaction.onEvent({ type: "url", url: "http://127.0.0.1:9/fixture-login?state=fixture-only", instructions: "Open URL manually, then paste fixture code" });
			try {
				const code = await askCode(interaction, signal);
				signal.throwIfAborted();
				if (!code) throw new Error("Fixture code required");
				const all = accounts(); all[provider] = { method: "oauth", revision: randomUUID() }; persist(all);
				record({ type: "login-saved", provider });
				return { ok: true, changed: true, account: summary(provider) };
			} catch {
				await cleanup(); record({ type: "login-cleanup", provider });
				return { ok: false, changed: false, cancelled: signal.aborted, error: signal.aborted ? "Login cancelled" : "Fixture login failed", account: summary(provider) };
			}
		});
	},
	/** Remove matching fixture account only. @param {string} provider Provider ID. @param {string} revision Confirmed account identity. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Receipt. */
	logout(provider, revision, signal) {
		return track(async () => {
			if (signal.aborted) return { ok: false, changed: false, cancelled: true, account: summary(provider) };
			if (summary(provider).revision !== revision) return { ok: false, changed: false, error: "Account changed; confirm again", account: summary(provider) };
			const all = accounts(); delete all[provider]; persist(all); record({ type: "logout", provider });
			return { ok: true, changed: true, account: summary(provider) };
		});
	},
	/** Return one synthetic answer after explicit caller confirmation. @param {object} request Exact request. @param {AbortSignal} signal Cancellation. @returns {Promise<object>} Backend result. */
	call(request, signal) {
		return track(async () => {
			if (signal?.aborted) { await cleanup(); return { ok: false, text: "", error: "Advisor call cancelled" }; }
			const ready = service.preflight(request);
			if (!ready.ok) return { ok: false, text: "", error: ready.error };
			record({ type: "call", provider: request.provider, model: request.model, effort: request.effort });
			return { ok: true, text: "SDK fixture answer", usage: { inputTokens: 1, outputTokens: 2 } };
		});
	},
	/** Await all fake operations before process exit. @returns {Promise<void>} Cleanup barrier. */
	async settle() { while (pending.size) await Promise.allSettled([...pending]); },
};

/** Provide injected test façade. @returns {object} Synthetic SDK service. */
export function getSdkProviderService() { return service; }
/** Provide same façade for test constructors. @returns {object} Synthetic SDK service. */
export function createSdkProviderService() { return service; }
