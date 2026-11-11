import { createServer } from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { VERSION } from '../core/jarvis.js';
import { AUDIO_TYPES, MAX_AUDIO_BYTES, VoiceError } from '../voice/index.js';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const DEFAULT_PUBLIC = resolve(HERE, '../../public');
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json', '.txt': 'text/plain; charset=utf-8', '.woff2': 'font/woff2',
};
const MAX_BODY = 100 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
const FORWARDED_EVENTS = ['reminder.due', 'reminder.changed', 'device.changed', 'task.changed', 'calendar.changed', 'learning.updated', 'integrations.changed', 'privacy.forgotten'];
const PROFILE_KEYS = ['name', 'location', 'units', 'voice', 'newsTopics', 'retentionDays', 'incognito', 'wakeWord', 'confirmSensitive'];

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function compile(path) {
  const keys = [];
  const source = path.replace(/:[a-zA-Z]+/g, (key) => {
    keys.push(key.slice(1));
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${source}$`), keys };
}

/** JSON by default; routes with `audio: true` accept a raw audio upload instead. */
async function readBody(req, { audio = false } = {}) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return null;
  const type = String(req.headers['content-type'] ?? '').split(';')[0].trim().toLowerCase();
  if (audio && !AUDIO_TYPES.has(type)) throw new HttpError(415, `content-type must be one of ${[...AUDIO_TYPES].join(', ')}`);
  const limit = audio ? MAX_AUDIO_BYTES : MAX_BODY;
  if (Number(req.headers['content-length'] ?? 0) > limit) throw new HttpError(413, 'request body too large');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, 'request body too large');
    chunks.push(chunk);
  }
  if (audio) return { audio: Buffer.concat(chunks), contentType: type };
  if (!size) return null;
  if (type !== 'application/json') throw new HttpError(415, 'content-type must be application/json');
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'invalid JSON body');
  }
}

/**
 * HTTP + SSE front door for a Jarvis instance. No framework: Node's http
 * module, a tiny router, and the security checks every route shares.
 */
export function createApp(jarvis, { publicDir = DEFAULT_PUBLIC, allowedHosts = [] } = {}) {
  const routes = [];
  const add = (method, path, handler, options = {}) => routes.push({ method, ...compile(path), handler, ...options });
  const startedAt = Date.now();
  const clients = new Set();
  const hosts = new Set([...LOOPBACK, ...allowedHosts.map((h) => h.toLowerCase())]);

  // -- core routes ------------------------------------------------------------
  add('GET', '/api/health', () => ({ ok: true, name: 'JARVIS', version: VERSION, uptime: Math.round((Date.now() - startedAt) / 1000) }), { open: true });
  add('GET', '/api/session', () => ({ authRequired: jarvis.security.authRequired, version: VERSION }), { open: true });

  add('POST', '/api/chat', async (req) => {
    const { text, sessionId, channel } = req.body ?? {};
    const check = jarvis.security.validateText(text);
    if (!check.ok) throw new HttpError(400, check.reason);
    return jarvis.handle({ text: check.text, sessionId: sanitizeSession(sessionId), channel: channel === 'voice' ? 'voice' : 'text' });
  });

  add('GET', '/api/dashboard', (req) => jarvis.dashboard(sanitizeSession(req.query.sessionId)));
  add('GET', '/api/history', (req) => ({ turns: jarvis.history({ sessionId: sanitizeSession(req.query.sessionId), limit: Math.min(100, Number(req.query.limit) || 30) }) }));
  add('GET', '/api/skills', () => ({ skills: jarvis.registry.list() }));
  add('GET', '/api/system', () => systemSnapshot());

  add('POST', '/api/feedback', (req) => {
    const { turnId, rating, comment, correctedIntent, utterance, intent, sessionId } = req.body ?? {};
    if (!['up', 'down'].includes(rating)) throw new HttpError(400, 'rating must be "up" or "down"');
    const record = jarvis.feedback({ turnId: turnId ?? null, rating, comment, correctedIntent, utterance, intent, sessionId: sanitizeSession(sessionId) });
    return { status: 201, body: { feedback: record, report: jarvis.learning.report() } };
  });
  add('GET', '/api/feedback/report', () => jarvis.learning.report());

  add('GET', '/api/profile', () => ({ profile: jarvis.profile.preferences, interests: jarvis.profile.topInterests(8) }));
  add('PUT', '/api/profile', (req) => {
    const patch = {};
    for (const key of PROFILE_KEYS) if (req.body && key in req.body) patch[key] = req.body[key];
    if ('units' in patch && !['metric', 'imperial'].includes(patch.units)) throw new HttpError(400, 'units must be metric or imperial');
    if ('retentionDays' in patch) patch.retentionDays = Math.max(1, Math.min(3650, Number(patch.retentionDays) || 30));
    if ('newsTopics' in patch) patch.newsTopics = (Array.isArray(patch.newsTopics) ? patch.newsTopics : []).map((t) => String(t).trim().toLowerCase().slice(0, 40)).filter(Boolean).slice(0, 8);
    for (const key of ['name', 'location', 'wakeWord']) if (key in patch) patch[key] = patch[key] ? String(patch[key]).trim().slice(0, 80) : null;
    if ('incognito' in patch) patch.incognito = Boolean(patch.incognito);
    const profile = jarvis.profile.set(patch);
    if ('retentionDays' in patch) jarvis.applyRetention();
    jarvis.security.audit('profile.updated', { fields: Object.keys(patch) }, 'dashboard');
    return { profile };
  });
  add('POST', '/api/suggestions/dismiss', (req) => {
    if (typeof req.body?.id !== 'string') throw new HttpError(400, 'id is required');
    jarvis.profile.dismissSuggestion(req.body.id.slice(0, 120));
    return { ok: true };
  });

  add('GET', '/api/privacy', () => jarvis.privacyReport());
  add('GET', '/api/privacy/audit', (req) => ({ entries: jarvis.security.auditLog(Math.min(500, Number(req.query.limit) || 100)) }));
  add('GET', '/api/privacy/export', () => ({
    status: 200,
    headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': 'attachment; filename="jarvis-export.json"' },
    raw: JSON.stringify(jarvis.exportData(), null, 2),
  }));
  add('DELETE', '/api/privacy/data', async (req) => {
    const scope = ['history', 'learning', 'all'].includes(req.query.scope) ? req.query.scope : null;
    if (!scope) throw new HttpError(400, 'scope must be history, learning or all');
    if (req.headers['x-confirm'] !== 'delete') throw new HttpError(400, 'send the header "x-confirm: delete" to confirm');
    return jarvis.forget(scope);
  });

  // -- voice ------------------------------------------------------------------
  add('GET', '/api/voice', async () => {
    const status = jarvis.voice.status();
    let voices = [];
    let error = null;
    if (status.tts) {
      try { voices = await jarvis.voice.voices(); } catch (e) { error = e.message; }
    }
    return { ...status, voices, error };
  });
  add('POST', '/api/voice/speak', async (req) => {
    const text = req.body?.text;
    if (typeof text !== 'string' || !text.trim()) throw new HttpError(400, 'text is required');
    if (text.length > 5000) throw new HttpError(400, 'text is too long');
    try {
      const { audio, contentType, cached } = await jarvis.voice.speak(text, { voiceId: typeof req.body.voiceId === 'string' ? req.body.voiceId : null });
      return { status: 200, headers: { 'content-type': contentType, 'x-jarvis-cache': cached ? 'hit' : 'miss' }, raw: audio };
    } catch (error) {
      if (error instanceof VoiceError) throw new HttpError(error.status, error.message);
      throw error;
    }
  });
  add('POST', '/api/voice/transcribe', async (req) => {
    try {
      const result = await jarvis.voice.transcribe(req.body.audio, req.body.contentType);
      jarvis.security.audit('voice.transcribed', { bytes: req.body.audio.length }, 'dashboard');
      return result;
    } catch (error) {
      if (error instanceof VoiceError) throw new HttpError(error.status, error.message);
      throw error;
    }
  }, { audio: true });

  add('GET', '/api/integrations', () => ({ integrations: jarvis.integrations.list() }));
  add('PUT', '/api/integrations/:id', async (req) => {
    if (!jarvis.integrations.describe(req.params.id)) throw new HttpError(404, 'unknown integration');
    const values = req.body?.values;
    if (!values || typeof values !== 'object') throw new HttpError(400, 'values object is required');
    const integration = jarvis.integrations.configure(req.params.id, values);
    await jarvis.reconfigure();
    return { integration };
  });
  add('POST', '/api/integrations/:id/test', async (req) => {
    if (!jarvis.integrations.describe(req.params.id)) throw new HttpError(404, 'unknown integration');
    return jarvis.integrations.test(req.params.id);
  });

  // -- skill routes -----------------------------------------------------------
  for (const route of jarvis.registry.routes()) {
    add(route.method, route.path, (req) => route.handler(req, { ...jarvis.ctx, session: jarvis.contexts.get(sanitizeSession(req.query.sessionId)), actor: 'dashboard' }));
  }

  // -- host metrics for the HUD diagnostics ----------------------------------
  const cpuTotals = () => os.cpus().reduce((acc, cpu) => {
    const t = cpu.times;
    acc.idle += t.idle;
    acc.total += t.user + t.nice + t.sys + t.idle + t.irq;
    return acc;
  }, { idle: 0, total: 0 });
  let cpuPrev = cpuTotals();
  let cpuPercent = 0;
  const cpuTimer = setInterval(() => {
    const now = cpuTotals();
    const total = now.total - cpuPrev.total;
    if (total > 0) cpuPercent = Math.round((1 - (now.idle - cpuPrev.idle) / total) * 100);
    cpuPrev = now;
  }, 2000);
  cpuTimer.unref?.();
  function systemSnapshot() {
    const total = os.totalmem();
    const free = os.freemem();
    return {
      cpu: Math.max(0, Math.min(100, cpuPercent)),
      cores: os.cpus().length,
      memory: { usedPct: Math.round(((total - free) / total) * 100), totalGb: Number((total / 1024 ** 3).toFixed(1)) },
      load: Number(os.loadavg()[0].toFixed(2)),
      uptime: Math.round(os.uptime()),
      jarvis: { rssMb: Math.round(process.memoryUsage().rss / 1024 ** 2), uptime: Math.round((Date.now() - startedAt) / 1000) },
    };
  }

  // -- server-sent events -----------------------------------------------------
  const forward = (event) => {
    if (!FORWARDED_EVENTS.includes(event.topic)) return;
    const frame = `event: ${event.topic}\ndata: ${JSON.stringify(event.payload)}\n\n`;
    for (const client of clients) client.write(frame);
  };
  jarvis.events.on('*', forward);
  const heartbeat = setInterval(() => {
    for (const client of clients) client.write(': keep-alive\n\n');
  }, 25_000);
  heartbeat.unref?.();

  function sanitizeSession(value) {
    const id = String(value ?? 'default');
    return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : 'default';
  }

  function send(res, status, body, headers = {}) {
    const payload = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
    res.writeHead(status, {
      ...jarvis.security.headers(),
      'content-type': typeof body === 'string' || Buffer.isBuffer(body) ? 'text/plain; charset=utf-8' : 'application/json; charset=utf-8',
      ...headers,
    });
    res.end(payload);
  }

  async function serveStatic(pathname, res) {
    const relative = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
    const file = resolve(publicDir, relative);
    if (file !== publicDir && !file.startsWith(publicDir + sep)) return send(res, 403, { error: 'forbidden' });
    try {
      const data = await readFile(file);
      const type = MIME[extname(file)] ?? 'application/octet-stream';
      return send(res, 200, data, { 'content-type': type, 'cache-control': 'no-cache' });
    } catch {
      return send(res, 404, { error: 'not found' });
    }
  }

  async function onRequest(req, res) {
    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      return send(res, 400, { error: 'bad request' });
    }
    const pathname = url.pathname;
    const isApi = pathname.startsWith('/api/') || pathname === '/calendar.ics';

    try {
      // DNS-rebinding guard: without token auth, only answer for known host names.
      const hostHeader = String(req.headers.host ?? '').toLowerCase().replace(/:\d+$/, '');
      if (!jarvis.security.authRequired && !hosts.has(hostHeader)) throw new HttpError(403, 'unrecognized host');

      // Cross-site request guard for anything that changes state.
      const origin = req.headers.origin;
      if (origin && req.method !== 'GET' && req.method !== 'HEAD') {
        let originHost = null;
        try { originHost = new URL(origin).host.toLowerCase(); } catch { /* malformed origin */ }
        if (originHost !== String(req.headers.host ?? '').toLowerCase()) throw new HttpError(403, 'cross-origin request refused');
      }

      if (!isApi) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'method not allowed');
        return await serveStatic(pathname, res);
      }

      const client = req.socket.remoteAddress ?? 'unknown';
      const limit = jarvis.security.rateLimit(client);
      if (!limit.ok) return send(res, 429, { error: 'too many requests' }, { 'retry-after': String(Math.ceil(limit.resetMs / 1000)) });

      if (pathname === '/api/events' && req.method === 'GET') {
        const auth = jarvis.security.authenticate({ headers: req.headers, url: req.url });
        if (!auth.ok) throw new HttpError(401, 'unauthorized');
        res.writeHead(200, { ...jarvis.security.headers(), 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform', connection: 'keep-alive', 'x-accel-buffering': 'no' });
        res.write('retry: 3000\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return undefined;
      }

      const matches = routes.filter((r) => r.regex.test(pathname));
      if (!matches.length) throw new HttpError(404, 'not found');
      const route = matches.find((r) => r.method === req.method);
      if (!route) throw new HttpError(405, 'method not allowed');
      if (!route.open) {
        const auth = jarvis.security.authenticate({ headers: req.headers, url: req.url });
        if (!auth.ok) throw new HttpError(401, 'unauthorized');
      }
      const match = route.regex.exec(pathname);
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      const body = await readBody(req, { audio: Boolean(route.audio) });
      const result = await route.handler({ params, query: Object.fromEntries(url.searchParams), body, headers: req.headers });
      if (result && typeof result === 'object' && 'status' in result && ('body' in result || 'raw' in result)) {
        if ('raw' in result) return send(res, result.status, Buffer.isBuffer(result.raw) ? result.raw : String(result.raw), result.headers ?? {});
        return send(res, result.status, result.body, result.headers ?? {});
      }
      return send(res, 200, result ?? { ok: true });
    } catch (error) {
      if (error instanceof HttpError) return send(res, error.status, { error: error.message });
      jarvis.logger.error?.('[jarvis] request failed:', error);
      return send(res, 500, { error: 'internal error' });
    }
  }

  const server = createServer((req, res) => {
    onRequest(req, res).catch(() => {
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    });
  });

  return {
    server,
    listen(port = 3000, host = '127.0.0.1') {
      return new Promise((resolveListen, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolveListen(server.address()));
      });
    },
    close() {
      clearInterval(heartbeat);
      clearInterval(cpuTimer);
      jarvis.events.off('*', forward);
      for (const client of clients) client.end();
      clients.clear();
      return new Promise((resolveClose) => server.close(() => resolveClose()));
    },
  };
}
