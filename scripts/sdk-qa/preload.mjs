import { registerHooks } from "node:module";
import { createRequire } from "node:module";

const fakeUrl = new URL("./fake-service.mjs", import.meta.url).href;
/** Replace only SDK service boundary for UI tests, never application components. */
registerHooks({
	/** Resolve fixture façade. @param {string} specifier Import. @param {object} context Resolution context. @param {Function} nextResolve Default resolution. @returns {object} Resolution. */
	resolve(specifier, context, nextResolve) {
		if (specifier === "./sdk-provider-service.js" || specifier.endsWith("/sdk-provider-service.js")) return { url: fakeUrl, shortCircuit: true };
		return nextResolve(specifier, context);
	},
});
const require = createRequire(import.meta.url);
for (const name of ["node:net", "node:tls", "node:http", "node:https"]) {
	const module = require(name);
	for (const key of ["connect", "createConnection", "request", "get"]) {
		if (typeof module[key] !== "function") continue;
		/** Reject all network in fake-account terminal tests. @returns {never} Guard failure. */
		module[key] = () => { throw new Error("Network forbidden in SDK UI fixture"); };
	}
}
/** Never perform provider requests in UI façade fixtures. @returns {Promise<never>} Guard failure. */
globalThis.fetch = async () => { throw new Error("Network forbidden in SDK UI fixture"); };
