import { writeFile, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { LockedCredentials, OwnModelsStore } from './storage.mjs';
import { startMock, synthetic } from './mock.mjs';

const results = [];
/** Record safe assertions, including known upstream failures rather than hiding them.
 * @param {string} id Check name. @param {boolean} pass Outcome.
 * @param {object} evidence Non-secret observations. @param {string} kind Requirement or SDK limitation.
 * @returns {void}
 */
function check(id, pass, evidence = {}, kind = 'requirement') { results.push({ id, pass, kind, evidence }); }
/** Wait for observable work, not fixed timing guesses.
 * @param {Function} predicate Completion check. @returns {Promise<void>}
 */
async function until(predicate) {
  const end = Date.now() + 5000;
  while (!predicate()) { if (Date.now() > end) throw new Error('Proof observation deadline'); await delay(5); }
}
/** Verify OS denies TEST-NET socket egress before importing any SDK.
 * @param {string} type TCP, TLS or UDP. @param {string} host Documentation-only target IP.
 * @returns {Promise<string>} Socket error code, never message or credential data.
 */
async function blocked(type, host) {
  return new Promise(resolve => {
    let socket;
    const timer = setTimeout(() => finish('TIMEOUT_NOT_PROOF'), 1000);
    /** Close socket before publishing result. @param {string} code Outcome. @returns {void} */
    function finish(code) {
      clearTimeout(timer);
      try { type === 'udp' ? socket.close() : socket.destroy(); } catch { /* Not yet bound. */ }
      resolve(code);
    }
    if (type === 'udp') {
      socket = dgram.createSocket(host.includes(':') ? 'udp6' : 'udp4');
      socket.on('error', error => finish(error.code));
      socket.send('fixture', 443, host, error => finish(error?.code ?? 'EGRESS_ALLOWED'));
    } else {
      socket = type === 'tls' ? tls.connect({ host, port: 443 }) : net.connect({ host, port: 443 });
      socket.on('error', error => finish(error.code));
      socket.on('connect', () => finish('EGRESS_ALLOWED'));
    }
  });
}
/** Allow only mock requests and remap one exact built-in OAuth token endpoint.
 * Published provider implementation still performs exchange, parsing and derivation.
 * @param {string} baseUrl Mock endpoint. @returns {Function} Restore native fetch.
 */
function routeOAuth(baseUrl) {
  const original = globalThis.fetch;
  /** Forward OAuth fixture to loopback; reject every other external fetch.
   * @param {unknown} input Fetch URL. @param {object} init Fetch options. @returns {Promise<Response>}
   */
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.href === 'https://platform.claude.com/v1/oauth/token') return original(`${baseUrl}/oauth`, init);
    if (url.hostname === '127.0.0.1' || url.hostname === '[::1]') return original(input, init);
    throw new Error('External fetch forbidden in proof');
  };
  return () => { globalThis.fetch = original; };
}
/** Consume SDK stream with Council-owned deadline/output budget and cleanup barrier.
 * No AgentSession, tools, retries, raw errors or credential receipts.
 * @param {object} models Models collection. @param {object} model Exact selected catalog model.
 * @param {object} credentials Tracked locked store. @param {object} catalogs Tracked catalog store.
 * @param {object} options Synthetic request controls. @returns {Promise<object>} Sanitized result.
 */
async function request(models, model, credentials, catalogs, options = {}) {
  return credentials.runScope(async () => {
  // Offered factory allowlist is deliberately narrower than offline SDK inventory.
  if (!['openai', 'anthropic'].includes(model.provider)) return { status: 'unsupported-provider' };
  const own = await credentials.read(model.provider);
  if (!own || (own.type === 'api_key' && !own.key)) return { status: 'error', errorCode: 'missing-own-auth' };
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(), options.deadlineMs ?? 4000);
  const limit = options.maxBytes ?? 256;
  let text = '';
  let clipped = false;
  let error = false;
  let events = 0;
  const stream = models.streamSimple(model, {
    systemPrompt: 'Council fixture persona', messages: [{ role: 'user', content: 'Offline synthetic question', timestamp: 1 }],
  }, { reasoning: 'low', maxTokens: 16, maxRetries: options.maxRetries ?? 0, signal, headers: { 'x-proof-mode': options.mode ?? 'normal' } });
  try {
    for await (const event of stream) {
      events++;
      if (event.type.startsWith('toolcall')) { error = true; controller.abort(); }
      if (event.type === 'text_delta') {
        const chunk = Buffer.from(event.delta);
        const remaining = limit - Buffer.byteLength(text);
        // Never retain oversized SDK partial/final messages in Council output.
        if (chunk.length > remaining) {
          text += chunk.subarray(0, remaining).toString('utf8').replace(/\uFFFD$/, '');
          clipped = true;
          controller.abort();
        } else text += event.delta;
      }
      if (event.type === 'error') error = true;
    }
    const response = await stream.result();
    return { providerId: model.provider, modelId: model.id, effort: 'low', text, events,
      status: clipped ? 'output-limit' : signal.aborted ? 'aborted' : error ? 'error' : response.stopReason,
      errorCode: clipped ? 'output-limit' : signal.aborted ? 'aborted' : error ? 'provider-error' : undefined,
      outputBytes: Buffer.byteLength(text), usage: response.usage ? {
        input: response.usage.input, output: response.usage.output,
      } : undefined };
  } finally {
    clearTimeout(timer);
  }
  });
}
/** Run locked built-in OAuth resolver from independent sandboxed process.
 * @param {object} ai Public SDK. @param {Function} anthropicProvider Published provider factory.
 * @returns {Promise<void>}
 */
async function worker(ai, anthropicProvider) {
  const credentials = new LockedCredentials(process.env.PROOF_SHARED);
  const models = ai.createModels({ credentials, modelsStore: new OwnModelsStore(),
    authContext: { env: async () => undefined, fileExists: async () => false } });
  models.setProvider(anthropicProvider());
  const restore = routeOAuth(process.env.PROOF_MOCK);
  try {
    const initial = await credentials.read('anthropic');
    await writeFile(process.env.PROOF_READY, JSON.stringify({ expired: initial?.expires === 0 }));
    const goDeadline = Date.now() + 10000;
    for (;;) {
      try { await readFile(process.env.PROOF_GO); break; }
      catch (error) { if (error.code !== 'ENOENT' || Date.now() > goDeadline) throw error; await delay(5); }
    }
    const auth = await models.getAuth('anthropic');
    await credentials.quiesce();
    if (process.env.PROOF_OTHER_PROVIDER) await credentials.modify(process.env.PROOF_OTHER_PROVIDER,
      async () => ({ type: 'api_key', key: synthetic.own }));
    await writeFile(process.env.PROOF_RESULT, JSON.stringify({ resolved: !!auth, writes: credentials.writes, oauthLockContentions: credentials.lockContentions.anthropic ?? 0 }));
  } finally { restore(); }
}

/** Run first gate checks and preserve every result on disk.
 * @returns {Promise<void>}
 */
async function main() {
  for (const [type, host] of [['tcp', '192.0.2.1'], ['tcp', '2001:db8::1'], ['tls', '192.0.2.1'], ['udp', '192.0.2.1']]) {
    const code = await blocked(type, host);
    check(`sandbox-${type}-${host}`, code === 'EPERM' || code === 'EACCES', { code });
  }
  if (results.some(r => !r.pass)) throw new Error('OS egress boundary failed; SDK not imported');
  check('empty-home-empty-path', (await readdir(process.env.HOME)).length === 0 && process.env.PATH === '',
    { homeEntryCount: (await readdir(process.env.HOME)).length, pathEmpty: process.env.PATH === '' });
  const startup = performance.now();
  const ai = await import('@earendil-works/pi-ai');
  const { openaiProvider } = await import('@earendil-works/pi-ai/providers/openai');
  const { anthropicProvider } = await import('@earendil-works/pi-ai/providers/anthropic');
  const lowerImportMs = performance.now() - startup;
  if (process.env.PROOF_ROLE === 'worker') { await worker(ai, anthropicProvider); return; }
  const { builtinProviders } = await import('@earendil-works/pi-ai/providers/all');
  const mock = await startMock();
  const restore = routeOAuth(mock.baseUrl);
  try {
    const credentials = new LockedCredentials(join(process.cwd(), 'suite-own'));
    const catalogs = new OwnModelsStore();
    const blockedContext = { env: async () => undefined, fileExists: async () => false };
    const models = ai.createModels({ credentials, modelsStore: catalogs, authContext: blockedContext });
    models.setProvider(openaiProvider());
    const model = { ...models.getModel('openai', 'gpt-5-mini'), baseUrl: `${mock.baseUrl}/v1` };
    const missing = await models.completeSimple(model, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] });
    check('lower-missing-own-auth-refuses', missing.stopReason === 'error' && mock.state.requests.length === 0,
      { status: missing.stopReason, providerRequests: mock.state.requests.length });
    const guarded = await request(models, model, credentials, catalogs);
    check('offered-provider-own-credential-guard', guarded.errorCode === 'missing-own-auth');
    models.setProvider(anthropicProvider());
    const missingAnthropic = await request(models, { ...models.getModel('anthropic', 'claude-sonnet-4-6'), baseUrl: mock.baseUrl }, credentials, catalogs);
    check('anthropic-offered-own-credential-guard', missingAnthropic.errorCode === 'missing-own-auth');
    await credentials.modify('anthropic', async () => ({ type: 'api_key', key: '' }));
    const incompleteAnthropic = await request(models, { ...models.getModel('anthropic', 'claude-sonnet-4-6'), baseUrl: mock.baseUrl }, credentials, catalogs);
    check('incomplete-own-key-no-ambient-fallback', incompleteAnthropic.errorCode === 'missing-own-auth');
    await credentials.delete('anthropic');
    const unsupported = await request(models, { ...model, provider: 'amazon-bedrock' }, credentials, catalogs);
    check('initial-cloud-factory-rejected', unsupported.status === 'unsupported-provider');
    const matrix = builtinProviders().map(provider => ({ providerId: provider.id, name: provider.name,
      apiKey: provider.auth.apiKey ? { name: provider.auth.apiKey.name, login: !!provider.auth.apiKey.login } : null,
      oauth: provider.auth.oauth ? { name: provider.auth.oauth.name, isSubscription: provider.auth.oauth.isSubscription === true,
        login: !!provider.auth.oauth.login, refresh: !!provider.auth.oauth.refresh, toAuth: !!provider.auth.oauth.toAuth } : null,
      apis: [...new Set(provider.getModels().map(m => m.api))] }));
    // Check every published provider without stored auth under hostile ambient fixtures.
    const inventory = ai.createModels({ credentials, modelsStore: catalogs, authContext: blockedContext });
    const unexpectedConfigured = [];
    for (const provider of builtinProviders()) {
      inventory.setProvider(provider);
      if (await inventory.getAuth(provider.id)) unexpectedConfigured.push(provider.id);
    }
    check('all-builtins-no-ambient-auth', unexpectedConfigured.length === 0, { unexpectedConfigured, providers: matrix.length });
    await models.login('openai', 'api_key', { prompt: async () => synthetic.own, notify: () => {} });
    const answer = await request(models, model, credentials, catalogs);
    const wire = mock.state.requests.at(-1);
    check('lower-selected-wire-contract', answer.status === 'stop' && answer.text === 'Council fixture answer'
      && wire.model === 'gpt-5-mini' && wire.effort === 'low' && wire.maxTokens === 16
      && wire.ownCredentialUsed && wire.personaPresent && wire.toolDeclarations === 0, { answer, wire });
    const failed = await request(models, model, credentials, catalogs, { mode: 'error' });
    check('provider-errors-sanitized', failed.status === 'error' && !JSON.stringify(failed).includes(synthetic.own), { failed });
    const malformed = await request(models, model, credentials, catalogs, { mode: 'malformed' });
    check('malformed-stream-terminal-error', malformed.status === 'error', { status: malformed.status });
    const length = await request(models, model, credentials, catalogs, { mode: 'length' });
    check('provider-length-preserved', length.status === 'length', { status: length.status });
    const bound = await request(models, model, credentials, catalogs, { mode: 'bound', maxBytes: 200 });
    const countAtBound = mock.state.requests.length;
    await delay(150);
    check('consumer-output-bound-no-later-request', bound.status === 'output-limit' && bound.outputBytes <= 200
      && mock.state.requests.length === countAtBound, { status: bound.status, outputBytes: bound.outputBytes, requestsStable: mock.state.requests.length === countAtBound });
    const abort = new AbortController();
    const inFlight = request(models, model, credentials, catalogs, { mode: 'slow', signal: abort.signal });
    const beforeAbort = mock.state.requests.length;
    await until(() => mock.state.requests.length > beforeAbort);
    abort.abort();
    const aborted = await inFlight;
    const countAtAbort = mock.state.requests.length;
    await delay(300);
    check('inference-abort-no-later-request', aborted.status === 'aborted' && mock.state.requests.length === countAtAbort,
      { status: aborted.status, requestsStable: mock.state.requests.length === countAtAbort, pendingStorage: credentials.pending.size });
    const deadline = await request(models, model, credentials, catalogs, { mode: 'slow', deadlineMs: 40 });
    check('deadline-cancels-stream', deadline.status === 'aborted', { status: deadline.status });
    const countBeforeRetry = mock.state.requests.length;
    const retry = await request(models, model, credentials, catalogs, { mode: 'retry' });
    await delay(650);
    check('provider-503-no-hidden-retry', retry.status === 'error' && mock.state.requests.length === countBeforeRetry + 1,
      { status: retry.status, providerRequests: mock.state.requests.length - countBeforeRetry });
    const before429 = mock.state.requests.length;
    const rateLimit = await request(models, model, credentials, catalogs, { mode: '429' });
    await delay(650);
    check('provider-429-no-hidden-retry', rateLimit.status === 'error' && mock.state.requests.length === before429 + 1,
      { status: rateLimit.status, providerRequests: mock.state.requests.length - before429 });
    const retryAbort = new AbortController();
    const beforeRetryAbort = mock.state.requests.length;
    const rateAbort = request(models, model, credentials, catalogs, { mode: '429', maxRetries: 2, signal: retryAbort.signal });
    await until(() => mock.state.requests.length > beforeRetryAbort);
    await delay(50); // First 429 has returned; SDK waits on configured 500ms backoff.
    retryAbort.abort();
    await rateAbort;
    await delay(1200);
    check('abort-429-no-later-retry', mock.state.requests.length === beforeRetryAbort + 1,
      { providerRequests: mock.state.requests.length - beforeRetryAbort });
    const serverAbort = new AbortController();
    const beforeServerAbort = mock.state.requests.length;
    const serverRetry = request(models, model, credentials, catalogs, { mode: 'retry', maxRetries: 2, signal: serverAbort.signal });
    await until(() => mock.state.requests.length > beforeServerAbort);
    await delay(50);
    serverAbort.abort();
    await serverRetry;
    await delay(1200);
    check('abort-503-no-later-retry', mock.state.requests.length === beforeServerAbort + 1,
      { providerRequests: mock.state.requests.length - beforeServerAbort });
    const positiveRetryBefore = mock.state.requests.length;
    await request(models, model, credentials, catalogs, { mode: 'retry', maxRetries: 1 });
    check('explicit-supported-retry-option-exercised', mock.state.requests.length === positiveRetryBefore + 2,
      { maxRetries: 1, providerRequests: mock.state.requests.length - positiveRetryBefore, backoffMs: 500 });
    await models.logout('openai');
    const countBeforeLogout = mock.state.requests.length;
    const loggedOut = await request(models, model, credentials, catalogs);
    check('logout-no-ambient-fallback', loggedOut.status === 'error' && mock.state.requests.length === countBeforeLogout);

    // Verify both offered API-key factories before testing published OAuth flow.
    models.setProvider(anthropicProvider());
    await models.login('anthropic', 'api_key', { prompt: async () => synthetic.own, notify: () => {} });
    const anthropicKeyAnswer = await request(models, { ...models.getModel('anthropic', 'claude-sonnet-4-6'), baseUrl: mock.baseUrl }, credentials, catalogs);
    const anthropicKeyWire = mock.state.requests.at(-1);
    check('published-anthropic-api-key-inference', anthropicKeyAnswer.status === 'stop' && anthropicKeyWire.ownCredentialUsed
      && !anthropicKeyWire.ambientCredentialUsed && anthropicKeyWire.toolDeclarations === 0,
      { status: anthropicKeyAnswer.status, wire: anthropicKeyWire });
    await models.logout('anthropic');
    // Call published Anthropic OAuth flow through Models.login, including PKCE/state handling.
    let state;
    const oauthEvents = [];
    const login = await models.login('anthropic', 'oauth', {
      prompt: async prompt => prompt.type === 'select' ? 'copy_code' : `fixture-code#${state}`,
      notify: event => { oauthEvents.push(event.type); if (event.type === 'auth_url') state = new URL(event.url).searchParams.get('state'); },
    });
    check('published-oauth-login-persists', login.type === 'oauth' && !!state && (await credentials.read('anthropic')).type === 'oauth',
      { credentialType: login.type, eventTypes: oauthEvents, tokenExchanges: mock.state.oauthRequests });
    const anthropicModel = { ...models.getModel('anthropic', 'claude-sonnet-4-6'), baseUrl: mock.baseUrl };
    const oauthAnswer = await request(models, anthropicModel, credentials, catalogs);
    const oauthWire = mock.state.requests.at(-1);
    check('published-anthropic-oauth-inference-wire', oauthAnswer.status === 'stop' && oauthAnswer.text === 'Council fixture answer'
      && oauthWire.model === 'claude-sonnet-4-6' && oauthWire.ownOAuthUsed && oauthWire.personaPresent
      && oauthWire.effort === 'low' && oauthWire.toolDeclarations === 0 && oauthWire.thinking?.type === 'adaptive',
      { answer: oauthAnswer, wire: oauthWire });
    const expired = { type: 'oauth', access: synthetic.access, refresh: synthetic.refresh, expires: 0 };
    await credentials.modify('anthropic', async () => expired);
    const beforeParallel = mock.state.oauthRequests;
    mock.state.oauthDelayMs = 80;
    await Promise.all(Array.from({ length: 8 }, () => models.getAuth('anthropic')));
    await credentials.quiesce();
    check('parallel-oauth-single-locked-refresh', mock.state.oauthRequests === beforeParallel + 1 && credentials.maxActive === 1,
      { refreshes: mock.state.oauthRequests - beforeParallel, maxActiveMutations: credentials.maxActive });
    await credentials.modify('anthropic', async () => expired);
    mock.state.oauthFailure = true;
    let oauthError;
    try { await models.getAuth('anthropic'); } catch (error) { oauthError = error; }
    check('oauth-refresh-failure-no-fallback', oauthError?.code === 'oauth' && (await credentials.read('anthropic')).expires === 0,
      { code: oauthError?.code, credentialPreserved: (await credentials.read('anthropic')).expires === 0,
        rawCauseContainsSyntheticToken: JSON.stringify(oauthError?.cause?.message).includes(synthetic.refresh) });
    mock.state.oauthFailure = false;

    // Logout must serialize after rotation: old refresh cannot resurrect deleted account.
    await credentials.modify('anthropic', async () => expired);
    mock.state.oauthDelayMs = 80;
    const beforeLogoutRefresh = mock.state.oauthRequests;
    const rotating = models.getAuth('anthropic');
    await until(() => mock.state.oauthRequests > beforeLogoutRefresh);
    const logout = models.logout('anthropic');
    await Promise.all([rotating, logout]);
    await credentials.quiesce();
    await delay(100);
    check('logout-versus-refresh-no-resurrection', !(await credentials.read('anthropic')) && !(await models.getAuth('anthropic')),
      { accountAbsent: !(await credentials.read('anthropic')) });

    // Native abort is an early return; rotation and durable write continue independently.
    const ModelRuntime = process.env.PROOF_SKIP_RUNTIME === '1' ? undefined
      : (await import('@earendil-works/pi-coding-agent')).ModelRuntime;
    for (const which of ModelRuntime ? ['ModelRuntime', 'createModels'] : ['createModels']) {
      await credentials.modify('anthropic', async () => expired);
      mock.state.oauthDelayMs = 120;
      credentials.writeDelayMs = 120;
      const runtime = which === 'ModelRuntime' ? await ModelRuntime.create({ credentials, modelsPath: null,
        modelsStore: catalogs, allowModelNetwork: false, refreshOnCreate: false }) : models;
      const target = { ...runtime.getModel('anthropic', 'claude-sonnet-4-5'), baseUrl: mock.baseUrl };
      const signal = new AbortController();
      const refreshes = mock.state.oauthRequests;
      const before = mock.state.requests.length;
      const native = runtime.completeSimple(target, { messages: [{ role: 'user', content: 'fixture', timestamp: 1 }] }, { signal: signal.signal });
      await until(() => mock.state.oauthRequests > refreshes);
      signal.abort();
      const nativeResponse = await native;
      const pendingAtReturn = credentials.pending.size;
      const writesAtReturn = credentials.writes;
      check(`${which}-native-abort-quiescence`, pendingAtReturn === 0,
        { pendingAtReturn, nativeStopReason: nativeResponse.stopReason, writesAtReturn }, 'sdk-limitation');
      await credentials.quiesce();
      await delay(180);
      check(`${which}-owned-barrier-no-inference-after`, credentials.pending.size === 0
        && credentials.writes === writesAtReturn + 1 && mock.state.requests.length === before,
        { writesAfterReturn: credentials.writes - writesAtReturn, pendingAfterBarrier: credentials.pending.size,
          inferenceRequestsAfterAbort: mock.state.requests.length - before });
      credentials.writeDelayMs = 0;
    }
    // Exercise service's own awaited abort path, not only native SDK result.
    await credentials.modify('anthropic', async () => expired);
    credentials.writeDelayMs = 100;
    const cleanAbort = new AbortController();
    const oauthBefore = mock.state.oauthRequests;
    const inferenceBefore = mock.state.requests.length;
    const clean = request(models, { ...models.getModel('anthropic', 'claude-sonnet-4-5'), baseUrl: mock.baseUrl },
      credentials, catalogs, { signal: cleanAbort.signal });
    await until(() => mock.state.oauthRequests > oauthBefore);
    cleanAbort.abort();
    const cleanResult = await clean;
    check('service-abort-awaits-refresh-write', cleanResult.status === 'aborted' && credentials.pending.size === 0
      && mock.state.requests.length === inferenceBefore, { status: cleanResult.status, pendingStorage: credentials.pending.size,
        inferenceRequests: mock.state.requests.length - inferenceBefore });
    credentials.writeDelayMs = 0;

    // Abort during persistence/unlock, after provider refresh has already completed.
    await credentials.modify('anthropic', async () => expired);
    mock.state.oauthDelayMs = 10;
    credentials.writeDelayMs = 120;
    credentials.unlockDelayMs = 80;
    const duringWrite = new AbortController();
    const writeStartsBefore = credentials.writeStarts;
    const writesBefore = credentials.writes;
    const writeInferenceBefore = mock.state.requests.length;
    const writing = request(models, { ...anthropicModel }, credentials, catalogs, { signal: duringWrite.signal });
    await until(() => credentials.writeStarts > writeStartsBefore);
    const abortTime = performance.now();
    duringWrite.abort();
    const writeResult = await writing;
    const afterWriteAbortMs = performance.now() - abortTime;
    check('service-abort-during-persist-unlock-awaits', writeResult.status === 'aborted' && credentials.pending.size === 0
      && credentials.writes === writesBefore + 1 && afterWriteAbortMs >= 150 && mock.state.requests.length === writeInferenceBefore,
      { status: writeResult.status, pending: credentials.pending.size, writesAfterAbort: credentials.writes - writesBefore,
        afterWriteAbortMs: Math.round(afterWriteAbortMs), inferenceRequests: mock.state.requests.length - writeInferenceBefore });
    credentials.writeDelayMs = 0;
    credentials.unlockDelayMs = 0;
    // Abort queued lock acquisition before rotation starts: must not refresh or write.
    await credentials.modify('anthropic', async () => expired);
    let unlock;
    const hold = credentials.modify('anthropic', async () => { await new Promise(resolve => { unlock = resolve; }); return undefined; });
    await until(() => !!unlock);
    const queuedAbort = new AbortController();
    const queuedBefore = mock.state.oauthRequests;
    const queuedWritesBefore = credentials.writes;
    const queuedAttemptsBefore = credentials.lockAttempts;
    const queued = models.getAuth('anthropic', { signal: queuedAbort.signal });
    await until(() => credentials.lockAttempts > queuedAttemptsBefore);
    queuedAbort.abort();
    await queued.catch(() => {});
    unlock();
    await hold;
    await credentials.quiesce();
    check('queued-auth-abort-no-refresh', mock.state.oauthRequests === queuedBefore && credentials.writes === queuedWritesBefore
      && credentials.pending.size === 0, { lockAttempted: credentials.lockAttempts > queuedAttemptsBefore,
        refreshes: mock.state.oauthRequests - queuedBefore, writes: credentials.writes - queuedWritesBefore, pending: credentials.pending.size });

    // Scope cleanup must not wait on an unrelated seat's global storage lease.
    let releaseOther;
    const unrelated = credentials.runScope(() => credentials.modify('unrelated-seat', async () => {
      await new Promise(resolve => { releaseOther = resolve; }); return undefined;
    }));
    await until(() => !!releaseOther);
    const ownScopeStart = performance.now();
    await credentials.runScope(async () => {});
    check('operation-scope-separate-from-shutdown', credentials.pending.size > 0 && performance.now() - ownScopeStart < 50,
      { globalPendingWhileOwnScopeSettled: credentials.pending.size });
    releaseOther();
    await unrelated;
    await credentials.quiesce();
    // Catalog writes are separately tracked; SDK refresh returns early on abort.
    catalogs.writeDelayMs = 100;
    const dynamic = ai.createProvider({ id: 'fixture-catalog', models: [],
      auth: { apiKey: ai.envApiKeyAuth('Fixture catalog key', []) },
      fetchModels: async () => [{ ...model, provider: 'fixture-catalog' }],
      api: await import('@earendil-works/pi-ai/api/openai-responses'),
    });
    models.setProvider(dynamic);
    await credentials.modify('fixture-catalog', async () => ({ type: 'api_key', key: synthetic.own }));
    const catalogAbort = new AbortController();
    const catalogRefresh = models.refresh({ providers: ['fixture-catalog'], allowNetwork: true, signal: catalogAbort.signal });
    await until(() => catalogs.pending.size > 0);
    catalogAbort.abort();
    const catalogResult = await catalogRefresh;
    const catalogPendingAtReturn = catalogs.pending.size;
    await catalogs.quiesce();
    check('catalog-abort-owned-write-barrier', catalogResult.aborted && catalogs.pending.size === 0 && catalogs.writes === 0,
      { pendingAtSDKReturn: catalogPendingAtReturn, pendingAfterBarrier: catalogs.pending.size, publishedWrites: catalogs.writes });
    check('no-sentinel-access-no-native-cli', globalThis.sdkProofAudit.sentinelAccess.length === 0 && globalThis.sdkProofAudit.subprocessAttempts.length === 0,
      globalThis.sdkProofAudit);
    check('home-remains-empty', (await readdir(process.env.HOME)).length === 0);
    check('static-catalog-no-auto-network-refresh', mock.state.requests.every(r => r.path.startsWith('/v1/responses') || r.path.startsWith('/v1/messages')),
      { observedPaths: [...new Set(mock.state.requests.map(r => r.path))] });
    await writeFile('provider-matrix.json', JSON.stringify(matrix, null, 2));
    await writeFile('suite-wire.json', JSON.stringify(mock.state.requests, null, 2));
    await writeFile('startup.json', JSON.stringify({ lowerImportMs: Math.round(lowerImportMs * 100) / 100 }));
  } finally { restore(); await mock.stop(); }
}

try { await main(); }
catch (error) { check('runner-exception', false, { name: error.name, code: error.code ?? 'proof-exception' }); }
finally {
  if (process.env.PROOF_ROLE !== 'worker') {
    await writeFile('suite-results.json', JSON.stringify(results, null, 2));
    console.log(JSON.stringify({ checks: results.length, failures: results.filter(r => !r.pass).map(r => ({ id: r.id, kind: r.kind })) }));
    if (results.some(r => !r.pass && r.kind === 'requirement')) process.exitCode = 1;
  }
}
