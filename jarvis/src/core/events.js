import { EventEmitter } from 'node:events';

/**
 * Process-wide event bus. Skills publish domain events (reminder.due,
 * device.changed, task.created ...) and the server forwards them to the
 * dashboard over Server-Sent Events.
 */
export class EventBus extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(200);
  }

  publish(topic, payload = {}) {
    const event = { topic, payload, at: new Date().toISOString() };
    this.emit(topic, payload, event);
    this.emit('*', event);
    return event;
  }

  subscribe(topic, listener) {
    this.on(topic, listener);
    return () => this.off(topic, listener);
  }
}
