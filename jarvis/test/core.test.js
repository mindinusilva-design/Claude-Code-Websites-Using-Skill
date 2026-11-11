import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/core/memory/store.js';
import { createCipherSuite } from '../src/core/memory/crypto.js';
import { NaiveBayesClassifier } from '../src/core/nlu/classifier.js';
import { SecurityManager } from '../src/core/security.js';
import { validateInput, createLanguageModel } from '../src/core/nlu/llm.js';

test('AES-GCM round trip and tamper detection', () => {
  const cipher = createCipherSuite({ secret: 's3cret', salt: Buffer.alloc(16, 1) });
  const blob = cipher.encrypt({ hello: 'world' });
  assert.ok(blob.startsWith('enc:v1:'));
  assert.deepEqual(cipher.decrypt(blob), { hello: 'world' });
  const raw = Buffer.from(blob.slice(7), 'base64');
  raw[raw.length - 1] ^= 1;
  assert.throws(() => cipher.decrypt(`enc:v1:${raw.toString('base64')}`));
});

test('store encrypts every collection on disk and reads it back', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jarvis-store-'));
  try {
    const store = new Store({ dir, secret: 'k', encrypted: 'all' });
    store.collection('tasks').insert({ title: 'Secret plan' });
    const onDisk = readFileSync(join(dir, 'tasks.json'), 'utf8');
    assert.ok(!onDisk.includes('Secret plan'));
    const reopened = new Store({ dir, secret: 'k', encrypted: 'all' });
    assert.equal(reopened.collection('tasks').all()[0].title, 'Secret plan');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('classifier learns online and survives serialization', () => {
  const c = new NaiveBayesClassifier();
  c.train('turn on the lights', 'power').train('switch off the lamp', 'power').train('what is the weather', 'weather').train('will it rain', 'weather');
  assert.equal(c.predict('is it going to rain tomorrow')[0].intent, 'weather');
  const copy = new NaiveBayesClassifier(JSON.parse(JSON.stringify(c.toJSON())));
  assert.equal(copy.predict('lights on please')[0].intent, 'power');
});

test('security: token auth, rate limiting and redaction', () => {
  const store = new Store();
  const open = new SecurityManager({ store, token: null });
  assert.equal(open.authenticate({ headers: {} }).ok, true);
  const locked = new SecurityManager({ store, token: 'abc', rateLimit: { windowMs: 60_000, max: 2 } });
  assert.equal(locked.authenticate({ headers: {} }).ok, false);
  assert.equal(locked.authenticate({ headers: { authorization: 'Bearer abc' } }).ok, true);
  assert.equal(locked.authenticate({ headers: {}, url: '/api/events?token=abc' }).ok, true);
  assert.equal(locked.authenticate({ headers: { authorization: 'Bearer nope' } }).ok, false);
  assert.ok(locked.rateLimit('x').ok && locked.rateLimit('x').ok && !locked.rateLimit('x').ok);
  assert.deepEqual(locked.redact({ apiKey: 'k', nested: { token: 't', name: 'n' } }), { apiKey: '[redacted]', nested: { token: '[redacted]', name: 'n' } });
});

test('tool input validation rejects malformed input', () => {
  const schema = { type: 'object', properties: { a: { type: 'string' }, n: { type: ['integer', 'null'] } }, required: ['a'], additionalProperties: false };
  assert.equal(validateInput(schema, { a: 'x', n: 2 }), null);
  assert.match(validateInput(schema, {}), /missing/);
  assert.match(validateInput(schema, { a: 1 }), /should be string/);
  assert.match(validateInput(schema, { a: 'x', z: 1 }), /unexpected/);
});

test('language model is disabled without a key', () => {
  assert.equal(createLanguageModel({ apiKey: null }).enabled, false);
});
