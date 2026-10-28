import React from "react";
import { PassThrough } from "node:stream";
import { render, renderToString, type Key } from "ink";
import stringWidth from "string-width";
import stripAnsi from "strip-ansi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { configRoute } from "../src/config-editor.js";
import { ConfigDraft, modalChoices } from "../src/config-draft.js";
import { WorkbenchView, reviewRows, workbenchKey, wrapAccountText } from "../src/config-workbench.js";
import { WorkbenchSecretInput } from "../src/workbench-secret-input.js";
import type { SdkAccountResult, SdkAuthInteraction, SdkProviderService, SdkProviderSummary } from "../src/sdk-types.js";
import type { ConfigActions } from "../src/config-actions.js";

/** Advance only mocked async work. @returns Microtask completion. */
async function flush(): Promise<void> { for (let index = 0; index < 20; index++) await Promise.resolve(); }
/** Inert service: no HOME, provider, subprocess or network reads. @returns Controller and injectable fakes. */
function fixture(project = false) {
	const providers: SdkProviderSummary[] = [
		{ id: "openai", label: "OpenAI", methods: [{ id: "api_key", label: "API key" }], account: { state: "missing", revision: "v0" } },
		{ id: "anthropic", label: "Anthropic", methods: [{ id: "api_key", label: "API key" }, { id: "oauth", label: "Subscription login", subscription: true }], account: { state: "stored", method: "oauth", revision: "v1" } },
	];
	/** Return persistent local account receipt. @param index Provider row. @returns Safe result. */
	const saved = (index = 0): SdkAccountResult => { providers[index].account = { state: "stored", method: "api_key", revision: "v2" }; return { ok: true, changed: true, account: structuredClone(providers[index].account) }; };
	const service: SdkProviderService = {
		inventory: vi.fn(() => structuredClone(providers)), catalog: vi.fn(() => [{ id: "model-1", label: "Model 1", thinkingLevels: ["low", "high"] }]),
		preflight: vi.fn(route => ({ ok: !!route.model, revision: providers.find(provider => provider.id === route.provider)!.account.revision })),
		setApiKey: vi.fn(async () => saved()), authenticate: vi.fn(async () => saved(1)),
		logout: vi.fn(async (provider, revision) => { const row = providers.find(item => item.id === provider)!; return row.account.revision !== revision ? { ok: false, changed: false, error: "Account changed; reopen removal.", account: structuredClone(row.account) } : { ok: true, changed: true, account: { state: "missing", revision: "v3" } }; }),
		call: vi.fn(async () => ({ text: "Unused", model: "model-1" })), settle: vi.fn(async () => {}),
	};
	const actions: ConfigActions = { preflight: vi.fn((draft, target) => { const route = configRoute(draft, target) ?? draft.solo?.backend; return { route: "sdk:openai:model-1", ...(route?.type === "sdk" ? { revision: providers.find(provider => provider.id === route.provider)?.account.revision } : {}) }; }), test: vi.fn(async () => ({ ok: true, route: "sdk:openai:model-1", elapsedMs: 1, text: "Test response" })), generate: vi.fn(async () => ({ ok: false, route: "unused", elapsedMs: 0, text: "" })) };
	const diagnostics = { inventory: vi.fn(() => []), check: vi.fn(async () => []) };
	const discovery = { listModels: vi.fn(async () => []), listEfforts: vi.fn(async () => null) };
	const c = new ConfigDraft({}, { path: "/fixture/config.json", scope: project ? "project" : "explicit", project }, [], discovery, actions, diagnostics, service);
	return { c, service, providers, saved, actions, diagnostics, discovery };
}
/** Enter named controller action. @param c Draft. @param intent Row intent. */
function action(c: ConfigDraft, intent: string): void { c.pane = "detail"; c.move("first"); c.move(c.fields.findIndex(field => field.action === intent)); c.enter(); }
/** Explicitly open provider setup. @param c Draft. @param provider Provider index. */
async function open(c: ConfigDraft, provider = 0): Promise<void> { c.jump("Backends"); action(c, "direct-providers"); await flush(); c.move("first"); c.move(provider); c.enter(); }
/** Render terminal cells. @param c Controller. @param columns Width. @param rows Height. @returns Plain terminal frame. */
function frame(c: ConfigDraft, columns = 40, rows = 12): string { return stripAnsi(renderToString(React.createElement(WorkbenchView, { controller: c, size: { columns, rows } }), { columns })); }
/** Dispatch real controller keyboard semantics. @param c Controller. @param key Parsed Ink key. @param input Text key. */
function key(c: ConfigDraft, key: Partial<Key>, input = ""): void { workbenchKey(c, input, key as Key, { columns: 20, rows: 8 }); }

afterEach(() => { vi.unstubAllEnvs(); });

describe("direct account UI boundaries", () => {
	it("startup has no SDK inventory or model/auth network work; keeps eight sections", () => {
		const { c, service, discovery } = fixture(); frame(c);
		expect(service.inventory).not.toHaveBeenCalled(); expect(service.catalog).not.toHaveBeenCalled(); expect(service.authenticate).not.toHaveBeenCalled(); expect(service.call).not.toHaveBeenCalled(); expect(discovery.listModels).not.toHaveBeenCalled();
		c.jump("Backends"); expect(c.fields.slice(0, 2).map(field => field.label)).toEqual(["Direct providers", "Installed CLIs"]);
	});
	it("default picker never resolves real account storage; SDK seats excluded from CLI diagnostics", async () => {
		const { diagnostics, actions, discovery } = fixture();
		const c = new ConfigDraft({ solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } } }, { path: "/fixture/config.json", scope: "explicit" }, [], discovery, actions, diagnostics);
		expect(diagnostics.inventory).toHaveBeenCalledWith([]); c.jump("Advisor"); c.edit(c.fields[0]); await flush();
		expect(c.account).toBeUndefined(); expect(c.sdkProviders).toEqual([]); expect(c.modal?.choices.some(choice => choice.setup)).toBe(true); expect(c.modal?.notice).not.toContain("unavailable");
	});
	it("project setup articulates Global settings without touching service", async () => {
		const { c, service } = fixture(true); c.jump("Backends"); action(c, "direct-providers"); await flush();
		expect(c.error).toContain("Global settings"); expect(service.inventory).not.toHaveBeenCalled(); expect(c.account).toBeUndefined();
		c.jump("Advisor"); c.edit(c.fields[0]); expect(c.modal?.choices.some(choice => choice.setup || choice.value?.startsWith("sdk:"))).toBe(false);
	});
	it("save account then restore exact picker seat/search/highlight; no route mutation or auto-save", async () => {
		const { c, service } = fixture(); c.jump("Council"); c.enter(); c.edit(c.fields[0]); await flush();
		const modal = c.modal!; c.text("direct"); modal.index = modalChoices(modal).findIndex(choice => choice.setup);
		const before = { draft: JSON.stringify(c.draft), screen: c.screen, section: c.section, query: modal.text, index: modal.index };
		c.choose(); await flush(); expect(c.screen.type).toBe("direct-providers"); c.enter(); c.account!.enter();
		expect(c.account?.view?.phase).toBe("key"); c.account!.submit("fixture-key-not-real"); await flush();
		expect(service.setApiKey).toHaveBeenCalledTimes(1); expect(c.account?.view?.receipt?.changed).toBe(true); expect(c.result).toBeUndefined(); expect(c.dirty).toBe(false);
		expect(JSON.stringify(c)).not.toContain("fixture-key-not-real"); expect(JSON.stringify(reviewRows(c))).not.toContain("fixture-key-not-real");
		c.account!.enter(); await flush(); expect(c.modal).toBe(modal); expect(c.modal!.text).toBe(before.query); expect(modalChoices(c.modal!)[c.modal!.index].setup).toBe(true);
		expect(c.screen).toBe(before.screen); expect(c.section).toBe(before.section); expect(JSON.stringify(c.draft)).toBe(before.draft);
		expect(c.modal!.choices.some(choice => choice.value === "sdk:openai")).toBe(true);
		// Separate explicit route and model selection, even with no installed CLIs.
		c.text(""); c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.value === "sdk:openai"); c.choose();
		expect(c.dirty).toBe(true); expect(configRoute(c.draft, { section: "council", role: "architect", member: true })).toEqual({ type: "sdk", provider: "openai" });
		c.edit(c.fields[1]); await flush(); c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.value === "model-1"); c.choose();
		expect(configRoute(c.draft, { section: "council", role: "architect", member: true })?.model).toBe("model-1"); expect(c.result).toBeUndefined();
	});
	it("new user with no CLIs saves explicit SDK Advisor and model only after route selections", async () => {
		const { c, service } = fixture(); c.jump("Advisor"); c.edit(c.fields[0]); await flush();
		c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.setup); c.choose(); await flush(); c.enter(); c.account!.enter(); c.account!.submit("fixture-key-not-real"); await flush();
		expect(c.draft).toEqual({}); expect(c.result).toBeUndefined(); c.account!.enter(); await flush();
		c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.value === "sdk:openai"); c.choose(); expect(c.draft.solo?.backend).toEqual({ type: "sdk", provider: "openai" });
		c.edit(c.fields[1]); await flush(); c.modal!.index = modalChoices(c.modal!).findIndex(choice => choice.value === "model-1"); c.choose();
		c.jump("Review"); c.move(1); c.enter(); expect(c.confirmation?.type).toBe("save"); expect(c.confirmation?.index).toBe(0); c.move(1); c.enter();
		expect(c.result?.config?.solo?.backend).toEqual({ type: "sdk", provider: "openai", model: "model-1" }); expect(service.call).not.toHaveBeenCalled();
	});
	it("cancelled setup never saves and captured field Enter cannot execute parent action", async () => {
		const { c, service } = fixture(); await open(c); c.account!.enter();
		const view = c.account!.view!; const captured = { view, phase: view.phase, prompt: view.prompt };
		c.account!.cancel(); workbenchKey(c, "", { return: true } as Key, { columns: 40, rows: 12 }, undefined, captured);
		expect(c.account?.view).toBeUndefined(); expect(service.setApiKey).not.toHaveBeenCalled(); expect(c.draft).toEqual({}); expect(c.result).toBeUndefined();
	});
	it("facade is opaque even if injected service has cached SDK credentials", async () => {
		const { c, service } = fixture(); Object.assign(service, { sdkCache: { credential: "never-serialize-fixture" } }); await open(c);
		expect(JSON.stringify(c)).not.toContain("never-serialize-fixture"); expect(JSON.stringify(c.account)).not.toContain("never-serialize-fixture");
	});
	it("offers only admitted methods; CLI identity cannot imply SDK login", async () => {
		const { c, service } = fixture(); await open(c); expect(c.account!.choices.map(choice => choice.method).filter(Boolean)).toEqual(["api_key"]);
		expect(frame(c, 80, 24)).toContain("CLI logins are separate"); expect(service.authenticate).not.toHaveBeenCalled();
	});
	it("logout opens Cancel first; changed external revision cannot remove newer account", async () => {
		const { c, service, providers } = fixture(); await open(c, 1); c.account!.move(2); c.account!.enter();
		expect(c.account!.view!.phase).toBe("logout"); expect(c.account!.view!.index).toBe(0); c.account!.enter(); expect(service.logout).not.toHaveBeenCalled();
		c.account!.move(2); c.account!.enter(); providers[1].account.revision = "external-change"; c.account!.move(1); c.account!.enter(); await flush();
		expect(service.logout).toHaveBeenCalledWith("anthropic", "v1", expect.any(AbortSignal)); expect(c.account!.view!.receipt?.changed).toBe(false); expect(c.account!.view!.receipt?.error).toContain("changed");
	});
	it("account revision invalidates old route test receipts and frozen confirmation", async () => {
		const { c, saved } = fixture(); c.draft = { solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } } };
		const target = { section: "advisor" as const, role: "Advisor" }; const fingerprint = c.routeFingerprint(target);
		c.testResults = [{ target, fingerprint, result: { ok: true, elapsedMs: 1, text: "response", route: "sdk:openai:model-1" } }];
		await open(c); c.account!.enter(); c.account!.submit("fixture-key-not-real"); await flush();
		expect(c.testResults).toHaveLength(0); expect(c.routeFingerprint(target)).not.toBe(fingerprint); saved();
	});
	it("external account change invalidates frozen cost consent before first paid call", async () => {
		const { c, providers, actions } = fixture(); c.draft = { solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } } };
		c.jump("Advisor"); action(c, "test"); expect(c.confirmation?.type).toBe("cost"); providers[0].account.revision = "external-change";
		c.move(1); c.enter(); await flush(); expect(actions.test).not.toHaveBeenCalled(); expect(c.error).toContain("changed since confirmation");
	});
	it("passes original cost revision after final UI check; late account change blocks transport and drops receipt", async () => {
		const { c, providers, actions, service } = fixture(); c.draft = { solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } } };
		const target = { section: "advisor" as const, role: "Advisor" };
		actions.test = vi.fn(async (draft, seat, signal, context) => {
			const fresh = actions.preflight(draft, seat);
			if (fresh.revision !== context?.sdkAccountRevision) return { ok: false, route: fresh.route, elapsedMs: 0, text: "", error: "SDK account changed; confirm again." };
			await service.call({ provider: "openai", model: "model-1", systemPrompt: "Probe", userMessage: "OK", expectedRevision: context?.sdkAccountRevision }, signal);
			return { ok: true, route: fresh.route, elapsedMs: 0, text: "Response" };
		});
		c.jump("Advisor"); action(c, "test"); const request = c.confirmation!.request!;
		expect(request.sdkAccountRevisions).toEqual({ [JSON.stringify(target)]: "v0" });
		const unsubscribe = c.subscribe(() => { if (c.operation?.rows?.[0].status === "Testing") providers[0].account.revision = "changed-after-ui-check"; });
		c.move(1); c.enter(); await flush(); unsubscribe();
		expect(actions.test).toHaveBeenCalledWith(request.draft, target, expect.any(AbortSignal), { sdkAccountRevision: "v0" });
		expect(request.sdkAccountRevisions).toEqual({ [JSON.stringify(target)]: "v0" }); expect(service.call).not.toHaveBeenCalled();
		expect(c.testResults).toHaveLength(0); expect(c.error).toContain("Confirm again"); expect(providers[0].account.revision).toBe("changed-after-ui-check");
	});
	it("batch consent keeps independent original SDK generations for each seat", async () => {
		const { c, actions } = fixture(); c.draft = { solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } }, council: { members: ["architect", "critic"], backends: { architect: "sdk:anthropic:model-1", critic: "sdk:openai:model-1" } } };
		c.jump("Council"); action(c, "test-all"); const request = c.confirmation!.request!; expect(Object.isFrozen(request.sdkAccountRevisions)).toBe(true);
		c.move(1); c.enter(); await flush(); expect(actions.test).toHaveBeenCalledTimes(2);
		expect(vi.mocked(actions.test).mock.calls.map(call => [call[1].role, call[3]])).toEqual([["architect", { sdkAccountRevision: "v1" }], ["critic", { sdkAccountRevision: "v0" }]]);
	});
	it("generation receives original cost revision as fifth argument and rejects stale candidate", async () => {
		const { c, providers, actions } = fixture(); c.draft = { solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } } }; c.generationFocus = "Code reviewer";
		actions.generate = vi.fn(async () => { providers[0].account.revision = "late-generation-change"; return { ok: true, route: "sdk:openai:model-1", elapsedMs: 1, text: "", candidate: { name: "reader", stance: "neutral", systemPrompt: "Read code." } }; });
		c.jump("Council"); action(c, "add"); action(c, "ai"); action(c, "generate"); const request = c.confirmation!.request!;
		c.move(1); c.enter(); await flush();
		expect(actions.generate).toHaveBeenCalledWith(request.draft, c.generatorTarget, "Code reviewer", expect.any(AbortSignal), { sdkAccountRevision: "v0" });
		expect(c.candidate).toBeUndefined(); expect(c.error).toContain("stale candidate ignored"); expect(request.sdkAccountRevisions?.[JSON.stringify(c.generatorTarget)]).toBe("v0");
	});
	it("legacy actions keep original argument count when preflight has no SDK revision", async () => {
		const { c, actions } = fixture(); c.draft = { solo: { backend: { type: "cli", command: "claude", model: "model-1" } } };
		c.jump("Advisor"); action(c, "test"); c.move(1); c.enter(); await flush(); expect(vi.mocked(actions.test).mock.calls[0]).toHaveLength(3);
		c.generationFocus = "Code reviewer"; c.jump("Council"); action(c, "add"); action(c, "ai"); action(c, "generate"); c.move(1); c.enter(); await flush();
		expect(vi.mocked(actions.generate).mock.calls[0]).toHaveLength(4);
	});
	it("model clear is explicit, blocks running rather than silently selecting SDK default", async () => {
		const { c, actions } = fixture(); c.draft = { solo: { backend: { type: "sdk", provider: "openai", model: "model-1" } } }; c.jump("Advisor"); c.edit(c.fields[1]); await flush();
		expect(c.modal!.choices[0].label).toContain("choose model before running"); c.modal!.index = 0; c.choose(); action(c, "test");
		expect(c.confirmation).toBeUndefined(); expect(c.testResults[0].result.error).toContain("explicit direct provider model"); expect(actions.test).not.toHaveBeenCalled();
	});
});

describe("transient OAuth and cleanup", () => {
	it("manual URL fully reachable by Page at 40x12 and 20x8; callbacks stay out of draft", async () => {
		const { c, service } = fixture(); let interaction!: SdkAuthInteraction;
		service.authenticate = vi.fn(async (_provider, _method, bridge, signal) => {
			interaction = bridge; bridge.onEvent({ type: "url", url: "https://fixture.invalid/oauth/" + "abcdef".repeat(18), instructions: "Copy callback answer after login." });
			await bridge.prompt({ label: "Callback answer", secret: true });
			return { ok: false, changed: false, cancelled: signal.aborted, account: { state: "stored", revision: "v1" } };
		});
		await open(c, 1); c.account!.move(1); c.account!.enter(); await flush();
		vi.stubEnv("NO_COLOR", "1"); vi.stubEnv("FORCE_COLOR", "3");
		for (const [columns, rows] of [[40, 12], [20, 8]]) {
			let seen = ""; for (let page = 0; page < 20; page++) { c.account!.view!.page = page; const rendered = frame(c, columns, rows); seen += rendered; expect(rendered.split("\n").length).toBeLessThanOrEqual(rows); for (const line of rendered.split("\n")) expect(stringWidth(line)).toBeLessThanOrEqual(columns); }
			expect(seen).toContain("https://fixture"); expect(seen).toContain("Copy callback"); expect(seen).not.toContain("CONFIG WORKBENCH");
		}
		expect(interaction).toBeDefined(); for (let index = 0; index < 20; index++) key(c, { pageDown: true }); const lastPage = c.account!.view!.page; key(c, { pageUp: true }); expect(c.account!.view!.page).toBe(lastPage - 1); c.account!.view!.page = 2; interaction.onEvent({ type: "progress", message: "Polling" }); interaction.onEvent({ type: "progress", message: "Still polling" }); expect(c.account!.view!.page).toBe(2); expect(c.account!.view!.events.filter(event => event.type === "progress")).toHaveLength(1); c.account!.submit("fixture-callback-not-real"); await flush();
		expect(JSON.stringify(c)).not.toContain("fixture-callback-not-real"); expect(JSON.stringify(c.draft)).not.toContain("oauth");
	});
	it("Esc aborts unanswered OAuth callback and traps shortcuts until polling/storage barrier settles; Ctrl-C returns 130", async () => {
		const { c, service } = fixture(); let cleanup!: () => void; let promptRejected = false; let removeListener!: ReturnType<typeof vi.spyOn>;
		service.authenticate = vi.fn(async (_provider, _method, bridge, signal) => {
			removeListener = vi.spyOn(signal, "removeEventListener");
			try { await bridge.prompt({ label: "Code", secret: true }); } catch { promptRejected = true; }
			await new Promise<void>(resolve => { cleanup = resolve; });
			return { ok: false, changed: false, cancelled: signal.aborted, account: { state: "stored", revision: "v1" } };
		});
		await open(c, 1); c.account!.move(1); c.account!.enter(); await flush(); const before = c.screen;
		for (const input of ["1", "7", "s"]) key(c, {}, input); key(c, { tab: true }); key(c, { return: true }); key(c, { rightArrow: true }); expect(c.screen).toBe(before);
		key(c, { escape: true }); await flush(); expect(promptRejected).toBe(true); expect(removeListener).toHaveBeenCalledWith("abort", expect.any(Function)); expect(c.account!.view!.busy).toBe(true); expect(c.result).toBeUndefined();
		key(c, { ctrl: true }, "c"); await flush(); expect(c.result).toBeUndefined(); cleanup(); await flush(); expect(c.result).toEqual({ config: null, code: 130 }); await c.settle(); expect(service.settle).toHaveBeenCalled();
	});
	it("Ctrl-C waits service-global SDK/storage barrier even after action returns", async () => {
		const { c, service, saved } = fixture(); let release!: () => void;
		service.settle = vi.fn(() => new Promise<void>(resolve => { release = resolve; }));
		await open(c); c.account!.enter(); c.account!.submit("fixture-key-not-real"); await flush(); c.interrupt(true);
		expect(c.account!.view!.busy).toBe(true); expect(c.result).toBeUndefined(); release(); await flush(); expect(c.result).toEqual({ config: null, code: 130 });
		service.settle = vi.fn(async () => {}); saved(); await c.settle();
	});
	it("cancellation after persistence reports saved change, never fictional rollback", async () => {
		const { c, service, saved } = fixture(); let complete!: () => void;
		service.setApiKey = vi.fn(async () => { await new Promise<void>(resolve => { complete = resolve; }); return { ...saved(), cancelled: true }; });
		await open(c); c.account!.enter(); c.account!.submit("fixture-key-not-real"); c.account!.submit("fixture-key-not-real"); expect(service.setApiKey).toHaveBeenCalledTimes(1); c.account!.cancel(); complete(); await flush();
		expect(frame(c, 80, 24)).toContain("Account change saved."); expect(frame(c, 80, 24)).toContain("no rollback"); expect(c.dirty).toBe(false);
	});
});

describe("private terminal input", () => {
	it("masks first character, paste, caret/delete, resize; submission clears and no raw key leaks", async () => {
		const stdout = Object.assign(new PassThrough(), { columns: 40, rows: 12, isTTY: true });
		const stdin = Object.assign(new PassThrough(), { isTTY: true, setRawMode: vi.fn(), ref: vi.fn(), unref: vi.fn() }); let output = "";
		stdout.on("data", chunk => { output += chunk.toString(); }); const submit = vi.fn();
		const app = render(React.createElement(WorkbenchSecretInput, { width: 12, onSubmit: submit }), { stdout, stdin, stderr: stdout, exitOnCtrlC: false, patchConsole: false });
		try {
			await new Promise(resolve => setTimeout(resolve, 40)); stdin.write("p"); await new Promise(resolve => setTimeout(resolve, 30)); expect(stripAnsi(output)).toContain("*"); expect(stripAnsi(output)).not.toContain("p"); stdin.write("rivate-paste"); await new Promise(resolve => setTimeout(resolve, 40));
			expect(stripAnsi(output)).toContain("*"); expect(output).not.toContain("private");
			stdin.write("\u001b[D"); await new Promise(resolve => setTimeout(resolve, 20)); stdin.write("\u001b[3~"); await new Promise(resolve => setTimeout(resolve, 20));
			app.rerender(React.createElement(WorkbenchSecretInput, { width: 3, onSubmit: submit })); await new Promise(resolve => setTimeout(resolve, 30)); stdin.write("\r"); await new Promise(resolve => setTimeout(resolve, 30));
			expect(submit).toHaveBeenCalledWith("private-past"); expect(output).not.toContain("private");
		} finally { app.unmount(); }
	});
	it("wraps complete Unicode text, not stored-value truncation", () => { const text = "https://fixture.invalid/界界/long-url"; const lines = wrapAccountText(text, 8); expect(lines.join("")).toBe(text); for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(8); });
});
