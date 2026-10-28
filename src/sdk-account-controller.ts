import type { SdkAccountResult, SdkAuthEvent, SdkAuthMethod, SdkAuthPrompt, SdkProviderService, SdkProviderSummary } from "./sdk-types.js";

/** Transient account dialog, separate from route drafts and config Review. */
export interface SdkAccountView {
	provider: SdkProviderSummary;
	phase: "methods" | "key" | "login" | "logout" | "receipt";
	index: number;
	page: number;
	busy: boolean;
	cancelling: boolean;
	prompt?: SdkAuthPrompt;
	events: SdkAuthEvent[];
	receipt?: SdkAccountResult;
}

/** Own account interaction and SDK cleanup; never retain keys or callback answers. */
export class SdkAccountController {
	view?: SdkAccountView;
	#service: SdkProviderService;
	private abort?: AbortController;
	private pending?: Promise<void>;
	private answer?: { resolve(value: string): void; reject(error: Error): void };
	private afterCleanup?: () => void;

	/** @param service Council-owned provider boundary. @param changed Repaint/invalidate receipts. @param closed Restore originating focus. */
	constructor(service: SdkProviderService, private readonly changed: () => void, private readonly closed: () => void) { this.#service = service; }

	/** Open safe account metadata only. @param provider Explicit selected inventory row. */
	open(provider: SdkProviderSummary): void {
		if (this.view?.busy) return;
		this.view = { provider: structuredClone(provider), phase: "methods", index: 0, page: 0, busy: false, cancelling: false, events: [] };
		this.changed();
	}
	/** List only admitted login methods, plus guarded local removal. @returns Account actions. */
	get choices(): { label: string; method?: SdkAuthMethod; logout?: boolean }[] {
		const view = this.view;
		if (!view) return [];
		if (view.phase === "logout") return [{ label: "Cancel" }, { label: "Remove local account", logout: true }];
		return [...view.provider.methods.map(method => ({ label: method.label, method: method.id })), ...(view.provider.account.state !== "missing" ? [{ label: "Remove local account", logout: true }] : []), { label: "Back" }];
	}
	/** Move selection without invoking an account action. @param offset List offset. */
	move(offset: number): void {
		if (!this.view || this.view.busy) return;
		this.view.index = Math.max(0, Math.min(this.choices.length - 1, this.view.index + offset)); this.changed();
	}
	/** Select explicit action; logout always opens with Cancel selected. */
	enter(): void {
		const view = this.view;
		if (!view || view.busy) return;
		if (view.phase === "receipt") { this.close(); return; }
		if (view.phase === "key") return;
		const choice = this.choices[view.index];
		if (view.phase === "logout") {
			if (!choice?.logout) { view.phase = "methods"; view.index = 0; this.changed(); return; }
			const revision = view.provider.account.revision;
			this.run(signal => this.#service.logout(view.provider.id, revision, signal)); return;
		}
		if (choice?.logout) { view.phase = "logout"; view.index = 0; this.changed(); }
		else if (choice?.method === "api_key") { view.phase = "key"; view.page = 0; this.changed(); }
		else if (choice?.method) {
			const method = choice.method;
			view.phase = "login";
			this.run(signal => this.#service.authenticate(view.provider.id, method, {
				onEvent: event => { if (this.view === view && !signal.aborted) { if (event.type === "progress") view.events = view.events.filter(item => item.type !== "progress"); view.events.push(event.type === "url" ? { type: "url", url: event.url, instructions: event.instructions } : { type: "progress", message: event.message }); this.changed(); } },
				prompt: prompt => this.prompt(prompt, signal),
			}, signal));
		} else this.close();
	}
	/** Pass literal input straight to service or pending callback, never controller state. @param value Transient input. */
	submit(value: string): void {
		const view = this.view;
		if (!view || view.cancelling) return;
		if (this.answer) { const answer = this.answer; this.answer = undefined; view.prompt = undefined; answer.resolve(value); this.changed(); }
		else if (view.phase === "key" && !view.busy && value.length) this.run(signal => this.#service.setApiKey(view.provider.id, value, signal));
	}
	/** Bridge provider prompt without keeping SDK objects or secrets. @param prompt Safe prompt metadata. @param signal Owned cancellation. @returns Transient answer. */
	private prompt(prompt: SdkAuthPrompt, signal: AbortSignal): Promise<string> {
		if (signal.aborted || !this.view) return Promise.reject(new Error("Cancelled"));
		this.view.prompt = { label: prompt.label, placeholder: prompt.placeholder, secret: prompt.secret };
		this.changed();
		return new Promise((resolve, reject) => {
			/** Remove abort listener on either answer or rejection. */
			const cleanup = (): void => signal.removeEventListener("abort", cancel);
			/** Reject unanswered callback immediately; service still owns its cleanup barrier. */
			const cancel = (): void => { this.answer = undefined; if (this.view) this.view.prompt = undefined; cleanup(); reject(new Error("Cancelled")); };
			this.answer = { resolve: value => { cleanup(); resolve(value); }, reject: error => { cleanup(); reject(error); } };
			signal.addEventListener("abort", cancel, { once: true });
		});
	}
	/** Track persistence and cleanup before publishing honest account receipt. @param action Explicit account operation. */
	private run(action: (signal: AbortSignal) => Promise<SdkAccountResult>): void {
		const view = this.view!;
		this.abort = new AbortController(); const signal = this.abort.signal;
		view.busy = true; view.cancelling = false; view.events = []; this.changed();
		/** Await service barrier even when operation throws or cancellation races persistence. */
		const execute = async (): Promise<void> => {
			let receipt: SdkAccountResult;
			try { receipt = await action(signal); }
			catch { receipt = { ok: false, changed: false, cancelled: signal.aborted, error: signal.aborted ? "Cancelled" : "Account operation failed; provider details withheld.", account: view.provider.account }; }
			try { await this.#service.settle(); }
			catch { receipt = { ...receipt, ok: false, error: "Account cleanup could not be confirmed." }; }
			this.answer?.reject(new Error("Cancelled")); this.answer = undefined;
			view.prompt = undefined; view.events = []; view.receipt = structuredClone(receipt);
			view.provider.account = structuredClone(receipt.account); view.phase = "receipt"; view.page = 0; view.busy = false; view.cancelling = false;
			this.abort = undefined; this.changed();
			const after = this.afterCleanup; this.afterCleanup = undefined; after?.();
		};
		this.pending = execute();
	}
	/** Cancel current login; callers may request exit only after cleanup. @param after Callback after barrier. */
	cancel(after?: () => void): void {
		if (!this.view?.busy) { this.close(); after?.(); return; }
		this.afterCleanup = after; this.view.cancelling = true; this.abort?.abort(); this.changed();
	}
	/** Clear transient account UI and restore originating focus. */
	close(): void { if (this.view?.busy) { this.cancel(); return; } this.view = undefined; this.closed(); this.changed(); }
	/** Await owned work before process exit. @returns SDK/storage cleanup completion. */
	async settle(): Promise<void> { if (this.view?.busy) this.cancel(); await this.pending; await this.#service.settle(); }
}
