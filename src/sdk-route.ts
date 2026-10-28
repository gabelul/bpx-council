import type { SdkRoute } from "./sdk-types.js";

/** Check provider namespace without accepting paths or terminal controls. @param provider Provider ID. @returns Whether ID is safe. */
export function isSdkProviderId(provider: string): boolean {
	return /^[a-z][a-z0-9-]{0,63}$/.test(provider);
}

/** Parse an explicit SDK route; later colons and protected literal @ stay in model IDs.
 * @param spec sdk:provider[:model][@effort]. @returns Exact route, or throws a private shape error.
 */
export function parseSdkRoute(spec: string): SdkRoute {
	if (!spec.startsWith("sdk:")) throw new Error("SDK route must start with sdk:");
	const at = spec.lastIndexOf("@");
	const effort = at > 0 ? spec.slice(at + 1) || undefined : undefined;
	const rest = at > 0 ? spec.slice(0, at) : spec;
	const colon = rest.indexOf(":", 4);
	const provider = colon === -1 ? rest.slice(4) : rest.slice(4, colon);
	const model = colon === -1 ? undefined : rest.slice(colon + 1) || undefined;
	if (!isSdkProviderId(provider)) throw new Error("SDK provider ID is invalid");
	if (model !== undefined && /[\s\x00-\x1f\x7f-\x9f]/.test(model)) throw new Error("SDK model ID is invalid");
	if (effort !== undefined && !/^[a-z][a-z0-9-]{0,31}$/.test(effort)) throw new Error("SDK effort is invalid");
	return { provider, model, effort };
}

/** Serialize SDK pin, shielding literal @ model suffixes with empty terminal effort.
 * @param route Provider/model/effort. @returns Reversible seat spec.
 */
export function serializeSdkRoute(route: SdkRoute): string {
	return `sdk:${route.provider}${route.model ? `:${route.model}` : ""}${route.effort ? `@${route.effort}` : route.model?.includes("@") ? "@" : ""}`;
}

/** Reject host model conflicts instead of redirecting an explicit SDK route.
 * @param route Selected SDK route. @param env Host environment. @returns Safe conflict reason, or undefined.
 */
export function sdkAmbientModelError(route: SdkRoute, env: NodeJS.ProcessEnv = process.env): string | undefined {
	for (const model of [env.BPX_COUNCIL_MODEL, env.ANTHROPIC_MODEL]) {
		if (model && model !== route.model) return "Clear BPX_COUNCIL_MODEL/ANTHROPIC_MODEL: ambient model conflicts with the explicit SDK route.";
	}
	return undefined;
}
