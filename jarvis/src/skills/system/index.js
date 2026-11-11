const NOT_NAMES = new Set(['cold', 'hot', 'warm', 'hungry', 'tired', 'home', 'back', 'leaving', 'bored', 'fine', 'good', 'ok', 'okay', 'here', 'ready', 'done', 'busy', 'free', 'sorry', 'sure', 'happy', 'sad', 'late', 'lost', 'sick', 'awake', 'up', 'out', 'in', 'not', 'going', 'heading', 'off', 'chilly', 'freezing', 'boiling', 'thirsty', 'confused', 'serious', 'kidding', 'joking', 'curious', 'wondering', 'looking', 'trying', 'thinking']);

const titleCase = (s) => s.replace(/\b[a-z]/g, (c) => c.toUpperCase());

/**
 * Privacy, personalization and settings by voice or text: what JARVIS knows,
 * exporting it, deleting it, incognito mode, retention, and preferences.
 */
export function createSystemSkill() {
  async function privacyReport(slots, ctx) {
    const report = ctx.kernel.privacyReport();
    const p = report.profile;
    const facts = [];
    if (p.name) facts.push(`your name is ${p.name}`);
    if (p.location) facts.push(`you're based in ${p.location}`);
    facts.push(`you prefer ${p.units} units`);
    const singular = (k) => k.replace(/ies$/, 'y').replace(/s$/, '');
    const counts = Object.entries(report.counts).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${n === 1 ? singular(k) : k}`);
    return {
      text: `Here's what I hold: ${facts.join(', ')}. I've stored ${counts.length ? counts.join(', ') : 'nothing else yet'}. ${report.encryption.enabled ? 'Your data is encrypted with AES-256.' : `Your data is not encrypted${report.encryption.hint ? ` (${report.encryption.hint})` : ''}.`} Conversations are kept for ${p.retentionDays} days${p.incognito ? ', and incognito mode is on so nothing new is being saved' : ''}. You can say "export my data" or "forget everything" at any time.`,
      cards: [{ type: 'privacy', title: 'Your data', report }],
    };
  }

  async function forget(slots, ctx) {
    const scope = slots.scope ?? 'all';
    const label = { all: 'all of your data, including tasks, reminders, calendar, preferences, learning and saved credentials', history: 'your conversation history', learning: 'everything I have learned about your habits and phrasing' }[scope];
    if (slots.confirm === undefined) {
      return { text: `This permanently deletes ${label}. It can't be undone. Say "yes" to confirm.`, pending: { intent: 'system.forget', slots: { scope }, slot: 'confirm' } };
    }
    if (slots.confirm !== 'yes') return { text: "Okay, I haven't deleted anything." };
    const result = await ctx.kernel.forget(scope);
    return { text: `Done. I've deleted ${label}. ${result.removed} ${result.removed === 1 ? 'collection was' : 'collections were'} cleared.`, wiped: true };
  }

  async function exportData(slots, ctx) {
    ctx.security.audit('privacy.export.requested', {});
    return { text: 'Your export is ready. It contains everything I store about you as a single JSON file.', cards: [{ type: 'link', title: 'Download your data', url: '/api/privacy/export', label: 'Download jarvis-export.json' }] };
  }

  async function setName(slots, ctx) {
    const name = titleCase(String(slots.name).trim());
    ctx.profile.set({ name });
    return { text: `Pleasure to meet you, ${name}. I'll remember that.` };
  }

  async function setLocation(slots, ctx) {
    const location = titleCase(String(slots.location).trim());
    ctx.profile.set({ location });
    return { text: `Got it. I'll use ${location} for weather and local information.`, track: { lastLocation: location } };
  }

  async function setUnits(slots, ctx) {
    const units = ['fahrenheit', 'imperial'].includes(slots.units) ? 'imperial' : 'metric';
    ctx.profile.set({ units });
    return { text: `Okay, I'll use ${units === 'imperial' ? 'Fahrenheit and miles' : 'Celsius and kilometres'} from now on.` };
  }

  async function incognito(slots, ctx) {
    const on = slots.state === 'on';
    ctx.profile.set({ incognito: on });
    ctx.security.audit('privacy.incognito', { on });
    return { text: on ? "Incognito mode is on. I won't save this conversation or learn from it until you turn it off." : "Incognito mode is off. I'm saving history and learning again." };
  }

  async function retention(slots, ctx) {
    const days = Math.max(1, Math.min(3650, Number(slots.days)));
    ctx.profile.set({ retentionDays: days });
    const removed = ctx.kernel.applyRetention();
    return { text: `I'll keep conversation history for ${days} ${days === 1 ? 'day' : 'days'}.${removed ? ` I removed ${removed} older ${removed === 1 ? 'entry' : 'entries'}.` : ''}` };
  }

  async function newsTopics(slots, ctx) {
    const current = ctx.profile.get('newsTopics') ?? [];
    const topic = String(slots.topic).trim().toLowerCase();
    let next;
    if (slots.action === 'remove') next = current.filter((t) => t !== topic);
    else next = current.includes(topic) ? current : [...current, topic].slice(-8);
    ctx.profile.set({ newsTopics: next });
    return { text: slots.action === 'remove' ? `Removed ${topic} from your news topics.` : `Added ${topic} to your news topics. Your briefing now covers ${next.join(', ')}.` };
  }

  async function integrations(slots, ctx) {
    const list = ctx.integrations.list();
    const connected = list.filter((i) => i.configured);
    const missing = list.filter((i) => !i.configured);
    return {
      text: `${connected.length} of ${list.length} integrations are active: ${connected.map((i) => i.name).join(', ')}.${missing.length ? ` Not connected yet: ${missing.map((i) => i.name).join(', ')}.` : ''} The language model is ${ctx.llm?.enabled ? `on (${ctx.llm.model})` : 'off, so I am using my built-in command understanding'}.`,
      cards: [{ type: 'integrations', title: 'Integrations', items: list }],
    };
  }

  return {
    id: 'system',
    name: 'Privacy & Settings',
    description: 'Shows what JARVIS stores, exports or deletes it on request, controls incognito mode and retention, and sets your name, home location, units and news topics.',

    intents: [
      {
        name: 'system.privacy_report',
        priority: 5,
        examples: ['what do you know about me', 'what data do you store', 'show my data', 'privacy report', 'privacy settings'],
        patterns: [
          /^(?:what do you (?:know|remember|have) (?:about|on) me|what (?:data|information|info) do you (?:have|store|keep|collect)(?: (?:on|about) me)?|show (?:me\s+)?my (?:data|profile|privacy settings)|privacy (?:report|status|settings|summary)|what have you learned about me|is my data (?:safe|secure|encrypted|private))$/,
        ],
        handler: privacyReport,
      },
      {
        name: 'system.forget',
        priority: 5,
        examples: ['forget everything', 'delete all my data', 'clear my conversation history', 'forget what you learned about me', 'wipe my data'],
        patterns: [
          /^(?:forget (?:everything|all|me|it all|all about me)|delete (?:all\s+)?(?:of\s+)?my (?:data|information|everything)|delete everything|wipe (?:everything|my data|all data|all my data)|erase (?:everything|my data|all my data)|factory reset)$/,
          /^(?:clear|delete|erase|wipe|forget)\s+(?:my\s+|the\s+|our\s+)?(?:conversation\s+|chat\s+)?(history|conversations?|chats?|chat history|conversation history)$/,
          /^(?:forget|reset|clear|erase)\s+(?:what you (?:have\s+)?learned(?: about me)?|your memory|my (?:habits|preferences|profile)|the learning|learning)$/,
        ],
        slots: (m, { stripped }) => {
          if (/(history|conversations?|chats?)$/.test(stripped)) return { scope: 'history' };
          if (/(learned|memory|habits|preferences|profile|learning)/.test(stripped)) return { scope: 'learning' };
          return { scope: 'all' };
        },
        handler: forget,
      },
      {
        name: 'system.export',
        priority: 5,
        examples: ['export my data', 'download my data', 'give me a copy of my data'],
        patterns: [/^(?:export|download|back ?up|give me(?: a copy of)?|send me(?: a copy of)?)\s+(?:all\s+)?(?:of\s+)?(?:my\s+)?(?:data|information|history)$/],
        handler: exportData,
      },
      {
        name: 'system.incognito',
        priority: 5,
        examples: ['turn on incognito mode', 'disable private mode', 'go incognito', 'stop saving my history'],
        patterns: [
          /^(?:turn|switch)\s+(on|off)\s+(?:incognito|private)(?:\s+mode)?$/,
          /^(?:turn|switch)\s+(?:incognito|private)(?:\s+mode)?\s+(on|off)$/,
          /^(enable|disable|start|stop|exit|leave|enter|activate|deactivate)\s+(?:incognito|private)(?:\s+mode)?$/,
          /^(go) incognito$/,
          /^(stop|start) (?:saving|recording|storing|logging) (?:my\s+)?(?:history|conversations?|chats?|data)$/,
        ],
        slots: (m, { stripped }) => {
          if (/^(stop|start) (?:saving|recording|storing|logging)/.test(stripped)) return { state: m[1] === 'stop' ? 'on' : 'off' };
          return { state: ['on', 'enable', 'start', 'enter', 'activate', 'go'].includes(m[1]) ? 'on' : 'off' };
        },
        handler: incognito,
      },
      {
        name: 'system.retention',
        priority: 5,
        examples: ['keep my history for 7 days', 'store conversations for 90 days'],
        patterns: [/^(?:keep|retain|store|save|only keep)\s+(?:my\s+)?(?:conversation\s+|chat\s+)?(?:history|conversations?|chats?)\s+for\s+(\d+)\s+days?$/],
        slots: (m) => ({ days: Number(m[1]) }),
        handler: retention,
      },
      {
        name: 'system.set_location',
        priority: 4,
        examples: ['i live in lisbon', 'my city is toronto', 'set my location to berlin', 'my home is in austin'],
        patterns: [/^(?:i live in|i am based in|i am located in|my (?:home|location|city|town) is(?: in)?|set (?:my\s+)?(?:home|location|city)(?: location)? to|change (?:my\s+)?(?:home|location|city) to|i moved to|i am from)\s+([a-z][a-z .'-]{1,50})$/],
        slots: (m) => ({ location: m[1].trim() }),
        handler: setLocation,
      },
      {
        name: 'system.set_name',
        priority: 4,
        examples: ['my name is tony', 'call me pepper', 'you can call me sam'],
        patterns: [/^(?:my name is|call me|you can call me|i am called|people call me|i am|this is)\s+([a-z][a-z'-]{1,20}(?:\s+[a-z][a-z'-]{1,20})?)$/],
        slots: (m, { stripped }) => {
          const name = m[1].trim();
          const first = name.split(' ')[0];
          const explicit = /^(?:my name is|call me|you can call me|i am called|people call me)\b/.test(stripped);
          if (!explicit && (NOT_NAMES.has(first) || name.split(' ').length > 1 || first.endsWith('ing'))) return null;
          return { name };
        },
        handler: setName,
      },
      {
        name: 'system.units',
        priority: 4,
        examples: ['use celsius', 'switch to fahrenheit', 'i prefer metric units'],
        patterns: [/^(?:use|switch to|change to|set (?:the\s+)?units to|i prefer|show (?:temperatures?|weather) in)\s+(celsius|fahrenheit|metric|imperial)(?:\s+units)?$/],
        slots: (m) => ({ units: m[1] }),
        handler: setUnits,
      },
      {
        name: 'system.news_topics',
        priority: 4,
        examples: ['add space to my news topics', 'follow news about formula 1', 'remove politics from my news topics', 'i am interested in robotics'],
        patterns: [
          /^(add)\s+(.+?)\s+to my (?:news\s+)?(?:topics|interests|briefing)$/,
          /^(remove|delete|drop)\s+(.+?)\s+from my (?:news\s+)?(?:topics|interests|briefing)$/,
          /^(follow|track|unfollow)\s+(?:news (?:about|on)\s+)?(.+?)(?:\s+news)?$/,
          /^i am (interested) in\s+(.+)$/,
        ],
        slots: (m) => ({ action: ['remove', 'delete', 'drop', 'unfollow'].includes(m[1]) ? 'remove' : 'add', topic: m[2].trim() }),
        handler: newsTopics,
      },
      {
        name: 'system.integrations',
        priority: 4,
        examples: ['what is connected', 'show my integrations', 'integration status', 'which services are connected'],
        patterns: [/^(?:what is connected|show (?:me\s+)?(?:my\s+|the\s+)?integrations|integrations?(?: status)?|(?:which|what) (?:services|integrations|apps) (?:are|do you have) connected|list (?:my\s+)?integrations|system status|status report)$/],
        handler: integrations,
      },
    ],

    tools: [
      {
        name: 'get_user_profile',
        description: "Read the user's saved preferences (name, home location, units, news topics) and their most frequent activities. Call this when a request depends on who the user is or what they usually do.",
        input_schema: { type: 'object', properties: {}, required: [], additionalProperties: false },
        run: async (_input, ctx) => ({ preferences: ctx.profile.preferences, interests: ctx.profile.topInterests(5) }),
      },
      {
        name: 'update_user_preferences',
        description: 'Save a preference the user states about themselves: their name, home city, or preferred units. Call this when the user tells you one of these facts and wants it remembered.',
        input_schema: {
          type: 'object',
          properties: {
            name: { type: ['string', 'null'] },
            location: { type: ['string', 'null'], description: 'Home city.' },
            units: { type: ['string', 'null'], enum: ['metric', 'imperial', null] },
          },
          required: ['name', 'location', 'units'],
          additionalProperties: false,
        },
        run: async ({ name, location, units }, ctx) => {
          const patch = {};
          if (name) patch.name = name;
          if (location) patch.location = location;
          if (units) patch.units = units;
          return { saved: ctx.profile.set(patch) };
        },
      },
    ],
  };
}
