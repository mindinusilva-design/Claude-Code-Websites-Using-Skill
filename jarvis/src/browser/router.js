import { buildRoutes, HttpError } from '../server/routes.js';

function compile(path) {
  const keys = [];
  const source = path.replace(/:[a-zA-Z]+/g, (key) => { keys.push(key.slice(1)); return '([^/]+)'; });
  return { regex: new RegExp(`^${source}$`), keys };
}

const clone = (value) => {
  try { return structuredClone(value); } catch { return JSON.parse(JSON.stringify(value)); }
};

/**
 * The same API the Node server exposes, answered in-process. The dashboard's
 * api() calls land here instead of going over HTTP.
 */
export function createRouter(jarvis, { system, store }) {
  const routes = buildRoutes(jarvis, { system }).map((r) => ({ ...r, ...compile(r.path) }));

  // Browser-only: protect the local data with a passphrase.
  routes.push({
    method: 'POST', ...compile('/api/privacy/passphrase'),
    handler: async (req) => {
      const passphrase = req.body?.passphrase ?? null;
      if (passphrase !== null && typeof passphrase !== 'string') throw new HttpError(400, 'passphrase must be a string or null');
      try {
        await store.setPassphrase(passphrase);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      jarvis.security.audit(passphrase ? 'privacy.passphrase.set' : 'privacy.passphrase.removed', {});
      return { encrypted: store.encrypted };
    },
  });

  return {
    async handle({ method = 'GET', path, body = null, headers = {} }) {
      const url = new URL(path, 'http://jarvis.local');
      const matches = routes.filter((r) => r.regex.test(url.pathname));
      if (!matches.length) return { status: 404, body: { error: 'not found' } };
      const route = matches.find((r) => r.method === method);
      if (!route) return { status: 405, body: { error: 'method not allowed' } };
      const match = route.regex.exec(url.pathname);
      const params = Object.fromEntries(route.keys.map((key, i) => [key, decodeURIComponent(match[i + 1])]));
      const lowerHeaders = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
      try {
        const result = await route.handler({ params, query: Object.fromEntries(url.searchParams), body: body == null ? null : clone(body), headers: lowerHeaders });
        if (result && typeof result === 'object' && 'status' in result && ('body' in result || 'raw' in result)) {
          return 'raw' in result ? { status: result.status, headers: result.headers ?? {}, raw: result.raw } : { status: result.status, headers: result.headers ?? {}, body: clone(result.body) };
        }
        return { status: 200, body: clone(result ?? { ok: true }) };
      } catch (error) {
        if (error instanceof HttpError) return { status: error.status, body: { error: error.message } };
        console.error('[jarvis] request failed', error);
        return { status: 500, body: { error: error.message || 'internal error' } };
      }
    },
  };
}
