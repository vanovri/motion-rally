import test from 'node:test';
import assert from 'node:assert/strict';
import { createCommentary } from '../server/commentary.mjs';
import { startServer } from '../server/server.mjs';

test('concurrent commentary is bounded and releases busy state after failure', async () => {
  let release;
  let calls = 0;
  const adapter = createCommentary({enabled: true, apiKey: 'synthetic-test-key', timeoutMs: 1000,
    fetchImpl: async () => { calls++; return new Promise(resolve => {release = resolve;}); }});
  const first = adapter.speak('first');
  assert.equal((await adapter.speak('overlap')).reason, 'tts_session_limit');
  assert.equal(calls, 1);
  release({ok: false, status: 503});
  assert.equal((await first).error, 'tts_http_503');
  const second = adapter.speak('retry');
  assert.equal(calls, 2);
  release({ok: true, json: async () => ({candidates: [{content: {parts: [
    {inlineData: {data: 'YXVkaW8=', mimeType: 'audio/L16'}}]}}]})});
  assert.deepEqual(await second, {audio: 'YXVkaW8=', mime: 'audio/L16'});
});

test('commentary abort timeout returns an error and permits a subsequent request', async () => {
  let calls = 0;
  const adapter = createCommentary({enabled: true, apiKey: 'synthetic-test-key', timeoutMs: 5,
    fetchImpl: async (_url, options) => {
      calls++;
      if(calls === 2) return {ok:false, status:429};
      return new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => {
        const error = new Error('synthetic abort'); error.name='AbortError'; reject(error);
      }, {once:true}));
    }});
  assert.equal((await adapter.speak('timeout')).error, 'tts_timeout');
  assert.equal((await adapter.speak('after timeout')).error, 'tts_http_429');
  assert.equal(calls, 2);
});

test('real HTTP bridge implements HEAD and refuses unsupported methods', async t => {
  const server = await startServer({port:0});
  t.after(() => server.close());
  const get = await fetch(`${server.url}/controller`);
  const body = await get.text();
  const head = await fetch(`${server.url}/controller`, {method:'HEAD'});
  assert.equal(head.status, 200);
  assert.equal(await head.text(), '');
  assert.equal(Number(head.headers.get('content-length')), Buffer.byteLength(body));
  const rejected = await fetch(`${server.url}/healthz`, {method:'POST'});
  assert.equal(rejected.status, 405);
  assert.deepEqual(await rejected.json(), {error:'method_not_allowed'});
});
