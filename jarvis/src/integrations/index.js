/**
 * Integration registry: one place that knows every third-party service, what
 * configuration it needs, whether it is connected, and how to test it.
 * Credentials come from environment variables or from the dashboard; values
 * saved through the dashboard live in an encrypted collection and are never
 * returned to the browser.
 */
export class IntegrationRegistry {
  constructor({ store, security, env = process.env }) {
    this.store = store;
    this.security = security;
    this.env = env;
    this.definitions = new Map();
  }

  define(definition) {
    if (!definition?.id) throw new Error('IntegrationRegistry.define: id is required');
    this.definitions.set(definition.id, { fields: [], ...definition });
    return this;
  }

  #saved() {
    const saved = this.store.read('integrations', null);
    return saved && typeof saved === 'object' && !Array.isArray(saved) ? saved : {};
  }

  /** Effective configuration: dashboard values override environment variables. */
  config(id) {
    const definition = this.definitions.get(id);
    if (!definition) return {};
    const saved = this.#saved()[id]?.values ?? {};
    const out = {};
    for (const field of definition.fields) {
      const value = saved[field.key] ?? (field.env ? this.env[field.env] : undefined) ?? field.default;
      if (value !== undefined && value !== '') out[field.key] = value;
    }
    return out;
  }

  isConfigured(id) {
    const definition = this.definitions.get(id);
    if (!definition) return false;
    const config = this.config(id);
    return definition.fields.filter((f) => f.required).every((f) => config[f.key]);
  }

  configure(id, values = {}) {
    const definition = this.definitions.get(id);
    if (!definition) throw new Error(`Unknown integration "${id}"`);
    const saved = this.#saved();
    const current = { ...(saved[id]?.values ?? {}) };
    for (const field of definition.fields) {
      if (!(field.key in values)) continue;
      const value = values[field.key];
      if (value === null || value === '') delete current[field.key];
      else current[field.key] = String(value).trim().slice(0, 2000);
    }
    saved[id] = { values: current, updatedAt: new Date().toISOString() };
    this.store.write('integrations', saved);
    this.security?.audit('integration.configured', { id, fields: Object.keys(values) });
    return this.describe(id);
  }

  describe(id) {
    const definition = this.definitions.get(id);
    if (!definition) return null;
    const config = this.config(id);
    const saved = this.#saved()[id]?.values ?? {};
    return {
      id,
      name: definition.name,
      category: definition.category,
      description: definition.description,
      builtIn: definition.fields.every((f) => !f.required),
      configured: this.isConfigured(id),
      docs: definition.docs ?? null,
      fields: definition.fields.map((f) => ({
        key: f.key,
        label: f.label,
        secret: Boolean(f.secret),
        required: Boolean(f.required),
        placeholder: f.placeholder ?? '',
        set: Boolean(config[f.key]),
        source: saved[f.key] ? 'dashboard' : f.env && this.env[f.env] ? 'environment' : config[f.key] ? 'default' : null,
        value: f.secret ? null : config[f.key] ?? null,
      })),
    };
  }

  list() {
    return [...this.definitions.keys()].map((id) => this.describe(id));
  }

  async test(id) {
    const definition = this.definitions.get(id);
    if (!definition) return { ok: false, message: 'Unknown integration' };
    if (!this.isConfigured(id)) return { ok: false, message: 'Not configured yet' };
    if (!definition.test) return { ok: true, message: 'Configured' };
    const started = Date.now();
    try {
      const message = await definition.test(this.config(id));
      return { ok: true, message: message || 'Connected', ms: Date.now() - started };
    } catch (error) {
      return { ok: false, message: error.message, ms: Date.now() - started };
    }
  }

  remove(id) {
    const saved = this.#saved();
    delete saved[id];
    this.store.write('integrations', saved);
  }
}
