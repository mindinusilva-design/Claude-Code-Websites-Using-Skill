import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createVoiceService, clipForSpeech, DEFAULT_VOICE_ID, VoiceError } from '../src/voice/index.js';
import { IntegrationRegistry } from '../src/integrations/index.js';
import { defineIntegrations } from '../src/integrations/catalog.js';
import { Store } from '../src/core/memory/store.js';
import { makeJarvis } from './helpers.js';
import { createApp } from '../src/server/app.js';

const registry = (env) => defineIntegrations(new IntegrationRegistry({ store: new Store(), env }));

// ---- the ElevenLabs client, with the network stubbed ----------------------
const realFetch = globalThis.fetch;
let calls = [];
let reply = null;
function stub() {
  calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    return reply(String(url), init);
  };
}

test('voice is off without an ElevenLabs key', async () => {
  const voice = createVoiceService({ integrations: registry({}) });
  assert.deepEqual(voice.status(), { tts: null, stt: null });
  await assert.rejects(voice.speak('hello'), (e) => e instanceof VoiceError && e.status === 409);
});

test('speak: sends the documented request and caches short phrases', async () => {
  stub();
  reply = () => new Response(new Uint8Array([0x49, 0x44, 0x33, 1, 2, 3]), { status: 200, headers: { 'content-type': 'audio/mpeg' } });
  try {
    const voice = createVoiceService({ integrations: registry({ ELEVENLABS_API_KEY: 'k-123' }) });
    const first = await voice.speak('Good evening, sir.');
    assert.equal(first.contentType, 'audio/mpeg');
    assert.equal(first.audio.length, 6);
    const call = calls[0];
    assert.equal(call.url, `https://api.elevenlabs.io/v1/text-to-speech/${DEFAULT_VOICE_ID}?output_format=mp3_44100_128`);
    assert.equal(call.init.method, 'POST');
    assert.equal(call.init.headers['xi-api-key'], 'k-123');
    const body = JSON.parse(call.init.body);
    assert.equal(body.text, 'Good evening, sir.');
    assert.equal(body.model_id, 'eleven_flash_v2_5');
    assert.ok(body.voice_settings.similarity_boost > 0);
    const second = await voice.speak('Good evening, sir.');
    assert.equal(second.cached, true);
    assert.equal(calls.length, 1, 'cached phrase is not fetched again');
    await voice.speak('Another line', { voiceId: 'bad id!' });
    assert.ok(calls[1].url.includes(DEFAULT_VOICE_ID), 'invalid voice ids fall back to the configured voice');
  } finally { globalThis.fetch = realFetch; }
});

test('transcribe: posts multipart audio with the model id', async () => {
  stub();
  reply = () => new Response(JSON.stringify({ language_code: 'en', text: ' turn on the kitchen lights ' }), { status: 200, headers: { 'content-type': 'application/json' } });
  try {
    const voice = createVoiceService({ integrations: registry({ ELEVENLABS_API_KEY: 'k' }) });
    const result = await voice.transcribe(Buffer.from('fake-webm-bytes'), 'audio/webm');
    assert.deepEqual(result, { text: 'turn on the kitchen lights', language: 'en' });
    const { url, init } = calls[0];
    assert.equal(url, 'https://api.elevenlabs.io/v1/speech-to-text');
    assert.ok(init.body instanceof FormData);
    assert.equal(init.body.get('model_id'), 'scribe_v2');
    assert.equal(init.body.get('file').type, 'audio/webm');
    assert.equal(init.headers['content-type'], undefined, 'fetch sets the multipart boundary itself');
  } finally { globalThis.fetch = realFetch; }
});

test('API errors become clear messages', async () => {
  stub();
  reply = () => new Response(JSON.stringify({ detail: { status: 'invalid_api_key' } }), { status: 401 });
  try {
    const voice = createVoiceService({ integrations: registry({ ELEVENLABS_API_KEY: 'wrong' }) });
    await assert.rejects(voice.speak('hi'), /API key was rejected/);
  } finally { globalThis.fetch = realFetch; }
});

test('long replies are clipped at a sentence boundary', () => {
  const text = 'This is a sentence. '.repeat(300);
  const clipped = clipForSpeech(text, 1000);
  assert.ok(clipped.length <= 1000);
  assert.ok(clipped.endsWith('.'));
});

// ---- the HTTP routes, with a fake voice service ---------------------------
let app; let base; let jarvis; const heard = [];
before(async () => {
  const fakeVoice = {
    status: () => ({ tts: { provider: 'elevenlabs', voiceId: DEFAULT_VOICE_ID, model: 'm' }, stt: { provider: 'elevenlabs', model: 's' } }),
    voices: async () => [{ id: DEFAULT_VOICE_ID, name: 'George', description: 'british, male' }],
    speak: async (text) => ({ audio: Buffer.from(`mp3:${text}`), contentType: 'audio/mpeg', cached: false }),
    transcribe: async (audio, type) => { heard.push({ size: audio.length, type }); return { text: 'what time is it', language: 'en' }; },
    reset() {},
  };
  jarvis = await makeJarvis({ voice: fakeVoice });
  app = createApp(jarvis);
  base = `http://127.0.0.1:${(await app.listen(0, '127.0.0.1')).port}`;
});
after(async () => { await app.close(); jarvis.stop(); });

test('GET /api/voice reports engines and voices', async () => {
  const body = await (await fetch(`${base}/api/voice`)).json();
  assert.equal(body.tts.provider, 'elevenlabs');
  assert.equal(body.voices[0].name, 'George');
});

test('POST /api/voice/speak returns audio', async () => {
  const res = await fetch(`${base}/api/voice/speak`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'Hello' }) });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'audio/mpeg');
  assert.equal(Buffer.from(await res.arrayBuffer()).toString(), 'mp3:Hello');
  assert.match(res.headers.get('content-security-policy'), /media-src 'self' blob:/);
});

test('POST /api/voice/transcribe accepts audio only, within the size limit', async () => {
  let res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm;codecs=opus' }, body: Buffer.alloc(4000, 1) });
  assert.equal(res.status, 200);
  assert.equal((await res.json()).text, 'what time is it');
  assert.deepEqual(heard[0], { size: 4000, type: 'audio/webm' });
  res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(res.status, 415);
  res = await fetch(`${base}/api/voice/transcribe`, { method: 'POST', headers: { 'content-type': 'audio/webm' }, body: Buffer.alloc(9 * 1024 * 1024) });
  assert.equal(res.status, 413);
});

test('the privacy report says where voice data goes', async () => {
  assert.match(jarvis.privacyReport().voice, /ElevenLabs/);
});
