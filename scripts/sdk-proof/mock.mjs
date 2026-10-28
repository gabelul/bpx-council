import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

export const synthetic = Object.freeze({
  own: 'sk-fixture-own-api-credential', ambient: 'sk-fixture-ambient-api-credential',
  access: 'sk-ant-oat01-fixture-access', refresh: 'fixture-refresh-secret',
  rotatedAccess: 'sk-ant-oat01-fixture-rotated-access', rotatedRefresh: 'fixture-rotated-refresh-secret',
});
/** Start loopback provider fixture. Never log or retain auth headers/token bodies.
 * @returns {Promise<object>} Server, safe counters, controls and stop function.
 */
export async function startMock() {
  const state = { requests: [], oauthRequests: 0, oauthDelayMs: 0, oauthFailure: false, openSockets: new Set() };
  /** Emit one Responses API SSE frame. @param {object} res Response.
   * @param {object} event Provider event. @returns {void}
   */
  function emit(res, event) {
    if (!res.destroyed) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  }
  /** Serve OAuth token exchange or synthetic Responses inference.
   * @param {object} req Request. @param {object} res Response. @returns {Promise<void>}
   */
  async function serve(req, res) {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');
    if (req.url === '/oauth') {
      state.oauthRequests++;
      if (state.oauthDelayMs) await delay(state.oauthDelayMs);
      res.writeHead(state.oauthFailure ? 400 : 200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(state.oauthFailure
        ? { error: 'invalid_grant', error_description: synthetic.refresh }
        : { access_token: synthetic.rotatedAccess, refresh_token: synthetic.rotatedRefresh, expires_in: 7200 }));
      return;
    }
    const mode = req.headers['x-proof-mode'] ?? 'normal';
    state.requests.push({ path: req.url, model: body.model,
      effort: body.reasoning?.effort ?? body.output_config?.effort, thinking: body.thinking,
      maxTokens: body.max_output_tokens ?? body.max_tokens,
      ownCredentialUsed: req.headers.authorization === `Bearer ${synthetic.own}` || req.headers['x-api-key'] === synthetic.own,
      ownOAuthUsed: req.headers.authorization === `Bearer ${synthetic.rotatedAccess}`, 
      ambientCredentialUsed: req.headers.authorization === `Bearer ${synthetic.ambient}`,
      personaPresent: JSON.stringify(body).includes('Council fixture persona'),
      toolDeclarations: body.tools?.length ?? 0, mode });
    if (mode === 'error') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { type: 'invalid_request_error', message: synthetic.own } }));
      return;
    }
    if (mode === 'retry' || mode === '429') {
      res.writeHead(mode === '429' ? 429 : 503, { 'content-type': 'application/json', 'retry-after-ms': '500' });
      res.end(JSON.stringify({ error: { type: 'server_error', message: 'fixture service unavailable' } }));
      return;
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    const personaText = JSON.stringify({ name: 'sdk-reviewer', stance: 'neutral', systemPrompt: 'Review exact token budgets without changing model or effort.' });
    if (req.url.includes('messages')) {
      emit(res, { type: 'message_start', message: { id: 'msg_fixture', type: 'message', role: 'assistant', model: body.model,
        content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } } });
      emit(res, { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
      emit(res, { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: mode === 'persona' ? personaText : 'Council fixture answer' } });
      emit(res, { type: 'content_block_stop', index: 0 });
      emit(res, { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 4 } });
      emit(res, { type: 'message_stop' });
      res.end();
      return;
    }
    emit(res, { type: 'response.created', response: { id: 'resp_fixture' } });
    const item = { type: 'message', id: 'msg_fixture', role: 'assistant', content: [] };
    emit(res, { type: 'response.output_item.added', output_index: 0, item });
    let text = '';
    const parts = mode === 'bound' ? Array(20).fill('x'.repeat(128)) : mode === 'persona' ? [personaText] : ['Council ', 'fixture answer'];
    for (const part of parts) {
      if (res.destroyed) return;
      text += part;
      emit(res, { type: 'response.output_text.delta', output_index: 0, delta: part });
      await delay(mode === 'slow' ? 250 : 5);
    }
    if (mode === 'malformed') { res.end(); return; }
    item.content = [{ type: 'output_text', text, annotations: [] }];
    emit(res, { type: 'response.output_item.done', output_index: 0, item });
    emit(res, { type: mode === 'length' ? 'response.incomplete' : 'response.completed', response: {
      id: 'resp_fixture', status: mode === 'length' ? 'incomplete' : 'completed', output: [item],
      incomplete_details: mode === 'length' ? { reason: 'max_output_tokens' } : null,
      usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14,
        input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } },
    } });
    res.end();
  }
  const server = http.createServer((req, res) => {
    serve(req, res).catch(() => { if (!res.destroyed) { res.writeHead(500); res.end(); } });
  });
  server.on('connection', socket => {
    state.openSockets.add(socket);
    socket.on('close', () => state.openSockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  /** Stop fixture connections; no lingering SSE timer can make another request.
   * @returns {Promise<void>}
   */
  async function stop() {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}`, stop };
}
