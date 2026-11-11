import { Collection, newId } from '../core/memory/collection.js';

const PREFIX = 'jarvis:';
const LOCK = `${PREFIX}.lock`;
const ITERATIONS = 310_000;
const enc = new TextEncoder();
const dec = new TextDecoder();
const toB64 = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes)));
const fromB64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));

async function deriveKey(passphrase, salt) {
  const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', salt, iterations: ITERATIONS, hash: 'SHA-256' }, material, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}
async function seal(key, text) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text));
  return JSON.stringify({ v: 1, iv: toB64(iv), data: toB64(data) });
}
async function open(key, blob) {
  const { iv, data } = JSON.parse(blob);
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(iv) }, key, fromB64(data));
  return dec.decode(plain);
}

/** In-memory fallback when localStorage is unavailable (private windows, blocked storage). */
export class MemoryStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(k, String(v)); }
  removeItem(k) { this.map.delete(k); }
}

/**
 * The standalone page's store: same interface as the Node file store
 * (read / write / delete / names / wipe / collection), kept in localStorage.
 * With a passphrase, every collection is sealed with AES-256-GCM using a key
 * derived by PBKDF2 (310,000 rounds); without one, data is stored as JSON.
 * Reads are synchronous from memory; encrypted writes finish asynchronously.
 */
export class BrowserStore {
  constructor(storage) {
    this.storage = storage;
    this.cache = new Map();
    this.key = null;
    this.chains = new Map();
    this.onError = () => {};
    this.persistent = !(storage instanceof MemoryStorage);
  }

  static create() {
    try {
      const probe = `${PREFIX}.probe`;
      localStorage.setItem(probe, '1');
      localStorage.removeItem(probe);
      return new BrowserStore(localStorage);
    } catch {
      return new BrowserStore(new MemoryStorage());
    }
  }

  get encrypted() { return Boolean(this.key); }
  isLocked() { return this.storage.getItem(LOCK) != null && !this.key; }

  #dataKeys() {
    const keys = [];
    for (let i = 0; i < this.storage.length; i += 1) {
      const k = this.storage.key(i);
      if (k?.startsWith(PREFIX) && !k.startsWith(`${PREFIX}.`)) keys.push(k);
    }
    return keys;
  }

  /** Load unencrypted data. */
  async load() {
    for (const k of this.#dataKeys()) {
      try { this.cache.set(k.slice(PREFIX.length), JSON.parse(this.storage.getItem(k))); } catch { /* skip corrupt entries */ }
    }
    return this;
  }

  /** Unlock encrypted data; throws if the passphrase is wrong. */
  async unlock(passphrase) {
    const lock = JSON.parse(this.storage.getItem(LOCK));
    const key = await deriveKey(passphrase, fromB64(lock.salt));
    try {
      if (await open(key, lock.check) !== 'jarvis') throw new Error('mismatch');
    } catch {
      throw new Error('That passphrase is not correct.');
    }
    this.key = key;
    for (const k of this.#dataKeys()) {
      try { this.cache.set(k.slice(PREFIX.length), JSON.parse(await open(key, this.storage.getItem(k)))); } catch { /* skip entries that fail to decrypt */ }
    }
    return this;
  }

  read(name, fallback = null) {
    return this.cache.has(name) ? this.cache.get(name) : fallback;
  }

  write(name, value) {
    this.cache.set(name, value);
    this.#persist(name, JSON.stringify(value));
    return value;
  }

  #persist(name, text) {
    const storageKey = PREFIX + name;
    const key = this.key;
    const previous = this.chains.get(name) ?? Promise.resolve();
    const next = previous
      .then(async () => this.storage.setItem(storageKey, key ? await seal(key, text) : text))
      .catch((error) => this.onError(error));
    this.chains.set(name, next);
  }

  /** Resolves when every pending write has reached storage. */
  flush() { return Promise.all([...this.chains.values()]); }

  delete(name) {
    this.cache.delete(name);
    this.storage.removeItem(PREFIX + name);
  }

  names() { return [...this.cache.keys()]; }

  wipe() {
    for (const k of this.#dataKeys()) this.storage.removeItem(k);
    this.cache.clear();
  }

  collection(name) { return new Collection(this, name); }

  /** Turn encryption on, change the passphrase, or (with null) turn it off. */
  async setPassphrase(passphrase) {
    await this.flush();
    if (passphrase) {
      if (String(passphrase).length < 8) throw new Error('Use a passphrase of at least 8 characters.');
      const salt = crypto.getRandomValues(new Uint8Array(16));
      this.key = await deriveKey(passphrase, salt);
      this.storage.setItem(LOCK, JSON.stringify({ v: 1, salt: toB64(salt), check: await seal(this.key, 'jarvis') }));
    } else {
      this.key = null;
      this.storage.removeItem(LOCK);
    }
    for (const [name, value] of this.cache) this.#persist(name, JSON.stringify(value));
    await this.flush();
  }

  /** Forgotten passphrase: remove everything, including the lock. */
  eraseAll() {
    for (const k of this.#dataKeys()) this.storage.removeItem(k);
    this.storage.removeItem(LOCK);
    this.cache.clear();
    this.key = null;
  }
}

export { BrowserStore as Store, Collection, newId };
