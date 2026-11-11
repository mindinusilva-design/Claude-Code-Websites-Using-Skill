/**
 * User profile: explicit preferences plus habits learned from usage. Habits
 * are stored as counts per intent per hour-of-day / weekday, which is enough
 * to make proactive, time-aware suggestions without any heavy modelling.
 */
const DEFAULTS = () => ({
  name: null,
  location: process.env.JARVIS_DEFAULT_LOCATION || null,
  units: 'metric',
  language: 'en',
  voice: { enabled: true, rate: 1, autoListen: false },
  newsTopics: ['technology', 'world'],
  wakeWord: 'jarvis',
  quietHours: null,
  incognito: false,
  retentionDays: Number(process.env.JARVIS_RETENTION_DAYS || 30),
  habits: { intents: {}, devices: {}, topics: {}, total: 0 },
  interests: {},
  dismissedSuggestions: {},
  createdAt: new Date().toISOString(),
});

export class Profile {
  constructor({ store }) {
    this.store = store;
    const saved = store.read('profile', null);
    this.data = { ...DEFAULTS(), ...(saved ?? {}) };
    this.data.habits = { intents: {}, devices: {}, topics: {}, total: 0, ...(saved?.habits ?? {}) };
    if (!saved) this.save();
  }

  save() {
    this.store.write('profile', this.data);
  }

  get preferences() {
    const { habits, interests, dismissedSuggestions, ...prefs } = this.data;
    return prefs;
  }

  get(key) {
    return this.data[key];
  }

  set(patch) {
    for (const [key, value] of Object.entries(patch)) {
      if (['habits', 'interests', 'dismissedSuggestions'].includes(key)) continue;
      this.data[key] = value;
    }
    this.save();
    return this.preferences;
  }

  /** Record one interaction so time-of-day habits emerge. */
  learn({ intent, slots = {}, at = new Date() }) {
    if (!intent) return;
    const hour = at.getHours();
    const day = at.getDay();
    const habits = this.data.habits;
    const entry = (habits.intents[intent] ??= { total: 0, byHour: Array(24).fill(0), byDay: Array(7).fill(0), lastSlots: null, lastAt: null });
    entry.total += 1;
    entry.byHour[hour] += 1;
    entry.byDay[day] += 1;
    entry.lastAt = at.toISOString();
    if (intent.startsWith('smarthome.')) entry.lastSlots = slots;
    habits.total += 1;
    for (const device of slots.devices ?? []) {
      const d = (habits.devices[device] ??= { total: 0, byHour: Array(24).fill(0) });
      d.total += 1;
      d.byHour[hour] += 1;
    }
    if (slots.query || slots.topic) {
      const topic = String(slots.topic ?? slots.query).toLowerCase().slice(0, 60);
      this.data.interests[topic] = (this.data.interests[topic] ?? 0) + 1;
    }
    this.save();
  }

  topInterests(limit = 5) {
    return Object.entries(this.data.interests)
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([topic, count]) => ({ topic, count }));
  }

  dismissSuggestion(id) {
    this.data.dismissedSuggestions[id] = Date.now();
    this.save();
  }

  /**
   * Proactive suggestions for the current moment: things the user usually does
   * around this hour (±1h) on at least 3 occasions, strongest first.
   */
  suggestions({ now = new Date(), limit = 4, extra = [] } = {}) {
    const hour = now.getHours();
    const out = [];
    const hours = [(hour + 23) % 24, hour, (hour + 1) % 24];
    for (const [intent, entry] of Object.entries(this.data.habits.intents)) {
      if (entry.total < 3) continue;
      const near = hours.reduce((acc, h) => acc + entry.byHour[h], 0);
      const share = near / entry.total;
      if (near < 2 || share < 0.3) continue;
      const id = `habit:${intent}:${hour}`;
      const dismissedAt = this.data.dismissedSuggestions[id];
      if (dismissedAt && Date.now() - dismissedAt < 12 * 3600 * 1000) continue;
      out.push({
        id,
        kind: 'habit',
        intent,
        slots: entry.lastSlots ?? {},
        score: Number((share * Math.log2(1 + near)).toFixed(3)),
        text: describeHabit(intent, entry.lastSlots),
      });
    }
    for (const item of extra) out.push({ score: 0.5, kind: 'context', ...item });
    return out.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /** Compact summary of the user for the language model prompt. */
  summary() {
    const bits = [];
    if (this.data.name) bits.push(`The user's name is ${this.data.name}.`);
    if (this.data.location) bits.push(`Home location: ${this.data.location}.`);
    bits.push(`Preferred units: ${this.data.units}.`);
    const interests = this.topInterests(4).map((i) => i.topic);
    if (interests.length) bits.push(`Recent interests: ${interests.join(', ')}.`);
    const frequent = Object.entries(this.data.habits.intents).sort((a, b) => b[1].total - a[1].total).slice(0, 4).map(([i]) => i);
    if (frequent.length) bits.push(`Most used features: ${frequent.join(', ')}.`);
    if (this.data.newsTopics?.length) bits.push(`News topics: ${this.data.newsTopics.join(', ')}.`);
    return bits.join(' ');
  }

  /** Activity by hour (all intents), used by the dashboard chart. */
  activityByHour() {
    const totals = Array(24).fill(0);
    for (const entry of Object.values(this.data.habits.intents)) entry.byHour.forEach((n, h) => { totals[h] += n; });
    return totals;
  }

  export() {
    return JSON.parse(JSON.stringify(this.data));
  }

  reset() {
    this.data = DEFAULTS();
    this.save();
  }
}

function describeHabit(intent, slots) {
  const devices = slots?.devices?.length ? slots.devices.join(' and ') : slots?.room ? `the ${slots.room}` : null;
  switch (intent) {
    case 'smarthome.power':
      return devices ? `Turn ${slots.state ?? 'on'} ${devices}, like you usually do around now?` : 'Adjust your devices like you usually do around now?';
    case 'smarthome.scene':
      return `Run the "${slots?.scene ?? 'usual'}" scene like you usually do around now?`;
    case 'weather.forecast':
      return 'Want the weather update you usually check around now?';
    case 'news.headlines':
      return 'Want your usual news briefing?';
    case 'tasks.list':
      return 'Review your tasks like you usually do around now?';
    case 'calendar.agenda':
      return 'Check your agenda like you usually do around now?';
    default:
      return `You often use "${intent.replace('.', ' ')}" around now. Want to?`;
  }
}
