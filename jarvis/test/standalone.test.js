import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { BrowserStore, MemoryStorage } from '../src/browser/store.js';

test('the standalone build is one self-contained HTML file', () => {
  execFileSync(process.execPath, ['scripts/build-standalone.mjs'], { stdio: 'pipe' });
  const html = readFileSync('standalone/jarvis.html', 'utf8');
  assert.match(html, /^<!doctype html>/i);
  assert.ok(html.includes('<script type="module">'), 'script is inlined');
  assert.ok(!/\s(src|href)="\/(?!\/)/.test(html), 'no references to server paths');
  assert.ok(html.includes('data:font/woff2;base64,'), 'fonts are embedded');
  assert.ok(!html.includes('node:fs'), 'no Node file-system code');
  assert.ok(html.length < 2 * 1024 * 1024, 'stays under 2 MB');
});

test('browser store: plain JSON, then sealed with a passphrase, then unlocked', async () => {
  const storage = new MemoryStorage();
  const store = await new BrowserStore(storage).load();
  store.collection('tasks').insert({ title: 'Build a suit' });
  await store.flush();
  assert.ok(storage.getItem('jarvis:tasks').includes('Build a suit'));

  await store.setPassphrase('correct horse battery');
  assert.ok(!storage.getItem('jarvis:tasks').includes('Build a suit'), 'data is encrypted at rest');
  assert.ok(storage.getItem('jarvis:.lock'));

  const reopened = new BrowserStore(storage);
  assert.equal(reopened.isLocked(), true);
  await assert.rejects(reopened.unlock('wrong passphrase'), /not correct/);
  await reopened.unlock('correct horse battery');
  assert.equal(reopened.collection('tasks').all()[0].title, 'Build a suit');

  await reopened.setPassphrase(null);
  assert.ok(storage.getItem('jarvis:tasks').includes('Build a suit'), 'removing the passphrase decrypts');
  await assert.rejects(reopened.setPassphrase('short'), /at least 8/);
});
