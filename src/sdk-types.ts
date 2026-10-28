import type { BackendResult } from "./backend.js";

/** Council-facing SDK authentication methods; never inferred from installed CLIs. */
export type SdkAuthMethod = "api_key" | "oauth";

/** Safe authentication choice from an admitted provider implementation. */
export interface SdkAuthChoice {
	id: SdkAuthMethod;
	label: string;
	/** True only when SDK descriptor identifies a subscription login. */
	subscription?: boolean;
}

/** Local credential state, not evidence of provider authentication or inference. */
export interface SdkAccountSummary {
	state: "missing" | "stored" | "invalid";
	method?: SdkAuthMethod;
	/** Opaque account identity generation; refresh must not change it. Never display it. */
	revision: string;
	error?: string;
}

/** Public provider inventory contains no credentials, headers or SDK objects. */
export interface SdkProviderSummary {
	id: string;
	label: string;
	methods: SdkAuthChoice[];
	account: SdkAccountSummary;
}

/** Bundled chat-model metadata; catalog presence does not prove entitlement. */
export interface SdkModelSummary {
	id: string;
	label: string;
	thinkingLevels: string[];
}

/** Direct route identity, independent from a similarly named CLI or HTTP route. */
export interface SdkRoute {
	provider: string;
	model?: string;
	effort?: string;
}

/** Request bounds needed for local SDK adapter eligibility before paid calls. */
export interface SdkPreflightBounds {
	maxOutputTokens?: number;
}

/** Local-only result. Revision includes account changes, not token rotation. */
export interface SdkPreflight {
	ok: boolean;
	error?: string;
	revision: string;
}

/** OAuth URLs and progress belong to transient account UI, never config Review. */
export type SdkAuthEvent =
	| { type: "url"; url: string; instructions?: string }
	| { type: "progress"; message: string };

/** Prompt answers are passed directly to SDK; transient secrets never enter ConfigDraft. */
export interface SdkAuthPrompt {
	label: string;
	placeholder?: string;
	secret: boolean;
}

/** UI bridge to SDK-owned login flows. No browser launches or token extraction. */
export interface SdkAuthInteraction {
	/** Display transient login event. @param event Safe URL/instructions or progress. */
	onEvent(event: SdkAuthEvent): void;
	/** Request transient input. @param prompt Input metadata. @returns Answer, never config data. */
	prompt(prompt: SdkAuthPrompt): Promise<string>;
}

/** Persistent account action receipt, excluding raw credentials and SDK errors. */
export interface SdkAccountResult {
	ok: boolean;
	changed: boolean;
	cancelled?: boolean;
	error?: string;
	account: SdkAccountSummary;
}

/** One bounded, tool-free inference request. */
export interface SdkCallRequest extends SdkRoute {
	model: string;
	systemPrompt: string;
	userMessage: string;
	/** Transient confirmation generation; account changes require reconfirmation. */
	expectedRevision?: string;
	maxOutputTokens?: number;
	maxOutputBytes?: number;
	timeoutMs?: number;
}

/** Injectable boundary for direct providers, account UI and advisor transport. */
export interface SdkProviderService {
	/** Inspect local safe inventory, without network, refresh or writes. @returns Provider summaries. */
	inventory(): SdkProviderSummary[];
	/** Read bundled chat models. @param provider Provider ID. @returns Safe model metadata. */
	catalog(provider: string): SdkModelSummary[];
	/** Validate route/account locally. @param route Direct route. @param bounds Optional output budget. @returns Eligibility/revision. */
	preflight(route: SdkRoute, bounds?: SdkPreflightBounds): SdkPreflight;
	/** Store literal key in Council account storage. @returns Receipt after persistence/cleanup. */
	setApiKey(provider: string, key: string, signal: AbortSignal): Promise<SdkAccountResult>;
	/** Run admitted SDK login. @returns Receipt after SDK and storage cleanup. */
	authenticate(provider: string, method: SdkAuthMethod, interaction: SdkAuthInteraction, signal: AbortSignal): Promise<SdkAccountResult>;
	/** Remove local credential if account has not changed. @returns Receipt, not provider-side revocation. */
	logout(provider: string, expectedRevision: string, signal: AbortSignal): Promise<SdkAccountResult>;
	/** Execute exact tool-free route with retries disabled. @returns Result after operation-scoped cleanup. */
	call(request: SdkCallRequest, signal?: AbortSignal): Promise<BackendResult>;
	/** Await all owned SDK/storage work before CLI process exit. @returns Shutdown barrier. */
	settle(): Promise<void>;
}
