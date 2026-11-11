// API client: JSON requests with the optional access token, plus the
// browser session id that keeps conversation context between page loads.
import { $ } from './dom.js';

const TOKEN_KEY = 'jarvis.token';
const SESSION_KEY = 'jarvis.session';

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

export function getToken() {
  try { return localStorage.getItem(TOKEN_KEY) || ''; } catch { return ''; }
}
function setToken(token) {
  try { localStorage.setItem(TOKEN_KEY, token); } catch { /* private mode: keep it for this page only */ }
  memoryToken = token;
}
let memoryToken = getToken();

function askForToken() {
  const dialog = $('#token-dialog');
  const form = $('#token-form');
  const input = $('#token-input');
  return new Promise((resolve) => {
    const onSubmit = (event) => {
      event.preventDefault();
      form.removeEventListener('submit', onSubmit);
      const value = input.value.trim();
      input.value = '';
      dialog.close();
      resolve(value);
    };
    form.addEventListener('submit', onSubmit);
    if (!dialog.open) dialog.showModal();
    input.focus();
  });
}

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, headers = {}, retry = true } = {}) {
  const init = { method, headers: { accept: 'application/json', ...headers } };
  if (memoryToken) init.headers.authorization = `Bearer ${memoryToken}`;
  if (body !== undefined) {
    init.headers['content-type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let response;
  try {
    response = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'JARVIS is unreachable. Check that the server is running.');
  }
  if (response.status === 401 && retry) {
    setToken(await askForToken());
    return api(path, { method, body, headers, retry: true });
  }
  const isJson = (response.headers.get('content-type') ?? '').includes('application/json');
  const data = isJson ? await response.json() : await response.text();
  if (!response.ok) throw new ApiError(response.status, (isJson && data?.error) || `Request failed (${response.status})`);
  return data;
}

export const withSession = (path) => `${path}${path.includes('?') ? '&' : '?'}sessionId=${encodeURIComponent(sessionId)}`;

/** Server-sent events with the token in the query string (EventSource cannot set headers). */
export function openEvents(handlers) {
  const url = memoryToken ? `/api/events?token=${encodeURIComponent(memoryToken)}` : '/api/events';
  const source = new EventSource(url);
  for (const [topic, handler] of Object.entries(handlers)) {
    if (topic === 'open' || topic === 'error') continue;
    source.addEventListener(topic, (event) => {
      let payload = {};
      try { payload = JSON.parse(event.data); } catch { /* ignore malformed frames */ }
      handler(payload);
    });
  }
  if (handlers.open) source.addEventListener('open', handlers.open);
  if (handlers.error) source.addEventListener('error', handlers.error);
  return source;
}

async function authorizedFetch(path, init, retry = true) {
  const headers = { ...(init.headers ?? {}) };
  if (memoryToken) headers.authorization = `Bearer ${memoryToken}`;
  let response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch {
    throw new ApiError(0, 'JARVIS is unreachable');
  }
  if (response.status === 401 && retry) {
    setToken(await askForToken());
    return authorizedFetch(path, init, false);
  }
  if (!response.ok) {
    let message = `Request failed (${response.status})`;
    try { message = (await response.json()).error ?? message; } catch { /* not JSON */ }
    throw new ApiError(response.status, message);
  }
  return response;
}

/** Spoken audio for a reply, as a Blob ready for an <audio> element. */
export async function fetchSpeech(text, voiceId = null) {
  const response = await authorizedFetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, voiceId }) });
  return response.blob();
}

/** Send a recorded clip for transcription and return the text. */
export async function transcribe(blob) {
  const response = await authorizedFetch('/api/voice/transcribe', { method: 'POST', headers: { 'content-type': blob.type || 'audio/webm' }, body: blob });
  return (await response.json()).text ?? '';
}
