import { createServer } from 'node:http';
import os from 'node:os';
import { readFile } from 'node:fs/promises';
import { extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AUDIO_TYPES, MAX_AUDIO_BYTES } from '../voice/index.js';
import { buildRoutes, HttpError, sanitizeSession } from './routes.js';

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

  for (const route of buildRoutes(jarvis, { system: () => systemSnapshot(), startedAt })) add(route.method, route.path, route.handler, { open: route.open, audio: route.audio });

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
