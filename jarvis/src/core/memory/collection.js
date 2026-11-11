// Platform-neutral document helpers shared by the file store (Node) and the
// browser store used by the standalone build.
export function newId(prefix = 'id') {
  const uuid = globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `${Date.now().toString(16)}${Math.random().toString(16).slice(2)}`;
  return `${prefix}_${uuid.replace(/-/g, '').slice(0, 12)}`;
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
