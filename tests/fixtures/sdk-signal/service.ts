import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createSdkProviderService } from "../../../src/sdk-provider-service.ts";
import { SdkCredentials } from "../../../src/sdk-credentials.ts";
import { startMock, synthetic } from "../../../scripts/sdk-proof/mock.mjs";

const directory = process.env.SDK_SIGNAL_DIRECTORY;
if (!directory) throw new Error("Missing synthetic fixture directory");
const mock = await startMock(); mock.state.oauthDelayMs = 1500;
const fetchOriginal = globalThis.fetch;
globalThis.fetch = async (input, init) => {
	const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
	if (url.href === "https://platform.claude.com/v1/oauth/token") {
		process.stderr.write("fixture-refresh-start\n");
		return fetchOriginal(`${mock.baseUrl}/oauth`, init);
	}
	if (url.origin !== mock.baseUrl) throw new Error("Fixture external request forbidden");
	return fetchOriginal(input, init);
};
const credentials = new SdkCredentials(join(directory, "accounts"));
await credentials.accountAction({ provider: "anthropic", expectedRevision: credentials.summary("anthropic").revision, receipt: { changed: false } },
	() => credentials.modify("anthropic", async () => ({ type: "oauth", access: synthetic.access, refresh: synthetic.refresh, expires: 0 })));
const provider = anthropicProvider();
const service = createSdkProviderService({ credentials, providers: [{ ...provider, getModels: () => provider.getModels().map(model => ({ ...model, baseUrl: mock.baseUrl })) }] });
const facade = { preflight: service.preflight.bind(service), call: service.call.bind(service), settle: async () => {
	await service.settle(); process.stderr.write("fixture-storage-drain\n");
	await delay(450);
	await writeFile(join(directory, "drained.json"), JSON.stringify({ oauthRequests: mock.state.oauthRequests, inferenceRequests: mock.state.requests.length, bytes: (await readFile(join(directory, "accounts/auth.json"))).length }));
	await mock.stop(); process.stderr.write("fixture-drained\n");
} };
/** Return synthetic isolated service; no production singleton/account touched. @returns Injected real service. */
export function getSdkProviderService() { return facade; }
