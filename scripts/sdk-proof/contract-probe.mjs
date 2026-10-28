import http from 'node:http';
import { writeFile } from 'node:fs/promises';
import { createModels } from '@earendil-works/pi-ai/models';
import { InMemoryCredentialStore, InMemoryModelsStore } from '@earendil-works/pi-ai';
import { openaiProvider } from '@earendil-works/pi-ai/providers/openai';
import { builtinProviders } from '@earendil-works/pi-ai/providers/all';
const credentials = new InMemoryCredentialStore();
const models = createModels({ credentials, modelsStore: new InMemoryModelsStore(),
  authContext: { env: async () => undefined, fileExists: async () => false } });
models.setProvider(openaiProvider());
const requests = [];
const server = http.createServer((req, res) => {
  let text = '';
  req.on('data', chunk => { text += chunk; });
  req.on('end', () => {
    const payload = JSON.parse(text);
    requests.push({ path: req.url, model: payload.model, reasoning: payload.reasoning,
      ownCredentialUsed: req.headers.authorization === 'Bearer synthetic-own-key',
      personaPresent: JSON.stringify(payload).includes('Synthetic council persona'),
      tools: payload.tools?.length ?? 0, maxOutputTokens: payload.max_output_tokens });
    res.writeHead(400, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'mock rejection', type: 'invalid_request_error' } }));
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const model = { ...models.getModel('openai', 'gpt-5-mini'),
  baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
const context = { systemPrompt: 'Synthetic council persona', messages: [{ role: 'user', content: 'Offline fixture', timestamp: 1 }] };
const missing = await models.completeSimple(model, context, { reasoning: 'low', maxTokens: 16 });
const missingOwnAuthRefused = requests.length === 0 && missing.stopReason === 'error';
await credentials.modify('openai', async () => ({ type: 'api_key', key: 'synthetic-own-key' }));
await models.completeSimple(model, context, { reasoning: 'low', maxTokens: 16 });
const matrix = builtinProviders().map(p => ({ providerId: p.id, name: p.name,
  apiKey: p.auth.apiKey ? { name: p.auth.apiKey.name, login: typeof p.auth.apiKey.login === 'function' } : null,
  oauth: p.auth.oauth ? { name: p.auth.oauth.name, isSubscription: p.auth.oauth.isSubscription === true,
    login: typeof p.auth.oauth.login === 'function', refresh: typeof p.auth.oauth.refresh === 'function',
    toAuth: typeof p.auth.oauth.toAuth === 'function' } : null,
  apis: [...new Set(p.getModels().map(m => m.api))] }));
await new Promise(resolve => server.close(resolve));
const result = { missingOwnAuthRefused, requests, matrix, sentinelAccess: globalThis.sdkProofAudit.sentinelAccess };
await writeFile('contract-probe.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify({ missingOwnAuthRefused, requests, oauth: matrix.filter(p => p.oauth).map(p => [p.providerId, p.oauth.isSubscription]) }));
