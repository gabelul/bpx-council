/** Redirect SDK singleton imports only in native fixture process. @param specifier Import. @param context Resolution context. @param nextResolve Next loader. @returns Module URL. */
export async function resolve(specifier, context, nextResolve) {
	if (/sdk-provider-service\.(?:js|ts)$/.test(specifier) && !context.parentURL?.includes("fixtures/sdk-signal/service.ts")) return { url: new URL("./service.ts", import.meta.url).href, shortCircuit: true };
	return nextResolve(specifier, context);
}
