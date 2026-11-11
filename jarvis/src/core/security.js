import { hashToken, safeEqual } from './memory/crypto.js';

const SECRET_KEY = /(token|secret|password|passwd|api[_-]?key|authorization|credential)/i;

/**
 * Security & privacy controls: optional bearer-token auth, per-client rate
 * limiting, an audit trail with secrets redacted, and the data-subject
 * controls (export / delete) that the privacy skill and REST API expose.
 */
export class SecurityManager {
  constructor({ store, token = process.env.JARVIS_API_TOKEN || null, rateLimit = { windowMs: 60_000, max: 120 }, logger = console } = {}) {
    this.store = store;
    this.tokenHash = token ? hashToken(token) : null;
    this.rateLimitConfig = rateLimit;
    this.buckets = new Map();
    this.logger = logger;
    this.audit_ = store.collection('audit');
  }

  get authRequired() {
    return Boolean(this.tokenHash);
  }

  /** Accepts Authorization: Bearer, X-Jarvis-Token or ?token= (for EventSource / ICS clients). */
  authenticate({ headers = {}, url = '' } = {}) {
    if (!this.tokenHash) return { ok: true, mode: 'open' };
    let presented = null;
    const auth = headers.authorization ?? headers.Authorization;
    if (auth && /^bearer\s+/i.test(auth)) presented = auth.replace(/^bearer\s+/i, '').trim();
    if (!presented && headers['x-jarvis-token']) presented = headers['x-jarvis-token'];
    if (!presented && url.includes('token=')) {
      try {
        presented = new URL(url, 'http://localhost').searchParams.get('token');
      } catch { presented = null; }
    }
    if (!presented) return { ok: false, reason: 'missing token' };
    return safeEqual(hashToken(presented), this.tokenHash) ? { ok: true, mode: 'token' } : { ok: false, reason: 'invalid token' };
  }

  /** Token bucket per client key. */
  rateLimit(key = 'anonymous') {
    const { windowMs, max } = this.rateLimitConfig;
    const now = Date.now();
    let bucket = this.buckets.get(key);
    if (!bucket || now - bucket.start > windowMs) {
      bucket = { start: now, count: 0 };
      this.buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (this.buckets.size > 10_000) this.buckets.clear();
    return { ok: bucket.count <= max, remaining: Math.max(0, max - bucket.count), resetMs: windowMs - (now - bucket.start) };
  }

  /** Deep-copies an object with any secret-looking field replaced. */
  redact(value) {
    if (Array.isArray(value)) return value.map((v) => this.redact(v));
    if (value && typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) out[k] = SECRET_KEY.test(k) && v ? '[redacted]' : this.redact(v);
      return out;
    }
    return value;
  }

  audit(action, details = {}, actor = 'user') {
    const entry = this.audit_.insert({ action, actor, details: this.redact(details) });
    const all = this.audit_.all();
    if (all.length > 1000) this.audit_.replace(all.slice(-1000));
    return entry;
  }

  auditLog(limit = 100) {
    return this.audit_.all().slice(-limit).reverse();
  }

  validateText(text, { max = 2000 } = {}) {
    if (typeof text !== 'string') return { ok: false, reason: 'text must be a string' };
    const trimmed = text.trim();
    if (!trimmed) return { ok: false, reason: 'text is empty' };
    if (trimmed.length > max) return { ok: false, reason: `text is longer than ${max} characters` };
    return { ok: true, text: trimmed };
  }

  headers() {
    return {
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Permissions-Policy': 'microphone=(self), geolocation=(self), camera=()',
      'Content-Security-Policy': "default-src 'self'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; font-src 'self'",
      'Cache-Control': 'no-store',
    };
  }
}
