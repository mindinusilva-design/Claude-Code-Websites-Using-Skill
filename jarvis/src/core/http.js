/** Small fetch helpers with timeouts, used by every integration. */
const USER_AGENT = 'JARVIS/0.1 (personal assistant; +https://github.com/mindinusilva-design/Claude-Code-Websites-Using-Skill)';

export async function fetchWithTimeout(url, { timeoutMs = 8000, headers = {}, ...init } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const base = typeof window === 'undefined' ? { 'user-agent': USER_AGENT } : {};
    return await fetch(url, { ...init, headers: { ...base, ...headers }, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

export async function fetchJson(url, init = {}) {
  const response = await fetchWithTimeout(url, { ...init, headers: { accept: 'application/json', ...(init.headers ?? {}) } });
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    throw error;
  }
  return response.json();
}

export async function fetchText(url, init = {}) {
  const response = await fetchWithTimeout(url, init);
  if (!response.ok) {
    const error = new Error(`HTTP ${response.status} from ${new URL(url).host}`);
    error.status = response.status;
    throw error;
  }
  return response.text();
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#x27': "'", '#8217': '’', '#8216': '‘', '#8220': '“', '#8221': '”', '#8211': '–', '#8212': '—', '#8230': '…', '#160': ' ' };

export function decodeEntities(text) {
  return String(text ?? '').replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, code) => {
    if (code in ENTITIES) return ENTITIES[code];
    if (/^#x/i.test(code)) return String.fromCodePoint(parseInt(code.slice(2), 16));
    if (/^#\d+$/.test(code)) return String.fromCodePoint(Number(code.slice(1)));
    return m;
  });
}

/** Strip an HTML document down to readable text (scripts, styles, nav and tags removed). */
export function htmlToText(html) {
  let text = String(html ?? '');
  text = text.replace(/<!--[\s\S]*?-->/g, ' ');
  text = text.replace(/<(script|style|noscript|svg|nav|footer|header|aside|form|iframe)\b[\s\S]*?<\/\1>/gi, ' ');
  text = text.replace(/<br\s*\/?>|<\/(p|div|li|h[1-6]|tr|section|article|blockquote)>/gi, '\n');
  text = text.replace(/<[^>]+>/g, ' ');
  text = decodeEntities(text);
  return text.replace(/[ \t\r\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').replace(/\n{2,}/g, '\n\n').trim();
}

export function extractTitle(html) {
  const og = /<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i.exec(html);
  if (og) return decodeEntities(og[1]).trim();
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return title ? decodeEntities(title[1]).replace(/\s+/g, ' ').trim() : '';
}

export function isHttpUrl(value) {
  try {
    const u = new URL(String(value));
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** Reject URLs that point at private networks (SSRF guard for user-supplied links). */
export function isPublicUrl(value) {
  if (!isHttpUrl(value)) return false;
  const host = new URL(value).hostname.toLowerCase();
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) return false;
  if (/^(127\.|10\.|0\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(host)) return false;
  if (host === '::1' || host.startsWith('[')) return false;
  return true;
}
