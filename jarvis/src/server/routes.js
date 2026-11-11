// API routes shared by the HTTP server (src/server/app.js) and the in-page
// router of the standalone build (src/browser/router.js). Handlers receive
// { params, query, body, headers } and return a JSON-able value, or
// { status, body } / { status, headers, raw } for anything else.
import { VERSION } from '../core/jarvis.js';
import { VoiceError } from '../voice/index.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const PROFILE_KEYS = ['name', 'location', 'units', 'voice', 'newsTopics', 'retentionDays', 'incognito', 'wakeWord', 'confirmSensitive'];

export function sanitizeSession(value) {
  const id = String(value ?? 'default');
  return /^[a-zA-Z0-9_-]{1,64}$/.test(id) ? id : 'default';
}

/**
 * @param {import('../core/jarvis.js').Jarvis} jarvis
 * @param {{ system: () => object, startedAt?: number }} host
 * @returns {Array<{ method: string, path: string, handler: Function, open?: boolean, audio?: boolean }>}
 */
export function buildRoutes(jarvis, { system, startedAt = Date.now() }) {
  const routes = [];
  const add = (method, path, handler, options = {}) => routes.push({ method, path, handler, ...options });

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
  add('GET', '/api/system', () => system());

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

  return routes;
}
