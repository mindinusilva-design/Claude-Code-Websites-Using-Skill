import { test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { makeJarvis } from './helpers.js';
import { createApp } from '../src/server/app.js';

let app; let base; let jarvis;
before(async () => {
  jarvis = await makeJarvis({ apiToken: 'test-token' });
  app = createApp(jarvis);
  const address = await app.listen(0, '127.0.0.1');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => { await app.close(); jarvis.stop(); });

const auth = { authorization: 'Bearer test-token', 'content-type': 'application/json' };

test('health is open, the API requires the token', async () => {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  assert.equal((await fetch(`${base}/api/dashboard`)).status, 401);
  assert.equal((await fetch(`${base}/api/dashboard`, { headers: auth })).status, 200);
});

test('chat round trip and security headers', async () => {
  const res = await fetch(`${base}/api/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'turn on the kitchen lights', sessionId: 'srv' }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-frame-options'), 'DENY');
  const body = await res.json();
  assert.equal(body.intents[0].intent, 'smarthome.power');
});

test('rejects cross-origin writes, bad content types and oversized input', async () => {
  let res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { ...auth, origin: 'https://evil.example' }, body: JSON.stringify({ text: 'hi' }) });
  assert.equal(res.status, 403);
  res = await fetch(`${base}/api/chat`, { method: 'POST', headers: { authorization: auth.authorization, 'content-type': 'text/plain' }, body: 'hi' });
  assert.equal(res.status, 415);
  res = await fetch(`${base}/api/chat`, { method: 'POST', headers: auth, body: JSON.stringify({ text: 'x'.repeat(3000) }) });
  assert.equal(res.status, 400);
});

test('deleting data requires an explicit confirmation header', async () => {
  let res = await fetch(`${base}/api/privacy/data?scope=history`, { method: 'DELETE', headers: auth });
  assert.equal(res.status, 400);
  res = await fetch(`${base}/api/privacy/data?scope=history`, { method: 'DELETE', headers: { ...auth, 'x-confirm': 'delete' } });
  assert.equal(res.status, 200);
});

test('integration secrets are never returned', async () => {
  await fetch(`${base}/api/integrations/mastodon`, { method: 'PUT', headers: auth, body: JSON.stringify({ values: { url: 'https://mastodon.example', token: 'super-secret' } }) });
  const text = await (await fetch(`${base}/api/integrations`, { headers: auth })).text();
  assert.ok(!text.includes('super-secret'));
  assert.ok(text.includes('mastodon.example'));
});

test('feedback updates the learning report', async () => {
  const res = await fetch(`${base}/api/feedback`, { method: 'POST', headers: auth, body: JSON.stringify({ utterance: 'make it bright in the kitchen', rating: 'down', comment: 'turn on the kitchen lights' }) });
  assert.equal(res.status, 201);
  const { feedback } = await res.json();
  assert.equal(feedback.learned.alias, 'turn on the kitchen lights');
});
