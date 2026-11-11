// Minimal EventEmitter for the standalone build (replaces node:events).
export class EventEmitter {
  constructor() { this._listeners = new Map(); }
  setMaxListeners() { return this; }
  on(topic, fn) {
    if (!this._listeners.has(topic)) this._listeners.set(topic, []);
    this._listeners.get(topic).push(fn);
    return this;
  }
  addListener(topic, fn) { return this.on(topic, fn); }
  once(topic, fn) {
    const wrapper = (...args) => { this.off(topic, wrapper); fn(...args); };
    return this.on(topic, wrapper);
  }
  off(topic, fn) {
    const list = this._listeners.get(topic);
    if (list) this._listeners.set(topic, list.filter((x) => x !== fn));
    return this;
  }
  removeListener(topic, fn) { return this.off(topic, fn); }
  emit(topic, ...args) {
    const list = this._listeners.get(topic);
    if (!list?.length) return false;
    for (const fn of [...list]) {
      try { fn(...args); } catch (error) { console.error(`[jarvis] listener for "${topic}" failed`, error); }
    }
    return true;
  }
  listenerCount(topic) { return this._listeners.get(topic)?.length ?? 0; }
}
export default { EventEmitter };
