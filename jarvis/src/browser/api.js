// Standalone replacement for public/js/api.js: identical exports, but every
// call is answered by the in-page router instead of an HTTP server.
const SESSION_KEY = 'jarvis.session';
const FORWARDED = ['reminder.due', 'reminder.changed', 'device.changed', 'task.changed', 'calendar.changed', 'learning.updated', 'integrations.changed', 'privacy.forgotten'];

let backend = null;
let markReady;
const ready = new Promise((resolve) => { markReady = resolve; });

/** Called once by src/browser/entry.js when the kernel is up. */
export function setBackend(value) {
  backend = value;
  markReady();
}

function loadSession() {
  try {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id || !/^[a-zA-Z0-9_-]{8,64}$/.test(id)) {
      id = `web_${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`;
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  } catch {
    return `web_${Math.random().toString(36).slice(2, 14)}`;
  }
}

export const sessionId = loadSession();
export const getToken = () => '';

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function call(path, { method = 'GET', body, headers = {} } = {}) {
  await ready;
  const response = await backend.router.handle({ method, path, body: body === undefined ? null : body, headers });
  if (response.status >= 400) throw new ApiError(response.status, response.body?.error ?? `Request failed (${response.status})`);
  return response;
}

export async function api(path, options = {}) {
  const response = await call(path, options);
  return 'raw' in response ? response.raw : response.body;
}

export async function apiBlob(path) {
  const response = await call(path);
  const raw = 'raw' in response ? response.raw : JSON.stringify(response.body);
  return raw instanceof Blob ? raw : new Blob([raw], { type: response.headers?.['content-type'] ?? 'application/octet-stream' });
}

export const withSession = (path) => `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`;

export function openEvents(handlers) {
  let listener = null;
  ready.then(() => {
    listener = (event) => {
      if (FORWARDED.includes(event.topic)) handlers[event.topic]?.(structuredClone(event.payload));
    };
    backend.jarvis.events.on('*', listener);
    handlers.open?.();
  });
  return { close() { if (listener) backend.jarvis.events.off('*', listener); } };
}

export async function fetchSpeech(text, voiceId = null) {
  await ready;
  const { audio } = await backend.jarvis.voice.speak(text, { voiceId });
  return audio instanceof Blob ? audio : new Blob([audio], { type: 'audio/mpeg' });
}

export async function transcribe(blob) {
  await ready;
  const { text } = await backend.jarvis.voice.transcribe(blob, (blob.type || 'audio/webm').split(';')[0]);
  return text;
}
