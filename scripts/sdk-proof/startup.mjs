import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { LockedCredentials, OwnModelsStore } from './storage.mjs';
const start = performance.now();
const options = { credentials: new LockedCredentials(`${process.cwd()}/startup-own`), modelsStore: new OwnModelsStore() };
if (process.env.PROOF_STARTUP === 'ModelRuntime') {
  const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
  await ModelRuntime.create({ ...options, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
} else {
  const { createModels } = await import('@earendil-works/pi-ai/models');
  const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai');
  const models = createModels({ ...options, authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(openaiProvider());
}
await writeFile(process.env.PROOF_RESULT, JSON.stringify({ elapsedMs: performance.now() - start,
  rssBytes: process.memoryUsage().rss, sentinelReads: globalThis.sdkProofAudit.sentinelAccess.length }));
