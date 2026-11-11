import { nextOccurrence } from './nlu/entities.js';

/**
 * Fires reminders when they come due and reschedules recurring ones. The
 * server forwards `reminder.due` events to the dashboard (notification + voice).
 */
export class Scheduler {
  constructor({ reminders, events, intervalMs = 15_000, now = () => new Date(), logger = console }) {
    this.reminders = reminders;
    this.events = events;
    this.intervalMs = intervalMs;
    this.now = now;
    this.logger = logger;
    this.timer = null;
  }

  start() {
    if (this.timer) return this;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
    return this;
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    const now = this.now();
    const fired = [];
    for (const reminder of this.reminders.find((r) => r.status === 'scheduled')) {
      const due = new Date(reminder.due);
      if (Number.isNaN(due.getTime()) || due > now) continue;
      let patch;
      if (reminder.recurrence) {
        const next = nextOccurrence(due, reminder.recurrence, now);
        patch = next ? { due: next.toISOString(), lastFiredAt: now.toISOString(), fireCount: (reminder.fireCount ?? 0) + 1 } : { status: 'fired', firedAt: now.toISOString() };
      } else {
        patch = { status: 'fired', firedAt: now.toISOString() };
      }
      const updated = this.reminders.update(reminder.id, patch);
      fired.push(updated);
      this.events.publish('reminder.due', { reminder: updated, firedAt: now.toISOString() });
    }
    return fired;
  }

  snooze(id, ms = 10 * 60_000) {
    const reminder = this.reminders.get(id);
    if (!reminder) return null;
    const due = new Date(this.now().getTime() + ms).toISOString();
    return this.reminders.update(id, { status: 'scheduled', due, snoozedAt: this.now().toISOString() });
  }
}
