import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCipherSuite, generateSalt } from './crypto.js';

/**
 * Local-first JSON document store. Each named collection is one file in the
 * data directory. Collections listed in `encrypted` are written as
 * AES-256-GCM blobs. With `dir: null` the store lives in memory only (tests,
 * incognito mode).
 */
export class Store {
  constructor({ dir = null, secret = null, encrypted = [] } = {}) {
    this.dir = dir;
    this.cache = new Map();
    this.encrypted = new Set(encrypted);
    this.cipher = null;
    if (dir) mkdirSync(dir, { recursive: true });
    if (secret) this.cipher = createCipherSuite({ secret, salt: this.#loadSalt() });
    if (this.encrypted.size && !this.cipher) {
      throw new Error('Store: encrypted collections require a secret (JARVIS_SECRET)');
    }
  }

  #loadSalt() {
    if (!this.dir) return generateSalt();
    const saltPath = join(this.dir, '.salt');
    if (existsSync(saltPath)) return Buffer.from(readFileSync(saltPath, 'utf8').trim(), 'base64');
    const salt = generateSalt();
    writeFileSync(saltPath, salt.toString('base64'), { mode: 0o600 });
    return salt;
  }

  #path(name) {
    if (!/^[a-z0-9_-]+$/i.test(name)) throw new Error(`Store: invalid collection name "${name}"`);
    return join(this.dir, `${name}.json`);
  }

  read(name, fallback = null) {
    if (this.cache.has(name)) return this.cache.get(name);
    let value = fallback;
    if (this.dir) {
      const path = this.#path(name);
      if (existsSync(path)) {
        const raw = readFileSync(path, 'utf8');
        if (raw.trim()) {
          const parsed = JSON.parse(raw);
          value = this.cipher?.isEncrypted(parsed) ? this.cipher.decrypt(parsed) : parsed;
        }
      }
    }
    this.cache.set(name, value);
    return value;
  }

  write(name, value) {
    this.cache.set(name, value);
    if (!this.dir) return value;
    const path = this.#path(name);
    const payload = this.encrypted.has(name) ? this.cipher.encrypt(value) : value;
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
    renameSync(tmp, path);
    return value;
  }

  delete(name) {
    this.cache.delete(name);
    if (this.dir) {
      const path = this.#path(name);
      if (existsSync(path)) rmSync(path);
    }
  }

  names() {
    const names = new Set(this.cache.keys());
    if (this.dir) {
      for (const file of readdirSync(this.dir)) {
        if (file.endsWith('.json')) names.add(file.slice(0, -5));
      }
    }
    return [...names];
  }

  /** Remove every collection. Used by the "forget everything" privacy control. */
  wipe() {
    for (const name of this.names()) this.delete(name);
  }

  collection(name) {
    return new Collection(this, name);
  }
}

export function newId(prefix = 'id') {
  return `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
}

/** Array-of-documents helper over a Store collection. */
export class Collection {
  constructor(store, name) {
    this.store = store;
    this.name = name;
  }

  all() {
    const docs = this.store.read(this.name, []);
    return Array.isArray(docs) ? docs : [];
  }

  find(predicate) {
    return this.all().filter(predicate);
  }

  get(id) {
    return this.all().find((doc) => doc.id === id) ?? null;
  }

  insert(doc) {
    const record = { id: newId(this.name.slice(0, 4)), createdAt: new Date().toISOString(), ...doc };
    this.store.write(this.name, [...this.all(), record]);
    return record;
  }

  update(id, patch) {
    let updated = null;
    const docs = this.all().map((doc) => {
      if (doc.id !== id) return doc;
      updated = { ...doc, ...(typeof patch === 'function' ? patch(doc) : patch), updatedAt: new Date().toISOString() };
      return updated;
    });
    if (updated) this.store.write(this.name, docs);
    return updated;
  }

  remove(id) {
    const docs = this.all();
    const next = docs.filter((doc) => doc.id !== id);
    if (next.length !== docs.length) this.store.write(this.name, next);
    return next.length !== docs.length;
  }

  replace(docs) {
    this.store.write(this.name, docs);
    return docs;
  }

  clear() {
    this.store.write(this.name, []);
  }
}
