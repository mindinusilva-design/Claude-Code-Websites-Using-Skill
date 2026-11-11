import { fetchJson, fetchWithTimeout } from '../../core/http.js';

/**
 * Calendar adapters. The local adapter stores events in JARVIS's own store and
 * publishes them as an iCalendar feed (/calendar.ics) that Apple Calendar,
 * Google Calendar and Outlook can subscribe to. The Google adapter talks to the
 * Google Calendar REST API when an OAuth access token is configured.
 *
 *   list({ from, to }) -> Event[]      create(event) -> Event      remove(id) -> boolean
 *   Event: { id, title, start, end, location?, notes?, source }
 */
export function createLocalCalendar({ store }) {
  const events = store.collection('events');
  return {
    id: 'local',
    label: 'Local calendar (iCalendar feed)',
    async list({ from, to } = {}) {
      return events
        .find((e) => (!from || new Date(e.end ?? e.start) >= from) && (!to || new Date(e.start) <= to))
        .sort((a, b) => new Date(a.start) - new Date(b.start));
    },
    async create(event) {
      return events.insert({ ...event, source: 'local' });
    },
    async remove(id) {
      return events.remove(id);
    },
    all: () => events.all(),
  };
}

export function createGoogleCalendar({ accessToken, calendarId = 'primary' }) {
  if (!accessToken) throw new Error('Google Calendar adapter needs GOOGLE_CALENDAR_ACCESS_TOKEN');
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calendarId)}/events`;
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' };
  const toEvent = (item) => ({
    id: `google:${item.id}`,
    title: item.summary ?? '(untitled)',
    start: item.start?.dateTime ?? `${item.start?.date}T00:00:00`,
    end: item.end?.dateTime ?? `${item.end?.date}T00:00:00`,
    location: item.location ?? null,
    notes: item.description ?? null,
    source: 'google',
  });
  return {
    id: 'google',
    label: 'Google Calendar',
    async list({ from = new Date(), to = new Date(Date.now() + 7 * 86_400_000) } = {}) {
      const url = `${base}?singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(from.toISOString())}&timeMax=${encodeURIComponent(to.toISOString())}&maxResults=50`;
      const data = await fetchJson(url, { headers });
      return (data.items ?? []).map(toEvent);
    },
    async create(event) {
      const response = await fetchWithTimeout(base, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          summary: event.title,
          location: event.location ?? undefined,
          description: event.notes ?? undefined,
          start: { dateTime: new Date(event.start).toISOString() },
          end: { dateTime: new Date(event.end).toISOString() },
        }),
      });
      if (!response.ok) throw new Error(`Google Calendar responded ${response.status}`);
      return toEvent(await response.json());
    },
    async remove(id) {
      const response = await fetchWithTimeout(`${base}/${encodeURIComponent(id.replace(/^google:/, ''))}`, { method: 'DELETE', headers });
      return response.ok;
    },
  };
}

const pad = (n) => String(n).padStart(2, '0');
const icsDate = (value) => {
  const d = new Date(value);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
};
const icsText = (text) => String(text ?? '').replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/([,;])/g, '\\$1');

const RRULE = (recurrence) => {
  if (!recurrence) return null;
  if (recurrence === 'daily') return 'FREQ=DAILY';
  if (recurrence === 'weekly' || recurrence.startsWith('weekly:')) return 'FREQ=WEEKLY';
  if (recurrence === 'monthly') return 'FREQ=MONTHLY';
  if (recurrence === 'hourly') return 'FREQ=HOURLY';
  if (recurrence === 'weekdays') return 'FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR';
  return null;
};

/** Serialize events, reminders and dated tasks as an RFC 5545 calendar. */
export function toICS({ events = [], reminders = [], tasks = [] }) {
  const lines = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//JARVIS//Assistant//EN', 'CALSCALE:GREGORIAN', 'X-WR-CALNAME:JARVIS'];
  const stamp = icsDate(new Date());
  for (const e of events) {
    lines.push('BEGIN:VEVENT', `UID:${e.id}@jarvis`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(e.start)}`, `DTEND:${icsDate(e.end ?? e.start)}`, `SUMMARY:${icsText(e.title)}`);
    if (e.location) lines.push(`LOCATION:${icsText(e.location)}`);
    if (e.notes) lines.push(`DESCRIPTION:${icsText(e.notes)}`);
    lines.push('END:VEVENT');
  }
  for (const r of reminders.filter((x) => x.status === 'scheduled')) {
    lines.push('BEGIN:VEVENT', `UID:${r.id}@jarvis`, `DTSTAMP:${stamp}`, `DTSTART:${icsDate(r.due)}`, `DTEND:${icsDate(new Date(new Date(r.due).getTime() + 15 * 60_000))}`, `SUMMARY:${icsText(`Reminder: ${r.text}`)}`);
    const rule = RRULE(r.recurrence);
    if (rule) lines.push(`RRULE:${rule}`);
    lines.push('BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${icsText(r.text)}`, 'TRIGGER:PT0M', 'END:VALARM', 'END:VEVENT');
  }
  for (const t of tasks.filter((x) => x.status === 'open' && x.due)) {
    lines.push('BEGIN:VTODO', `UID:${t.id}@jarvis`, `DTSTAMP:${stamp}`, `DUE:${icsDate(t.due)}`, `SUMMARY:${icsText(t.title)}`, `PRIORITY:${t.priority === 'high' ? 1 : t.priority === 'low' ? 9 : 5}`, 'STATUS:NEEDS-ACTION', 'END:VTODO');
  }
  lines.push('END:VCALENDAR');
  return `${lines.join('\r\n')}\r\n`;
}
