/**
 * Conversation context: a bounded memory of recent turns plus the entities
 * they mentioned, so follow-ups like "turn it off", "and the bedroom?" or
 * "what about tomorrow?" resolve without repeating everything.
 */
export class ConversationContext {
  constructor({ sessionId, maxTurns = 12 } = {}) {
    this.sessionId = sessionId;
    this.maxTurns = maxTurns;
    this.turns = [];
    this.entities = {};
    this.lastIntent = null;
    this.pending = null; // { ask, intent, slots, slot } awaiting clarification
    this.updatedAt = Date.now();
  }

  remember(turn) {
    this.turns.push({ at: new Date().toISOString(), ...turn });
    if (this.turns.length > this.maxTurns * 2) this.turns.splice(0, this.turns.length - this.maxTurns * 2);
    this.updatedAt = Date.now();
  }

  /** Record entities an intent handler touched (devices, rooms, tasks, locations, topics). */
  track(entities = {}) {
    for (const [key, value] of Object.entries(entities)) {
      if (value === undefined || value === null || value === '') continue;
      this.entities[key] = value;
    }
    this.updatedAt = Date.now();
  }

  setPending(pending) {
    this.pending = pending ? { ...pending, at: Date.now() } : null;
  }

  takePending() {
    const p = this.pending;
    this.pending = null;
    return p;
  }

  /**
   * Fill missing slots from context. Returns a new slots object.
   * "turn it off" -> device from entities.lastDevice
   * "and the bedroom" -> intent/action from lastIntent with a new room
   */
  resolve(intent, slots = {}) {
    const out = { ...slots };
    if (intent?.startsWith('smarthome.')) {
      if (!out.devices?.length && !out.room && !out.target && out.pronoun) {
        const switchable = ['smarthome.power', 'smarthome.level', 'smarthome.color'].includes(intent);
        const remembered = switchable && this.entities.lastSwitchable?.length ? this.entities.lastSwitchable : this.entities.lastDevices;
        if (remembered?.length) out.devices = remembered;
        else if (this.entities.lastRoom) out.room = this.entities.lastRoom;
      }
      if (!out.room && !out.devices?.length && this.entities.lastRoom && out.inheritRoom) out.room = this.entities.lastRoom;
    }
    if (intent === 'weather.forecast' && !out.location && this.entities.lastLocation) out.location = this.entities.lastLocation;
    if (intent === 'tasks.complete' && !out.title && this.entities.lastTask) out.title = this.entities.lastTask;
    return out;
  }

  /** Short plain-text summary that is injected into the language model prompt. */
  summary() {
    const bits = [];
    if (this.entities.lastDevices?.length) bits.push(`last devices mentioned: ${this.entities.lastDevices.join(', ')}`);
    if (this.entities.lastRoom) bits.push(`last room: ${this.entities.lastRoom}`);
    if (this.entities.lastLocation) bits.push(`last location: ${this.entities.lastLocation}`);
    if (this.entities.lastTask) bits.push(`last task: ${this.entities.lastTask}`);
    if (this.entities.lastTopic) bits.push(`last topic: ${this.entities.lastTopic}`);
    if (this.lastIntent) bits.push(`last intent: ${this.lastIntent}`);
    return bits.join('; ');
  }

  /** Message history in Claude's alternating user/assistant format. */
  history(limit = this.maxTurns) {
    const messages = [];
    for (const turn of this.turns.slice(-limit * 2)) {
      if (!turn.text) continue;
      const role = turn.role === 'assistant' ? 'assistant' : 'user';
      if (messages.length && messages[messages.length - 1].role === role) {
        messages[messages.length - 1].content += `\n${turn.text}`;
      } else {
        messages.push({ role, content: turn.text });
      }
    }
    while (messages.length && messages[0].role !== 'user') messages.shift();
    return messages;
  }

  clear() {
    this.turns = [];
    this.entities = {};
    this.lastIntent = null;
    this.pending = null;
  }
}

/** In-memory registry of contexts keyed by session, with idle expiry. */
export class ContextManager {
  constructor({ ttlMs = 2 * 60 * 60 * 1000, maxTurns = 12 } = {}) {
    this.ttlMs = ttlMs;
    this.maxTurns = maxTurns;
    this.contexts = new Map();
  }

  get(sessionId = 'default') {
    this.sweep();
    let ctx = this.contexts.get(sessionId);
    if (!ctx) {
      ctx = new ConversationContext({ sessionId, maxTurns: this.maxTurns });
      this.contexts.set(sessionId, ctx);
    }
    return ctx;
  }

  sweep() {
    const now = Date.now();
    for (const [id, ctx] of this.contexts) if (now - ctx.updatedAt > this.ttlMs) this.contexts.delete(id);
  }

  clearAll() {
    this.contexts.clear();
  }
}
