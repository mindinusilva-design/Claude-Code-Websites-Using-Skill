import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { EventBus } from './events.js';
import { Store, newId } from './memory/store.js';
import { NLU, RuleEngine, NaiveBayesClassifier } from './nlu/index.js';
import { createLanguageModel } from './nlu/llm.js';
import { ContextManager } from './context.js';
import { Profile } from './profile.js';
import { LearningEngine } from './learning.js';
import { Scheduler } from './scheduler.js';
import { SecurityManager } from './security.js';
import { SkillRegistry } from './registry.js';
import { IntegrationRegistry } from '../integrations/index.js';
import { defineIntegrations } from '../integrations/catalog.js';
import { createVoiceService } from '../voice/index.js';
import { createSmartHomeSkill } from '../skills/smarthome/index.js';
import { createTasksSkill } from '../skills/tasks/index.js';
import { createWeatherSkill } from '../skills/weather/index.js';
import { createNewsSkill } from '../skills/news/index.js';
import { createSearchSkill } from '../skills/search/index.js';
import { createSocialSkill } from '../skills/social/index.js';
import { createSystemSkill } from '../skills/system/index.js';
import { createFeedbackSkill } from '../skills/feedback/index.js';
import { createSmalltalkSkill } from '../skills/smalltalk/index.js';

export const VERSION = '0.1.0';

const SYSTEM_PROMPT = `You are JARVIS, a personal assistant that runs on the user's own machine. You speak in a calm, concise, lightly formal voice, like a capable aide: warm, precise and never chatty.

Your replies appear in a chat window and are often read aloud by a speech synthesizer. Write plain sentences without markdown, bullet symbols, headings or emoji. Keep most replies to one to three sentences, and give more only when the user asks for detail.

You act through tools. Use them whenever the user wants something done or asks about their own tasks, reminders, calendar, devices, weather or news, rather than answering from memory. After a tool runs, tell the user what happened in a sentence, based on the tool's result. If a tool reports that confirmation is needed, ask the user to confirm and do not claim the action happened. If a request is missing a detail you need, such as a time for a reminder, ask one short question.

For general knowledge, answer directly when you are confident, and use web_search when the answer depends on current or specific facts. Say so plainly when you don't know something or a service is unavailable.

The user's data is private. Never reveal credentials, and don't bring up stored personal details unless they are relevant to the request.`;

export function defaultSkills() {
  // Order matters only for exact confidence ties; more specific skills go first.
  return [
    createFeedbackSkill(),
    createSystemSkill(),
    createTasksSkill(),
    createSmartHomeSkill(),
    createWeatherSkill(),
    createNewsSkill(),
    createSocialSkill(),
    createSearchSkill(),
    createSmalltalkSkill(),
  ];
}

/**
 * Encryption is on by default. The key comes from JARVIS_SECRET when set;
 * otherwise a random key file is created next to the data (mode 0600), which
 * protects backups and synced copies of the data folder but not someone with
 * access to the key file itself.
 */
function resolveSecret({ dataDir, env, explicit }) {
  if (explicit) return { secret: explicit, source: 'JARVIS_SECRET' };
  if (env.JARVIS_SECRET) return { secret: env.JARVIS_SECRET, source: 'JARVIS_SECRET' };
  if (!dataDir) return { secret: randomBytes(32).toString('hex'), source: 'memory' };
  mkdirSync(dataDir, { recursive: true });
  const keyPath = join(dataDir, '.key');
  if (existsSync(keyPath)) return { secret: readFileSync(keyPath, 'utf8').trim(), source: 'key file' };
  const secret = randomBytes(32).toString('hex');
  writeFileSync(keyPath, secret, { mode: 0o600 });
  return { secret, source: 'key file' };
}

function toSpeech(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/°C/g, ' degrees Celsius')
    .replace(/°F/g, ' degrees Fahrenheit')
    .replace(/["“”]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export class Jarvis {
  constructor(options = {}) {
    const env = options.env ?? process.env;
    this.env = env;
    this.logger = options.logger ?? console;
    this.now = options.now ?? (() => new Date());
    this.config = {
      dataDir: options.dataDir === undefined ? env.JARVIS_DATA_DIR || './data' : options.dataDir,
      smarthomeAdapter: options.smarthomeAdapter ?? env.JARVIS_SMARTHOME_ADAPTER ?? null,
      calendarAdapter: options.calendarAdapter ?? env.JARVIS_CALENDAR_ADAPTER ?? 'local',
      newsFeeds: [],
      startScheduler: options.startScheduler ?? true,
    };
    const { secret, source } = options.store ? { secret: null, source: 'host' } : resolveSecret({ dataDir: this.config.dataDir, env, explicit: options.secret });
    this.encryption = options.encryption ?? { enabled: true, algorithm: 'AES-256-GCM', keySource: source };
    this.storageLabel = options.storageLabel ?? null;
    this.store = options.store ?? new Store({ dir: this.config.dataDir, secret, encrypted: 'all' });

    this.events = new EventBus();
    this.security = new SecurityManager({ store: this.store, token: options.apiToken ?? env.JARVIS_API_TOKEN ?? null, logger: this.logger });
    this.integrations = defineIntegrations(new IntegrationRegistry({ store: this.store, security: this.security, env }));
    this.profile = new Profile({ store: this.store });
    this.voice = options.voice ?? createVoiceService({ integrations: this.integrations, logger: this.logger });
    this.rules = new RuleEngine();
    this.classifier = new NaiveBayesClassifier();
    this.nlu = new NLU({ rules: this.rules, classifier: this.classifier });
    this.learning = new LearningEngine({ store: this.store, classifier: this.classifier, rules: this.rules, events: this.events, logger: this.logger });
    this.nlu.aliasFor = (normalized) => this.learning.aliasFor(normalized);
    this.contexts = new ContextManager();
    this.registry = new SkillRegistry({ rules: this.rules });
    this.conversations = this.store.collection('conversations');
    this.scheduler = new Scheduler({ reminders: this.store.collection('reminders'), events: this.events, now: this.now, logger: this.logger });
    this.customLlm = options.llm ?? null;
    this.llm = this.customLlm ?? this.#createLanguageModel();
    this.#refreshConfig();

    this.ctx = {
      store: this.store,
      events: this.events,
      profile: this.profile,
      security: this.security,
      integrations: this.integrations,
      scheduler: this.scheduler,
      voice: this.voice,
      logger: this.logger,
      config: this.config,
      now: this.now,
      kernel: this,
    };
    Object.defineProperty(this.ctx, 'llm', { get: () => this.llm, enumerable: true });

    this.setups = [];
    for (const skill of options.skills ?? defaultSkills()) this.use(skill);
    this.nlu.seed();
    this.retentionTimer = null;
  }

  #createLanguageModel() {
    const config = this.integrations.config('anthropic');
    return createLanguageModel({ apiKey: config.apiKey ?? null, model: config.model, effort: config.effort, logger: this.logger });
  }

  #refreshConfig() {
    const feeds = this.integrations.config('google-news').feeds;
    this.config.newsFeeds = feeds ? String(feeds).split(',').map((f) => f.trim()).filter(Boolean) : [];
  }

  /** Register a skill (plugin). */
  use(skill) {
    this.setups.push(this.registry.register(skill, this.ctx));
    return this;
  }

  /** Resolves once every skill has finished its asynchronous setup. */
  async ready() {
    await Promise.all(this.setups);
    this.applyRetention();
    if (this.config.startScheduler) {
      this.scheduler.start();
      if (!this.retentionTimer) {
        this.retentionTimer = setInterval(() => this.applyRetention(), 6 * 3600 * 1000);
        this.retentionTimer.unref?.();
      }
    }
    return this;
  }

  stop() {
    this.scheduler.stop();
    if (this.retentionTimer) clearInterval(this.retentionTimer);
    this.retentionTimer = null;
    this.learning.persist();
  }

  /** Re-read integration settings after they change (new API key, new adapter). */
  async reconfigure() {
    if (!this.customLlm) this.llm = this.#createLanguageModel();
    this.voice.reset?.();
    this.#refreshConfig();
    for (const skill of this.registry.skills.values()) {
      if (skill.reconfigure) await skill.reconfigure(this.ctx);
      else if (skill.id === 'smarthome' || skill.id === 'tasks') await skill.setup(this.ctx);
    }
    this.events.publish('integrations.changed', {});
  }

  #turnContext(session, channel, turnId) {
    return { ...this.ctx, session, channel, turnId, actor: 'user' };
  }

  /**
   * Handle one utterance end to end: understand, act, learn, remember.
   * @returns {{turnId, reply:{text,speech,cards}, intents, source, confidence, suggestions, awaiting}}
   */
  async handle({ text, sessionId = 'default', channel = 'text', replay = false } = {}) {
    const check = this.security.validateText(text);
    const session = this.contexts.get(sessionId);
    if (!check.ok) {
      return { turnId: null, reply: { text: "I didn't catch that. Could you say it again?", speech: "I didn't catch that. Could you say it again?", cards: [] }, intents: [], source: 'none', confidence: 0, suggestions: [], error: check.reason };
    }
    const utterance = check.text;
    const now = this.now();
    const turnId = newId('turn');
    const ctx = this.#turnContext(session, channel, turnId);
    const incognito = Boolean(this.profile.get('incognito'));

    const understanding = this.nlu.understand(utterance, session);
    session.setPending(null); // a pending question is either answered by this turn or abandoned

    let reply = null;
    let source = understanding.source;
    let handled = [];
    const top = understanding.intents[0];
    const confident = top && (understanding.confidence >= this.nlu.threshold || ['classifier', 'clarification', 'learned'].includes(understanding.source));
    const preferModel = this.llm.enabled && (top?.slots?.generic || !confident);

    if (confident && !preferModel) {
      const replies = [];
      for (const item of understanding.intents) {
        const slots = session.resolve(item.intent, item.slots);
        try {
          const result = await this.registry.dispatch(item.intent, slots, ctx);
          replies.push(result);
          handled.push({ intent: item.intent, slots: result.slots ?? slots, confidence: item.confidence, source: item.source ?? understanding.source });
          if (result.track) session.track(result.track);
          if (result.pending) session.setPending(result.pending);
          session.lastIntent = item.intent;
        } catch (error) {
          this.logger.error?.(`[jarvis] ${item.intent} failed:`, error);
          replies.push({ text: `Something went wrong while I was handling that (${error.message}).`, failed: true });
        }
      }
      reply = {
        text: replies.map((r) => r.text).filter(Boolean).join(' '),
        cards: replies.flatMap((r) => r.cards ?? []),
        speech: replies.some((r) => r.speech) ? replies.map((r) => r.speech ?? r.text).join(' ') : undefined,
        unresolved: replies.every((r) => r.unresolved),
      };
    }

    if ((!reply || reply.unresolved) && this.llm.enabled) {
      const result = await this.llm.converse({
        system: SYSTEM_PROMPT,
        context: this.#modelContext(session, now),
        history: session.history(),
        message: utterance,
        tools: this.registry.tools({ ...ctx, actor: 'assistant' }),
      });
      if (result.text) {
        reply = { text: result.text, cards: [] };
        source = 'language-model';
        handled = result.calls.length
          ? result.calls.map((call) => ({ intent: `tool.${call.name}`, slots: call.input, confidence: 1, source: 'language-model' }))
          : [{ intent: 'conversation', slots: {}, confidence: 1, source: 'language-model' }];
      } else if (result.refused && !reply) {
        reply = { text: "I'm not able to help with that request.", cards: [] };
        source = 'language-model';
      } else if (!reply && result.error) {
        reply = { text: `${result.message ?? 'The language model is unavailable.'} I can still handle commands like "help", "what are my tasks" or "turn on the kitchen lights".`, cards: [] };
        source = 'none';
      }
    }

    if (!reply) {
      // No rule, no learned phrase, no language model: best-effort fallback.
      const weak = top && understanding.confidence >= 0.6;
      if (weak) {
        try {
          const slots = session.resolve(top.intent, top.slots);
          const result = await this.registry.dispatch(top.intent, slots, ctx);
          handled.push({ intent: top.intent, slots: result.slots ?? slots, confidence: top.confidence, source: 'rules' });
          if (result.track) session.track(result.track);
          if (result.pending) session.setPending(result.pending);
          reply = { text: result.text, cards: result.cards ?? [] };
        } catch { reply = null; }
      }
      if (!reply) {
        if (!incognito) this.learning.recordMiss(utterance);
        const guess = understanding.alternatives?.find((a) => a.source === 'classifier' && a.confidence >= 0.45);
        const example = guess ? this.registry.describe(guess.intent)?.examples?.[0] : null;
        reply = {
          text: example
            ? `I'm not sure I understood. Did you mean something like "${example}"? You can also say "help" to see what I can do.`
            : `I'm not sure how to help with that yet. Say "help" to see what I can do${this.llm.enabled ? '' : ', or connect a language model in Settings for open-ended questions'}.`,
          cards: [],
        };
        source = 'none';
      }
    }

    // Personalization and continuous learning.
    if (!incognito) {
      for (const item of handled) {
        this.profile.learn({ intent: item.intent, slots: item.slots, at: now });
        this.learning.recordInteraction({ utterance, intent: item.intent, confidence: item.confidence, source: item.source });
      }
    }

    session.remember({ role: 'user', text: utterance });
    session.remember({ role: 'assistant', text: reply.text });
    const primary = handled[0]?.intent ?? null;
    if (!primary?.startsWith('feedback.')) session.lastExchange = { turnId, utterance, intent: primary, source };

    if (!incognito && !replay) {
      this.conversations.insert({ id: turnId, sessionId, channel, utterance, reply: reply.text, intents: handled.map((h) => ({ intent: h.intent, confidence: h.confidence, source: h.source })), source, confidence: understanding.confidence });
      const all = this.conversations.all();
      if (all.length > 2000) this.conversations.replace(all.slice(-2000));
    }

    return {
      turnId,
      reply: { text: reply.text, speech: toSpeech(reply.speech ?? reply.text), cards: reply.cards ?? [] },
      intents: handled.map((h) => ({ intent: h.intent, confidence: h.confidence, source: h.source })),
      source,
      confidence: Number(understanding.confidence.toFixed(3)),
      awaiting: Boolean(session.pending),
      suggestions: await this.suggestions(session),
      incognito,
    };
  }

  #modelContext(session, now) {
    const lines = [`Current local date and time: ${now.toLocaleString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: 'numeric', minute: '2-digit' })}.`];
    const profile = this.profile.summary();
    if (profile) lines.push(profile);
    const context = session.summary();
    if (context) lines.push(`Conversation context: ${context}.`);
    return lines.join('\n');
  }

  /** Proactive suggestions: learned habits plus what skills notice (overdue tasks, rain, unlocked doors). */
  async suggestions(session = this.contexts.get('default')) {
    const ctx = this.#turnContext(session, 'system', null);
    const extra = await this.registry.suggestions(ctx);
    return this.profile.suggestions({ now: this.now(), extra });
  }

  /** Record a rating or correction and feed it to the learning engine. */
  feedback({ turnId = null, utterance = null, intent = null, rating, comment = null, correctedIntent = null, sessionId = null } = {}) {
    if (!['up', 'down'].includes(rating)) throw new Error('rating must be "up" or "down"');
    const turn = turnId ? this.conversations.get(turnId) : null;
    const record = this.learning.applyFeedback({
      turnId,
      sessionId: sessionId ?? turn?.sessionId ?? null,
      utterance: utterance ?? turn?.utterance ?? null,
      intent: intent ?? turn?.intents?.[0]?.intent ?? null,
      rating,
      comment: comment ? String(comment).slice(0, 500) : null,
      correctedIntent: correctedIntent && this.registry.has(correctedIntent) ? correctedIntent : null,
    });
    this.security.audit('feedback.received', { rating, corrected: Boolean(record.learned) });
    return record;
  }

  history({ sessionId = null, limit = 30 } = {}) {
    const all = this.conversations.all().filter((t) => !sessionId || t.sessionId === sessionId);
    return all.slice(-limit).map((t) => ({ turnId: t.id, at: t.createdAt, utterance: t.utterance, reply: t.reply, intents: t.intents, source: t.source }));
  }

  /** Everything the dashboard needs in one call. */
  async dashboard(sessionId = 'default') {
    const session = this.contexts.get(sessionId);
    const ctx = this.#turnContext(session, 'dashboard', null);
    return {
      version: VERSION,
      now: this.now().toISOString(),
      profile: this.profile.preferences,
      skills: await this.registry.snapshot(ctx),
      suggestions: await this.suggestions(session),
      learning: this.learning.report(),
      activity: this.profile.activityByHour(),
      interests: this.profile.topInterests(6),
      llm: { enabled: this.llm.enabled, model: this.llm.model ?? null },
      voice: this.voice.status(),
      security: { authRequired: this.security.authRequired, encryption: this.encryption, incognito: Boolean(this.profile.get('incognito')) },
      integrations: this.integrations.list().map((i) => ({ id: i.id, name: i.name, category: i.category, configured: i.configured, builtIn: i.builtIn })),
      capabilities: this.registry.list(),
    };
  }

  // -- privacy controls -------------------------------------------------------
  privacyReport() {
    const count = (name) => {
      const value = this.store.read(name, []);
      return Array.isArray(value) ? value.length : 0;
    };
    return {
      profile: this.profile.preferences,
      counts: { conversations: count('conversations'), tasks: count('tasks'), reminders: count('reminders'), events: count('events'), 'feedback entries': count('feedback'), devices: count('devices'), 'audit entries': count('audit') },
      learned: { phrases: this.learning.report().aliasCount, samples: this.learning.report().samples, interests: this.profile.topInterests(5).map((i) => i.topic) },
      encryption: this.encryption,
      storage: this.storageLabel ?? (this.config.dataDir ? `Local files in ${this.config.dataDir}` : 'In memory only (nothing is written to disk)'),
      retentionDays: this.profile.get('retentionDays'),
      incognito: Boolean(this.profile.get('incognito')),
      thirdParties: this.integrations.list().filter((i) => i.configured).map((i) => ({ name: i.name, sends: describeSharing(i.id) })),
      voice: this.voice.status().tts
        ? 'Natural voice is on. The text of replies, and your recordings when you use cloud recognition, are sent to ElevenLabs.'
        : 'Speech uses your browser. JARVIS sends no audio anywhere.',
      languageModel: this.llm.enabled
        ? 'On. Messages the built-in rules cannot handle are sent to the Anthropic API together with brief context (time, preferences, recent turns).'
        : 'Off. Nothing you say leaves this machine except the specific lookups you ask for (weather, news, search).',
    };
  }

  exportData() {
    this.security.audit('privacy.export', {});
    const read = (name, fallback) => this.store.read(name, fallback);
    return {
      exportedAt: this.now().toISOString(),
      version: VERSION,
      profile: this.profile.export(),
      conversations: read('conversations', []),
      tasks: read('tasks', []),
      reminders: read('reminders', []),
      events: read('events', []),
      devices: read('devices', []),
      feedback: read('feedback', []),
      learning: { stats: read('learning', {}), learnedPhrases: read('aliases', {}) },
      audit: read('audit', []),
      integrations: this.integrations.list().map((i) => ({ id: i.id, configured: i.configured, fields: i.fields.map((f) => ({ key: f.key, set: f.set, value: f.secret ? (f.set ? '[secret not exported]' : null) : f.value })) })),
    };
  }

  /** Delete stored data. scope: "history" | "learning" | "all". */
  async forget(scope = 'all') {
    let removed = 0;
    if (scope === 'history') {
      this.conversations.clear();
      this.contexts.clearAll();
      removed = 1;
    } else if (scope === 'learning') {
      this.learning.reset();
      this.profile.data.habits = { intents: {}, devices: {}, topics: {}, total: 0 };
      this.profile.data.interests = {};
      this.profile.data.dismissedSuggestions = {};
      this.profile.save();
      this.nlu.seed();
      removed = 3;
    } else {
      removed = this.store.names().length;
      this.store.wipe();
      this.contexts.clearAll();
      this.profile.reset();
      this.learning.reset();
      this.nlu.seed();
      await this.reconfigure();
    }
    this.security.audit('privacy.forget', { scope });
    this.events.publish('privacy.forgotten', { scope });
    return { scope, removed };
  }

  /** Drop conversation turns older than the retention window. */
  applyRetention() {
    const days = Number(this.profile.get('retentionDays') ?? 30);
    const cutoff = this.now().getTime() - days * 86_400_000;
    const all = this.conversations.all();
    const kept = all.filter((t) => new Date(t.createdAt).getTime() >= cutoff);
    if (kept.length !== all.length) this.conversations.replace(kept);
    return all.length - kept.length;
  }
}

function describeSharing(id) {
  switch (id) {
    case 'anthropic': return 'messages the rules cannot handle, plus brief context';
    case 'open-meteo': return 'the city name you ask about';
    case 'wikipedia':
    case 'duckduckgo': return 'your search query';
    case 'google-news': return 'the news topic you ask about';
    case 'homeassistant':
    case 'hue': return 'device commands, on your local network';
    case 'google-calendar': return 'events you create or read';
    case 'mastodon':
    case 'webhook': return 'posts you explicitly confirm';
    case 'elevenlabs': return 'reply text to speak, and your recordings when cloud recognition is used';
    default: return 'requests you make';
  }
}

export async function createJarvis(options = {}) {
  const jarvis = new Jarvis(options);
  await jarvis.ready();
  return jarvis;
}
