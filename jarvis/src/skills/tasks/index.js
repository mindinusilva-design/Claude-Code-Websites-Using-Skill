import { parseDateTime, parseDuration, formatDateTime, describeRecurrence } from '../../core/nlu/entities.js';
import { createLocalCalendar, createGoogleCalendar, toICS } from './calendar.js';

const DAY = 86_400_000;
const startOfDay = (d) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d) => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const cap = (t) => (t ? t[0].toUpperCase() + t.slice(1) : t);

export function cleanTitle(text) {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  t = t.replace(/^(?:to|that i need to|that i should|that i have to|that|about|for me to|me to)\s+/i, '');
  t = t.replace(/\s+(?:by|before|at|on|due|for)$/i, '');
  t = t.replace(/^["'“]+|["'”]+$/g, '').replace(/[.!?,;:]+$/g, '').trim();
  return cap(t);
}

/** Accepts an ISO timestamp or natural language ("tomorrow at 9"). */
export function resolveWhen(value, now, options = {}) {
  if (!value) return null;
  if (value instanceof Date) return { date: value, recurrence: null, hasTime: true };
  const text = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) {
    const date = new Date(text);
    if (!Number.isNaN(date.getTime())) return { date, recurrence: null, hasTime: true };
  }
  return parseDateTime(text, { now, ...options });
}

function tokens(text) {
  return String(text ?? '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((t) => t && !['the', 'a', 'an', 'my', 'to', 'task', 'reminder', 'meeting', 'with', 'about', 'for'].includes(t));
}

/** Best fuzzy match of `query` against items[key]. */
export function findByText(items, query, key = 'title') {
  const q = tokens(query);
  if (!q.length) return null;
  let best = null;
  let bestScore = 0;
  for (const item of items) {
    const hay = tokens(item[key]);
    const hits = q.filter((t) => hay.some((h) => h === t || h.startsWith(t) || t.startsWith(h))).length;
    const score = hits / q.length;
    if (score > bestScore) { best = item; bestScore = score; }
  }
  return bestScore >= 0.5 ? best : null;
}

export function createTasksSkill() {
  let tasks; let reminders; let calendars; let local;

  const taskView = (t, now) => ({
    id: t.id,
    title: t.title,
    due: t.due ?? null,
    dueText: t.due ? formatDateTime(t.due, { now }) : null,
    priority: t.priority ?? 'normal',
    status: t.status,
    overdue: Boolean(t.due && t.status === 'open' && new Date(t.due) < now),
  });
  const reminderView = (r, now) => ({ id: r.id, text: r.text, due: r.due, dueText: formatDateTime(r.due, { now }), recurrence: r.recurrence ?? null, recurrenceText: describeRecurrence(r.recurrence), status: r.status });
  const eventView = (e, now) => ({
    id: e.id, title: e.title, start: e.start, end: e.end, location: e.location ?? null, source: e.source ?? 'local',
    whenText: `${formatDateTime(e.start, { now })} to ${new Date(e.end).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`,
  });

  const sortTasks = (list, now) => list.slice().sort((a, b) => {
    const ao = a.due && new Date(a.due) < now ? 0 : 1;
    const bo = b.due && new Date(b.due) < now ? 0 : 1;
    if (ao !== bo) return ao - bo;
    const pr = { high: 0, normal: 1, low: 2 };
    if (a.due && b.due) return new Date(a.due) - new Date(b.due);
    if (a.due || b.due) return a.due ? -1 : 1;
    if ((pr[a.priority] ?? 1) !== (pr[b.priority] ?? 1)) return (pr[a.priority] ?? 1) - (pr[b.priority] ?? 1);
    return new Date(a.createdAt) - new Date(b.createdAt);
  });

  async function listEvents(range) {
    const all = [];
    for (const calendar of calendars) {
      try {
        all.push(...(await calendar.list(range)));
      } catch { /* a remote calendar being down never hides local events */ }
    }
    return all.sort((a, b) => new Date(a.start) - new Date(b.start));
  }

  // -- tasks ------------------------------------------------------------------
  async function addTask(slots, ctx) {
    const now = ctx.now();
    let raw = slots.title ?? slots.raw ?? '';
    let priority = slots.priority ?? 'normal';
    if (/\b(urgent(?:ly)?|asap|important|high[- ]priority|top priority|critical)\b/i.test(raw)) priority = 'high';
    else if (/\blow[- ]priority\b/i.test(raw)) priority = 'low';
    raw = raw.replace(/\b(?:it is |it's |this is |that is )?(urgent(?:ly)?|asap|important|(?:high|low|top)[- ]priority|critical)\b/gi, ' ').replace(/\s+,/g, ',');
    let due = null;
    let title = raw;
    const when = slots.due ? resolveWhen(slots.due, now) : parseDateTime(raw, { now });
    if (when) {
      due = when.date.toISOString();
      if (!slots.due) title = when.remainder;
    }
    title = cleanTitle(title);
    if (!title) return { text: 'What should the task be?', pending: { intent: 'tasks.add', slots: { ...slots, raw: undefined }, slot: 'title' } };
    const task = tasks.insert({ title, due, priority, status: 'open' });
    ctx.events.publish('task.changed', { task, action: 'created' });
    const bits = [`Added "${task.title}" to your tasks`];
    if (due) bits.push(`due ${formatDateTime(due, { now })}`);
    if (priority === 'high') bits.push('marked high priority');
    return { text: `${bits.join(', ')}.`, cards: [{ type: 'tasks', title: 'New task', items: [taskView(task, now)] }], track: { lastTask: task.title }, slots: { title: task.title } };
  }

  async function listTasks(slots, ctx) {
    const now = ctx.now();
    const filter = slots.filter ?? 'open';
    const all = tasks.all();
    let items;
    let label;
    if (filter === 'done') { items = all.filter((t) => t.status === 'done').slice(-10).reverse(); label = 'completed tasks'; }
    else if (filter === 'overdue') { items = all.filter((t) => t.status === 'open' && t.due && new Date(t.due) < now); label = 'overdue tasks'; }
    else if (filter === 'today') { items = all.filter((t) => t.status === 'open' && t.due && new Date(t.due) <= endOfDay(now)); label = 'tasks due today'; }
    else if (filter === 'tomorrow') { const d = new Date(now.getTime() + DAY); items = all.filter((t) => t.status === 'open' && t.due && new Date(t.due) >= startOfDay(d) && new Date(t.due) <= endOfDay(d)); label = 'tasks due tomorrow'; }
    else if (filter === 'week') { items = all.filter((t) => t.status === 'open' && t.due && new Date(t.due) <= new Date(now.getTime() + 7 * DAY)); label = 'tasks due this week'; }
    else { items = all.filter((t) => t.status === 'open'); label = 'open tasks'; }
    items = filter === 'done' ? items : sortTasks(items, now);
    if (!items.length) return { text: filter === 'open' ? 'Your task list is empty. Nothing to do!' : `You have no ${label}.`, cards: [] };
    const spoken = items.slice(0, 5).map((t, i) => `${i + 1}. ${t.title}${t.due ? ` (${new Date(t.due) < now && t.status === 'open' ? 'overdue, was due' : 'due'} ${formatDateTime(t.due, { now })})` : ''}`);
    const more = items.length > 5 ? ` And ${items.length - 5} more.` : '';
    return {
      text: `You have ${items.length} ${items.length === 1 ? label.replace(/tasks/, 'task') : label}: ${spoken.join(' ')}${more}`,
      cards: [{ type: 'tasks', title: cap(label), items: items.map((t) => taskView(t, now)) }],
      track: { lastTask: items[0].title },
    };
  }

  async function completeTask(slots, ctx) {
    const now = ctx.now();
    const open = tasks.find((t) => t.status === 'open');
    const query = slots.title && !/^(it|that|this|that one|the task)$/i.test(slots.title) ? slots.title : ctx.session?.entities?.lastTask;
    if (!query) return { text: 'Which task did you finish?', pending: { intent: 'tasks.complete', slots: {}, slot: 'title' } };
    const task = findByText(open, query);
    if (!task) return { text: `I couldn't find an open task matching "${query}".` };
    const updated = tasks.update(task.id, { status: 'done', completedAt: now.toISOString() });
    ctx.events.publish('task.changed', { task: updated, action: 'completed' });
    const left = open.length - 1;
    return { text: `Nice work. I've marked "${updated.title}" as done. ${left ? `${left} ${left === 1 ? 'task' : 'tasks'} left.` : 'Your list is clear!'}`, cards: [{ type: 'tasks', title: 'Completed', items: [taskView(updated, now)] }], track: { lastTask: updated.title } };
  }

  async function deleteTask(slots, ctx) {
    const query = slots.title && !/^(it|that|this)$/i.test(slots.title) ? slots.title : ctx.session?.entities?.lastTask;
    const task = query ? findByText(tasks.all(), query) : null;
    if (!task) return { text: `I couldn't find a task matching "${query ?? 'that'}".` };
    tasks.remove(task.id);
    ctx.events.publish('task.changed', { task, action: 'deleted' });
    return { text: `Deleted the task "${task.title}".` };
  }

  // -- reminders --------------------------------------------------------------
  async function setReminder(slots, ctx) {
    const now = ctx.now();
    let text = slots.text ?? null;
    let when = null;
    if (slots.timer) {
      const duration = parseDuration(slots.raw ?? '');
      if (!duration) return { text: 'How long should the timer run?', pending: { intent: 'reminders.set', slots: { timer: true }, slot: 'raw' } };
      when = { date: new Date(now.getTime() + duration.ms), recurrence: null };
      text = `Timer (${duration.matched})`;
    } else {
      const raw = slots.raw ?? '';
      const preferMorning = Boolean(slots.wake);
      if (slots.when) when = resolveWhen(slots.when, now, { preferMorning });
      const parsed = parseDateTime(raw, { now, preferMorning });
      if (!when && parsed) when = parsed;
      if (!text) text = cleanTitle(parsed ? parsed.remainder : raw);
      if (slots.wake && !text) text = 'Wake up';
      if (!text) text = 'Reminder';
      if (!when) {
        return { text: `When should I remind you${text !== 'Reminder' ? ` to ${text.charAt(0).toLowerCase()}${text.slice(1)}` : ''}?`, pending: { intent: 'reminders.set', slots: { ...slots, text, raw: '' }, slot: 'when' } };
      }
    }
    const recurrence = slots.recurrence ?? when.recurrence ?? null;
    const reminder = reminders.insert({ text, due: when.date.toISOString(), recurrence, status: 'scheduled' });
    ctx.events.publish('reminder.changed', { reminder, action: 'created' });
    const rec = recurrence ? `, repeating ${describeRecurrence(recurrence)}` : '';
    const phrase = slots.timer ? `Timer set. I'll let you know ${formatDateTime(reminder.due, { now })}.` : `Got it. I'll remind you to ${text.charAt(0).toLowerCase()}${text.slice(1)} ${formatDateTime(reminder.due, { now })}${rec}.`;
    return { text: slots.wake ? `Alarm set for ${formatDateTime(reminder.due, { now })}${rec}.` : phrase, cards: [{ type: 'reminders', title: 'Reminder set', items: [reminderView(reminder, now)] }], slots: { text } };
  }

  async function listReminders(slots, ctx) {
    const now = ctx.now();
    const items = reminders.find((r) => r.status === 'scheduled').sort((a, b) => new Date(a.due) - new Date(b.due));
    if (!items.length) return { text: 'You have no reminders scheduled.' };
    const spoken = items.slice(0, 5).map((r) => `${r.text} ${formatDateTime(r.due, { now })}${r.recurrence ? ` (${describeRecurrence(r.recurrence)})` : ''}`);
    return { text: `You have ${items.length} ${items.length === 1 ? 'reminder' : 'reminders'}: ${spoken.join('; ')}.`, cards: [{ type: 'reminders', title: 'Reminders', items: items.map((r) => reminderView(r, now)) }] };
  }

  async function cancelReminder(slots, ctx) {
    const scheduled = reminders.find((r) => r.status === 'scheduled');
    if (slots.all) {
      if (!scheduled.length) return { text: 'You have no reminders to cancel.' };
      for (const r of scheduled) reminders.update(r.id, { status: 'cancelled' });
      ctx.events.publish('reminder.changed', { action: 'cancelled-all' });
      return { text: `Cancelled all ${scheduled.length} reminders.` };
    }
    if (!scheduled.length) return { text: 'You have no reminders to cancel.' };
    const target = slots.query ? findByText(scheduled, slots.query, 'text') : scheduled.length === 1 ? scheduled[0] : null;
    if (!target) {
      return slots.query
        ? { text: `I couldn't find a reminder about "${slots.query}".` }
        : { text: 'Which reminder should I cancel?', pending: { intent: 'reminders.cancel', slots: {}, slot: 'query' } };
    }
    reminders.update(target.id, { status: 'cancelled' });
    ctx.events.publish('reminder.changed', { reminder: target, action: 'cancelled' });
    return { text: `Cancelled the reminder to ${target.text.charAt(0).toLowerCase()}${target.text.slice(1)}.` };
  }

  // -- calendar ---------------------------------------------------------------
  async function scheduleEvent(slots, ctx) {
    const now = ctx.now();
    let raw = slots.raw ?? slots.title ?? '';
    let durationMs = slots.durationMinutes ? slots.durationMinutes * 60_000 : null;
    const forDuration = /\bfor\s+((?:\d+(?:\.\d+)?|an?|one|two|three|four|half an?)\s*(?:minutes?|mins?|hours?|hrs?)(?:\s+and\s+(?:\d+|a half|thirty|fifteen)\s*(?:minutes?|mins?)?)?)\b/i.exec(raw);
    if (forDuration) {
      const parsedDuration = parseDuration(forDuration[1]);
      if (parsedDuration) {
        durationMs = parsedDuration.ms;
        raw = raw.replace(forDuration[0], ' ');
      }
    }
    let when = slots.start ? resolveWhen(slots.start, now) : null;
    if (!when && slots.when) when = resolveWhen(slots.when, now);
    const parsed = slots.title && slots.start ? null : parseDateTime(raw, { now });
    if (!when && parsed) when = parsed;
    let title = slots.title && slots.start ? slots.title : parsed ? parsed.remainder : raw;
    title = cleanTitle(title.replace(/\b(?:called|titled|named)\b/i, ' ').replace(/\s+(?:to|on|in)\s+(?:my\s+|the\s+)?calendar$/i, ''));
    if (!title) title = 'Appointment';
    if (!when) return { text: `When is "${title}"?`, pending: { intent: 'calendar.schedule', slots: { ...slots, raw: title, title: undefined }, slot: 'when' } };
    const start = when.date;
    const end = new Date(start.getTime() + (durationMs ?? 60 * 60_000));
    const clashes = (await listEvents({ from: start, to: end })).filter((e) => new Date(e.start) < end && new Date(e.end) > start);
    const calendar = calendars.find((c) => c.id === 'google') ?? local;
    let event;
    try {
      event = await calendar.create({ title, start: start.toISOString(), end: end.toISOString(), location: slots.location ?? null });
    } catch (error) {
      event = await local.create({ title, start: start.toISOString(), end: end.toISOString(), location: slots.location ?? null });
      ctx.logger.warn?.(`[jarvis] ${calendar.label} unavailable (${error.message}); saved locally.`);
    }
    ctx.events.publish('calendar.changed', { event, action: 'created' });
    const minutes = Math.round((end - start) / 60_000);
    const length = minutes % 60 === 0 ? `${minutes / 60} ${minutes === 60 ? 'hour' : 'hours'}` : `${minutes} minutes`;
    const warn = clashes.length ? ` Heads up: it overlaps with "${clashes[0].title}".` : '';
    return { text: `Scheduled "${event.title}" for ${formatDateTime(start, { now })} (${length}).${warn}`, cards: [{ type: 'events', title: 'New event', items: [eventView(event, now)] }], slots: { title: event.title } };
  }

  function rangeFor(range, now) {
    const r = String(range ?? 'today').toLowerCase().trim();
    if (r === 'this week' || r === 'week') return { from: now, to: new Date(startOfDay(now).getTime() + 7 * DAY), label: 'this week' };
    if (r === 'next week') return { from: new Date(startOfDay(now).getTime() + 7 * DAY), to: new Date(startOfDay(now).getTime() + 14 * DAY), label: 'next week' };
    if (r === 'this weekend' || r === 'weekend') {
      const sat = new Date(startOfDay(now).getTime() + ((6 - now.getDay() + 7) % 7) * DAY);
      return { from: sat, to: endOfDay(new Date(sat.getTime() + DAY)), label: 'this weekend' };
    }
    const parsed = parseDateTime(r, { now });
    const day = parsed?.date ?? now;
    const label = formatDateTime(day, { now, withTime: false });
    return { from: label === 'today' ? now : startOfDay(day), to: endOfDay(day), label, day };
  }

  async function agenda(slots, ctx) {
    const now = ctx.now();
    const { from, to, label } = rangeFor(slots.range, now);
    const events = await listEvents({ from, to });
    const dueTasks = tasks.find((t) => t.status === 'open' && t.due && new Date(t.due) >= startOfDay(from) && new Date(t.due) <= to);
    const dueReminders = reminders.find((r) => r.status === 'scheduled' && new Date(r.due) >= from && new Date(r.due) <= to);
    const cards = [];
    if (events.length) cards.push({ type: 'events', title: `Events ${label}`, items: events.map((e) => eventView(e, now)) });
    if (dueTasks.length) cards.push({ type: 'tasks', title: `Tasks due ${label}`, items: sortTasks(dueTasks, now).map((t) => taskView(t, now)) });
    if (dueReminders.length) cards.push({ type: 'reminders', title: `Reminders ${label}`, items: dueReminders.map((r) => reminderView(r, now)) });
    if (slots.freeBusy) {
      return { text: events.length ? `You have ${events.length} ${events.length === 1 ? 'event' : 'events'} ${label}, starting with "${events[0].title}" ${formatDateTime(events[0].start, { now })}.` : `You're free ${label}. Nothing on the calendar.`, cards };
    }
    if (!events.length && !dueTasks.length && !dueReminders.length) return { text: `Your calendar is clear ${label}.`, cards };
    const parts = [];
    if (events.length) parts.push(`${events.length} ${events.length === 1 ? 'event' : 'events'}: ${events.slice(0, 4).map((e) => `${e.title} ${formatDateTime(e.start, { now })}`).join('; ')}`);
    if (dueTasks.length) parts.push(`${dueTasks.length} ${dueTasks.length === 1 ? 'task' : 'tasks'} due`);
    if (dueReminders.length) parts.push(`${dueReminders.length} ${dueReminders.length === 1 ? 'reminder' : 'reminders'}`);
    return { text: `Here's ${label === 'today' ? 'today' : label}: ${parts.join('. ')}.`, cards };
  }

  async function cancelEvent(slots, ctx) {
    const now = ctx.now();
    const upcoming = await listEvents({ from: now, to: new Date(now.getTime() + 60 * DAY) });
    const event = slots.query ? findByText(upcoming, slots.query) : upcoming.length === 1 ? upcoming[0] : null;
    if (!event) return { text: slots.query ? `I couldn't find an upcoming event matching "${slots.query}".` : 'Which event should I cancel?' };
    const calendar = calendars.find((c) => c.id === (event.source ?? 'local')) ?? local;
    await calendar.remove(event.id);
    ctx.events.publish('calendar.changed', { event, action: 'deleted' });
    return { text: `Cancelled "${event.title}" (${formatDateTime(event.start, { now })}).` };
  }

  const WEEKDAY = '(?:mon|tues?|wed(?:nes)?|thu(?:rs)?|fri|sat(?:ur)?|sun)(?:day)?';
  const EVENT_NOUN = 'meeting|appointment|call|event|lunch|dinner|breakfast|brunch|coffee|dentist|doctor|interview|session|class|workout|gym|date|catch ?up|standup|stand-up|sync|review|haircut|flight|trip|party|demo|presentation|check-?up|1:1|one on one';

  return {
    id: 'tasks',
    name: 'Tasks, Reminders & Calendar',
    description: 'Manages a to-do list, timed and recurring reminders, and calendar events. Publishes an iCalendar feed and can sync with Google Calendar.',

    setup(ctx) {
      tasks = ctx.store.collection('tasks');
      reminders = ctx.store.collection('reminders');
      local = createLocalCalendar({ store: ctx.store });
      calendars = [local];
      if (ctx.config.calendarAdapter === 'google' || ctx.integrations?.isConfigured('google-calendar')) {
        try {
          calendars.push(createGoogleCalendar(ctx.integrations.config('google-calendar')));
        } catch (error) {
          ctx.logger.warn?.(`[jarvis] Google Calendar is not configured (${error.message}); using the local calendar.`);
        }
      }
      ctx.calendar = { list: listEvents, local };
    },

    intents: [
      {
        name: 'reminders.set',
        priority: 4,
        examples: ['remind me to call mom tomorrow at 9am', 'set a reminder for 5pm to take out the trash', 'remind me in 10 minutes to stretch', 'wake me up at 6:30', 'set a timer for 10 minutes', 'remind me every day at 8am to take my vitamins', 'set an alarm for 7am'],
        patterns: [
          /^(?:remind me|set (?:a |an |another )?reminder|create (?:a )?reminder|add (?:a )?reminder|remember to remind me)\b(.*)$/,
          /^(wake me(?: up)?|set (?:an |my )?alarm)\b(.*)$/,
          /^(?:set|start) (?:a |the )?timer\b(.*)$/,
          /^(?:do not|don't) let me forget\b(.*)$/,
        ],
        slots: (m, { stripped, cased }) => {
          if (/^(?:set|start) (?:a |the )?timer/.test(stripped)) return { timer: true, raw: m[1] };
          if (/^(?:wake me|set (?:an |my )?alarm)/.test(stripped)) return { wake: true, raw: m[2] };
          return { raw: cased[1] };
        },
        handler: setReminder,
      },
      {
        name: 'reminders.list',
        priority: 3,
        examples: ['what are my reminders', 'show my reminders', 'do i have any reminders', 'list reminders'],
        patterns: [
          /^(?:what(?: are| is)?|show|list|read|tell me)\s+(?:me\s+)?(?:are\s+)?(?:my\s+|the\s+|all\s+)?(?:upcoming\s+)?(?:reminders|alarms|timers)(?:\s+do i have)?$/,
          /^(?:do i have|have i got|are there)\s+any\s+(?:reminders|alarms|timers)(?:\s+(?:set|scheduled))?$/,
          /^(?:my\s+)?reminders$/,
        ],
        handler: listReminders,
      },
      {
        name: 'reminders.cancel',
        priority: 3,
        examples: ['cancel my reminder to call mom', 'delete the reminder about the dentist', 'cancel all reminders', 'cancel the timer'],
        patterns: [
          /^(?:cancel|delete|remove|clear|stop)\s+(all)\s+(?:of\s+)?(?:my\s+|the\s+)?(?:reminders|alarms|timers)$/,
          /^(?:cancel|delete|remove|clear|stop)\s+(?:the\s+|my\s+|that\s+)?(?:reminder|alarm|timer)(?:\s+(?:to|for|about|called)\s+(.+))?$/,
        ],
        slots: (m) => (m[1] === 'all' ? { all: true } : { query: m[1] ?? m[2] ?? undefined }),
        handler: cancelReminder,
      },
      {
        name: 'calendar.schedule',
        priority: 3,
        examples: ['schedule a meeting with bob tomorrow at 3pm', 'book a dentist appointment on friday at 10am', 'add lunch with sarah to my calendar on monday at noon', 'i have a call at 4pm today', 'schedule a team sync for 30 minutes tomorrow at 2'],
        patterns: [
          new RegExp(`^(?:schedule|book|set up|setup|arrange|plan|create|add|put|organize)\\s+(?:a\\s+|an\\s+|my\\s+|the\\s+)?(?:new\\s+)?(?:\\w+\\s+){0,2}?((?:${EVENT_NOUN})\\b.*)$`),
          /^(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:my\s+|the\s+)?calendar(.*)$/,
          new RegExp(`^(?:i have|i have got)\\s+(?:a\\s+|an\\s+)?((?:${EVENT_NOUN})\\b.*)$`),
        ],
        slots: (m, { stripped, cased }) => {
          if (/\b(?:task|todo|to-do|to do list|reminder|shopping list)\b/.test(stripped)) return null;
          if (/^(?:add|put)\s+.+\s+(?:to|on|in)\s+(?:my\s+|the\s+)?calendar/.test(stripped)) return { raw: `${cased[1]} ${cased[2] ?? ''}`.trim() };
          const head = /^(?:schedule|book|set up|setup|arrange|plan|create|add|put|organize)\s+(?:a\s+|an\s+|my\s+|the\s+)?(?:new\s+)?(.*)$/i.exec(cased[0]);
          return { raw: (head ? head[1] : cased[1]).trim() };
        },
        handler: scheduleEvent,
      },
      {
        name: 'calendar.cancel',
        priority: 3,
        examples: ['cancel my meeting with bob', 'delete the dentist appointment', 'remove the team sync from my calendar'],
        patterns: [
          new RegExp(`^(?:cancel|delete|remove|drop)\\s+(?:the\\s+|my\\s+|that\\s+)?((?:\\w+\\s+){0,2}?(?:${EVENT_NOUN})\\b.*?)(?:\\s+from\\s+(?:my\\s+)?calendar)?$`),
        ],
        slots: (m) => ({ query: m[1].replace(/\b(with|about|for|called|titled)\b/g, ' ').trim() }),
        handler: cancelEvent,
      },
      {
        name: 'calendar.agenda',
        priority: 2,
        examples: ["what's on my calendar today", 'what do i have tomorrow', 'show my schedule for this week', 'am i free on friday', 'do i have any meetings today', 'my agenda'],
        patterns: [
          /^(?:what is|show|read|list|check|tell me|open|pull up)\s+(?:me\s+)?(?:on\s+)?(?:my\s+|the\s+)?(?:calendar|schedule|agenda|appointments|meetings|events)(?:\s+(?:for|on|like)?\s*(.+))?$/,
          new RegExp(`^what (?:do i have|have i got|is happening|is going on|is planned|is scheduled)\\s+(?:on\\s+|scheduled\\s+|planned\\s+|going on\\s+|coming up\\s+)?(?:for\\s+|on\\s+)?(today|tomorrow|tonight|this week|next week|this weekend|${WEEKDAY})$`),
          new RegExp(`^(?:do i have|have i got)\\s+(?:any(?:thing)?\\s+)?(?:meetings|appointments|events|plans|scheduled|planned|on)?\\s*(?:on\\s+|for\\s+)?(today|tomorrow|tonight|this week|next week|this weekend|${WEEKDAY})?$`),
          /^(?:am i|are we)\s+(free|busy|available)\s*(?:on\s+|for\s+)?(.+)?$/,
          /^(?:my\s+)?(?:agenda|schedule|calendar|day)(?:\s+(?:for\s+)?(today|tomorrow|this week|next week))?$/,
          /^(?:what does my (?:day|week) look like|how does my (?:day|week) look|brief me|daily briefing|what is my day like)$/,
        ],
        slots: (m, { stripped }) => {
          if (/^(?:am i|are we)\b/.test(stripped)) return { range: m[2] ?? 'today', freeBusy: true };
          if (/\bweek\b/.test(stripped) && !m[1]) return { range: 'this week' };
          return { range: m[1] ?? 'today' };
        },
        handler: agenda,
      },
      {
        name: 'tasks.list',
        priority: 2,
        examples: ['what are my tasks', 'show my to-do list', 'what do i need to do today', 'list my overdue tasks', 'show completed tasks', "what's on my plate"],
        patterns: [
          /^(?:what(?: is| are)?|show|list|read|tell me|get|open)\s+(?:me\s+)?(?:are\s+)?(?:my\s+|the\s+|all\s+)?(?:my\s+)?(?:(today's|todays|open|pending|overdue|completed|done|finished|remaining|outstanding)\s+)?(?:tasks|todos|to-dos|to do list|to-do list|todo list|task list|to dos)(?:\s+(?:for|due)\s*(today|tomorrow|this week))?$/,
          /^what (?:do i (?:have|need)|should i|must i) (?:to )?do(?:\s+(today|tomorrow|this week|now|next))?$/,
          /^what is (?:on my (?:plate|list)|left to do|next on my list)(?:\s+(today|tomorrow))?$/,
          /^(?:my\s+)?(?:tasks|todos|to-dos|to do list|todo list)$/,
        ],
        slots: (m) => {
          const word = (m[1] ?? '').replace("'", '');
          const tail = m[2] ?? (['today', 'tomorrow', 'this week'].includes(m[1]) ? m[1] : null);
          if (['completed', 'done', 'finished'].includes(word)) return { filter: 'done' };
          if (word === 'overdue') return { filter: 'overdue' };
          if (word === 'todays' || tail === 'today') return { filter: 'today' };
          if (tail === 'tomorrow') return { filter: 'tomorrow' };
          if (tail === 'this week') return { filter: 'week' };
          return { filter: 'open' };
        },
        handler: listTasks,
      },
      {
        name: 'tasks.complete',
        priority: 2,
        examples: ['mark buy milk as done', 'i finished the report', 'complete the laundry task', 'check off call the bank', 'i have done the dishes'],
        patterns: [
          /^(?:mark|set|flag)\s+(?:the\s+)?(?:task\s+)?(.+?)\s+(?:as\s+)?(?:done|complete|completed|finished)$/,
          /^(?:complete|finish|check off|tick off|cross off|close)\s+(?:the\s+)?(?:task\s+)?(.+?)(?:\s+task)?$/,
          /^i (?:have |just )?(?:done|finished|completed)\s+(?:with\s+)?(?:the\s+)?(.+)$/,
          /^i am done with\s+(?:the\s+)?(.+)$/,
          /^(.+?)\s+is (?:done|finished|complete)$/,
        ],
        slots: (m, { cased }) => ({ title: cased[1].trim() }),
        handler: completeTask,
      },
      {
        name: 'tasks.delete',
        priority: 2,
        examples: ['delete the task buy milk', 'remove call the bank from my list', 'drop the laundry task'],
        patterns: [
          /^(?:delete|remove|drop|erase)\s+(?:the\s+)?task\s+(.+)$/,
          /^(?:delete|remove|drop|erase)\s+(?:the\s+)?(.+?)\s+task$/,
          /^(?:delete|remove|take|drop)\s+(.+?)\s+(?:from|off)\s+(?:my\s+)?(?:tasks|todo list|to-do list|to do list|list)$/,
        ],
        slots: (m) => ({ title: m[1].trim() }),
        handler: deleteTask,
      },
      {
        name: 'tasks.add',
        priority: 1,
        examples: ['add a task to buy milk', 'add buy groceries to my to-do list', 'i need to call the bank tomorrow', 'new task: finish the report by friday', 'todo: water the plants', 'add a high priority task to renew my passport'],
        patterns: [
          /^(?:add|create|make|new|start)\s+(?:a\s+|an\s+)?(?:new\s+)?(?:(?:high|low|top)[- ]priority\s+|urgent\s+|important\s+)?(?:task|todo|to-do|to do)(?:\s+item)?\s*(?:[:,-]\s*|\s+(?:to|called|named|for|that says|saying)\s+)(.+)$/,
          /^(?:add|put)\s+(.+?)\s+(?:to|on|in)\s+(?:my\s+|the\s+)?(?:todo|to-do|to do|task|tasks)\s*(?:list)?$/,
          /^(?:todo|task|to-do)\s*[:-]\s*(.+)$/,
          /^(?:i need to|i have to|i must|i should|i ought to|i gotta|i have got to)\s+(?!know|find out|ask)(.+)$/,
        ],
        slots: (m, { stripped, cased }) => {
          const raw = cased[1].trim();
          if (!raw) return null;
          const flagged = /^(?:add|create|make|new|start)\s+(?:a\s+|an\s+)?(?:new\s+)?(high[- ]priority|top[- ]priority|urgent|important|low[- ]priority)/.exec(stripped);
          return { raw, priority: flagged ? (flagged[1].startsWith('low') ? 'low' : 'high') : undefined };
        },
        handler: addTask,
      },
    ],

    tools: [
      {
        name: 'tasks_add',
        description: 'Add an item to the user\'s to-do list. Call this when the user mentions something they need to do and wants it tracked, with or without a due date.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Short imperative title, e.g. "Renew passport".' },
            due: { type: ['string', 'null'], description: 'When it is due, as ISO 8601 local time or natural language like "tomorrow at 5pm". Null if no deadline.' },
            priority: { type: ['string', 'null'], enum: ['low', 'normal', 'high', null] },
          },
          required: ['title', 'due', 'priority'],
          additionalProperties: false,
        },
        run: async ({ title, due, priority }, ctx) => ({ result: (await addTask({ title, due: due ?? undefined, priority: priority ?? undefined }, ctx)).text }),
      },
      {
        name: 'tasks_list',
        description: 'Read the to-do list. Call this when the user asks what they need to do, what is overdue, or what they have completed.',
        input_schema: {
          type: 'object',
          properties: { filter: { type: 'string', enum: ['open', 'today', 'tomorrow', 'week', 'overdue', 'done'] } },
          required: ['filter'],
          additionalProperties: false,
        },
        run: async ({ filter }, ctx) => {
          const now = ctx.now();
          const result = await listTasks({ filter }, ctx);
          return { summary: result.text, tasks: result.cards?.[0]?.items?.map((t) => ({ title: t.title, due: t.dueText, priority: t.priority, overdue: t.overdue })) ?? [], now: now.toISOString() };
        },
      },
      {
        name: 'tasks_complete',
        description: 'Mark a to-do item as done. Call this when the user says they finished something that is on their list.',
        input_schema: { type: 'object', properties: { title: { type: 'string', description: 'Words identifying the task.' } }, required: ['title'], additionalProperties: false },
        run: async ({ title }, ctx) => ({ result: (await completeTask({ title }, ctx)).text }),
      },
      {
        name: 'reminders_set',
        description: 'Schedule a reminder that will notify the user at a specific time, optionally repeating. Call this for "remind me", alarms and timers.',
        input_schema: {
          type: 'object',
          properties: {
            text: { type: 'string', description: 'What to remind the user about, e.g. "Call mom".' },
            when: { type: 'string', description: 'When to fire, as ISO 8601 local time or natural language like "in 20 minutes" or "tomorrow at 9am".' },
            recurrence: { type: ['string', 'null'], enum: ['hourly', 'daily', 'weekdays', 'weekly', 'monthly', null] },
          },
          required: ['text', 'when', 'recurrence'],
          additionalProperties: false,
        },
        run: async ({ text, when, recurrence }, ctx) => ({ result: (await setReminder({ text, when, recurrence: recurrence ?? undefined }, ctx)).text }),
      },
      {
        name: 'reminders_list',
        description: 'List the reminders that are currently scheduled. Call this when the user asks what reminders, alarms or timers they have.',
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        run: async (_input, ctx) => {
          const result = await listReminders({}, ctx);
          return { summary: result.text, reminders: result.cards?.[0]?.items?.map((r) => ({ text: r.text, when: r.dueText, repeats: r.recurrenceText || null })) ?? [] };
        },
      },
      {
        name: 'reminders_cancel',
        description: 'Cancel a scheduled reminder. Call this when the user no longer wants to be reminded about something.',
        input_schema: { type: 'object', properties: { text: { type: 'string', description: 'Words identifying the reminder, or "all" to cancel every reminder.' } }, required: ['text'], additionalProperties: false },
        run: async ({ text }, ctx) => ({ result: (await cancelReminder(text.trim().toLowerCase() === 'all' ? { all: true } : { query: text }, ctx)).text }),
      },
      {
        name: 'calendar_add_event',
        description: 'Put an appointment or meeting on the user\'s calendar. Call this when the user wants to schedule or book something at a specific time.',
        input_schema: {
          type: 'object',
          properties: {
            title: { type: 'string', description: 'Event title, e.g. "Lunch with Sarah".' },
            start: { type: 'string', description: 'Start, as ISO 8601 local time or natural language like "friday at 3pm".' },
            duration_minutes: { type: ['integer', 'null'], description: 'Length in minutes. Null for the default of one hour.' },
            location: { type: ['string', 'null'] },
          },
          required: ['title', 'start', 'duration_minutes', 'location'],
          additionalProperties: false,
        },
        run: async ({ title, start, duration_minutes: minutes, location }, ctx) => ({ result: (await scheduleEvent({ title, start, durationMinutes: minutes ?? undefined, location: location ?? undefined }, ctx)).text }),
      },
      {
        name: 'calendar_list_events',
        description: 'Read the calendar for a day or a week, including tasks and reminders due in that range. Call this when the user asks about their schedule, agenda or availability.',
        input_schema: { type: 'object', properties: { range: { type: 'string', description: '"today", "tomorrow", "this week", "next week", a weekday name or a date.' } }, required: ['range'], additionalProperties: false },
        run: async ({ range }, ctx) => {
          const result = await agenda({ range }, ctx);
          return { summary: result.text, events: result.cards?.find((c) => c.type === 'events')?.items?.map((e) => ({ title: e.title, when: e.whenText })) ?? [] };
        },
      },
    ],

    routes: [
      { method: 'GET', path: '/api/tasks', handler: (req, ctx) => ({ tasks: sortTasks(tasks.all(), ctx.now()).map((t) => taskView(t, ctx.now())) }) },
      {
        method: 'POST',
        path: '/api/tasks',
        handler: async (req, ctx) => {
          const { title, due, priority } = req.body ?? {};
          if (typeof title !== 'string' || !title.trim()) return { status: 400, body: { error: 'title is required' } };
          const result = await addTask({ title: title.slice(0, 300), due: due || undefined, priority }, ctx);
          return { status: 201, body: { task: result.cards[0].items[0], text: result.text } };
        },
      },
      {
        method: 'PATCH',
        path: '/api/tasks/:id',
        handler: (req, ctx) => {
          const patch = {};
          const body = req.body ?? {};
          if (typeof body.title === 'string' && body.title.trim()) patch.title = body.title.trim().slice(0, 300);
          if (body.status === 'open' || body.status === 'done') {
            patch.status = body.status;
            patch.completedAt = body.status === 'done' ? ctx.now().toISOString() : null;
          }
          if (['low', 'normal', 'high'].includes(body.priority)) patch.priority = body.priority;
          if ('due' in body) patch.due = body.due ? resolveWhen(body.due, ctx.now())?.date.toISOString() ?? null : null;
          const updated = tasks.update(req.params.id, patch);
          if (!updated) return { status: 404, body: { error: 'task not found' } };
          ctx.events.publish('task.changed', { task: updated, action: 'updated' });
          return { task: taskView(updated, ctx.now()) };
        },
      },
      {
        method: 'DELETE',
        path: '/api/tasks/:id',
        handler: (req, ctx) => {
          const ok = tasks.remove(req.params.id);
          if (ok) ctx.events.publish('task.changed', { action: 'deleted', id: req.params.id });
          return ok ? { ok: true } : { status: 404, body: { error: 'task not found' } };
        },
      },
      { method: 'GET', path: '/api/reminders', handler: (req, ctx) => ({ reminders: reminders.all().sort((a, b) => new Date(a.due) - new Date(b.due)).map((r) => reminderView(r, ctx.now())) }) },
      {
        method: 'POST',
        path: '/api/reminders',
        handler: async (req, ctx) => {
          const { text, when, recurrence } = req.body ?? {};
          if (typeof text !== 'string' || !text.trim() || !when) return { status: 400, body: { error: 'text and when are required' } };
          const result = await setReminder({ text: cleanTitle(text.slice(0, 300)), when, recurrence: recurrence || undefined }, ctx);
          if (result.pending) return { status: 400, body: { error: 'could not understand "when"' } };
          return { status: 201, body: { reminder: result.cards[0].items[0], text: result.text } };
        },
      },
      {
        method: 'DELETE',
        path: '/api/reminders/:id',
        handler: (req, ctx) => {
          const updated = reminders.update(req.params.id, { status: 'cancelled' });
          if (updated) ctx.events.publish('reminder.changed', { reminder: updated, action: 'cancelled' });
          return updated ? { ok: true } : { status: 404, body: { error: 'reminder not found' } };
        },
      },
      {
        method: 'POST',
        path: '/api/reminders/:id/snooze',
        handler: (req, ctx) => {
          const minutes = Math.max(1, Math.min(24 * 60, Number(req.body?.minutes ?? 10)));
          const updated = ctx.scheduler.snooze(req.params.id, minutes * 60_000);
          if (updated) ctx.events.publish('reminder.changed', { reminder: updated, action: 'snoozed' });
          return updated ? { reminder: reminderView(updated, ctx.now()) } : { status: 404, body: { error: 'reminder not found' } };
        },
      },
      {
        method: 'GET',
        path: '/api/calendar',
        handler: async (req, ctx) => {
          const now = ctx.now();
          const from = req.query.from ? new Date(req.query.from) : now;
          const to = req.query.to ? new Date(req.query.to) : new Date(now.getTime() + 14 * DAY);
          return { events: (await listEvents({ from, to })).map((e) => eventView(e, now)) };
        },
      },
      {
        method: 'POST',
        path: '/api/calendar',
        handler: async (req, ctx) => {
          const { title, start, durationMinutes, location } = req.body ?? {};
          if (typeof title !== 'string' || !title.trim() || !start) return { status: 400, body: { error: 'title and start are required' } };
          const result = await scheduleEvent({ title: title.slice(0, 300), start, durationMinutes: Number(durationMinutes) || undefined, location }, ctx);
          if (result.pending) return { status: 400, body: { error: 'could not understand "start"' } };
          return { status: 201, body: { event: result.cards[0].items[0], text: result.text } };
        },
      },
      {
        method: 'DELETE',
        path: '/api/calendar/:id',
        handler: async (req, ctx) => {
          const ok = await local.remove(req.params.id);
          if (ok) ctx.events.publish('calendar.changed', { action: 'deleted', id: req.params.id });
          return ok ? { ok: true } : { status: 404, body: { error: 'event not found' } };
        },
      },
      {
        method: 'GET',
        path: '/calendar.ics',
        handler: () => ({ status: 200, headers: { 'content-type': 'text/calendar; charset=utf-8', 'content-disposition': 'inline; filename="jarvis.ics"' }, raw: toICS({ events: local.all(), reminders: reminders.all(), tasks: tasks.all() }) }),
      },
    ],

    snapshot: async (ctx) => {
      const now = ctx.now();
      const open = tasks.find((t) => t.status === 'open');
      const done = tasks.find((t) => t.status === 'done');
      const upcoming = await listEvents({ from: now, to: new Date(now.getTime() + 7 * DAY) });
      return {
        tasks: sortTasks(open, now).map((t) => taskView(t, now)),
        completed: done.slice(-5).reverse().map((t) => taskView(t, now)),
        reminders: reminders.find((r) => r.status === 'scheduled').sort((a, b) => new Date(a.due) - new Date(b.due)).map((r) => reminderView(r, now)),
        events: upcoming.map((e) => eventView(e, now)),
        stats: {
          open: open.length,
          dueToday: open.filter((t) => t.due && new Date(t.due) <= endOfDay(now)).length,
          overdue: open.filter((t) => t.due && new Date(t.due) < now).length,
          doneToday: done.filter((t) => t.completedAt && new Date(t.completedAt) >= startOfDay(now)).length,
        },
        calendars: calendars.map((c) => c.label),
      };
    },

    suggestions: async (ctx) => {
      const now = ctx.now();
      const out = [];
      const overdue = tasks.find((t) => t.status === 'open' && t.due && new Date(t.due) < now);
      if (overdue.length) out.push({ id: 'overdue-tasks', text: `You have ${overdue.length} overdue ${overdue.length === 1 ? 'task' : 'tasks'}. Review ${overdue.length === 1 ? 'it' : 'them'}?`, utterance: 'show my overdue tasks', score: 0.85 });
      const soon = (await listEvents({ from: now, to: new Date(now.getTime() + 60 * 60_000) }))[0];
      if (soon && new Date(soon.start) > now) out.push({ id: `event:${soon.id}`, text: `"${soon.title}" starts ${formatDateTime(soon.start, { now })}.`, utterance: "what's on my calendar today", score: 0.95 });
      return out;
    },
  };
}
