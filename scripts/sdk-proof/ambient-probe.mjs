import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
const start = performance.now();
const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
const { InMemoryCredentialStore, InMemoryModelsStore } = await import('@earendil-works/pi-ai');
const requests = [];
const server = http.createServer((req, res) => {
  /** Collect only safe observations; never retain authorization headers. */
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    requests.push({ path: req.url, model: JSON.parse(text).model,
      ambientCredentialUsed: req.headers.authorization === `Bearer ${process.env.OPENAI_API_KEY}` });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock rejection', type: 'invalid_request_error' } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
  authPath: `${process.cwd()}/own/auth.json`, modelsPath: null,
  modelsStore: new InMemoryModelsStore(), allowModelNetwork: false });
const model = { ...runtime.getModel('openai', 'gpt-5-mini'),
  baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
const response = await runtime.completeSimple(model, {
  systemPrompt: 'Synthetic council persona', messages: [{ role: 'user', content: 'Offline fixture', timestamp: 1 }],
}, { reasoning: 'low', maxTokens: 16 });
await new Promise(resolve => server.close(resolve));
const result = { sdk: '1.1.0', missingOwnAuthRefused: requests.length === 0,
  requests, stopReason: response.stopReason, sentinelAccess: globalThis.sdkProofAudit.sentinelAccess,
  subprocessAttempts: globalThis.sdkProofAudit.subprocessAttempts,
  elapsedMs: Math.round(performance.now() - start) };
await writeFile('ambient-probe.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
