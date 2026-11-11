import { fetchJson, fetchWithTimeout, htmlToText } from '../../core/http.js';

const SERVICE_ALIASES = { mastodon: 'mastodon', slack: 'webhook', discord: 'webhook', webhook: 'webhook', 'the webhook': 'webhook', 'social media': 'mastodon', social: 'mastodon' };
const SERVICE_RE = 'mastodon|slack|discord|the webhook|webhook|social media|social';

/**
 * Social and messaging adapters. Posting is outward-facing, so every post is
 * confirmed by the user before it leaves JARVIS.
 */
function adapters(ctx) {
  const mastodon = ctx.integrations.config('mastodon');
  const webhook = ctx.integrations.config('webhook');
  return {
    mastodon: mastodon.url && mastodon.token ? {
      label: 'Mastodon',
      async post(text) {
        const response = await fetchWithTimeout(`${mastodon.url.replace(/\/$/, '')}/api/v1/statuses`, {
          method: 'POST',
          headers: { authorization: `Bearer ${mastodon.token}`, 'content-type': 'application/json' },
          body: JSON.stringify({ status: text, visibility: mastodon.visibility || 'public' }),
        });
        if (!response.ok) throw new Error(`Mastodon responded ${response.status}`);
        const data = await response.json();
        return { url: data.url ?? null };
      },
      async timeline(limit = 5) {
        const items = await fetchJson(`${mastodon.url.replace(/\/$/, '')}/api/v1/timelines/home?limit=${limit}`, { headers: { authorization: `Bearer ${mastodon.token}` } });
        return items.map((s) => ({ author: s.account?.display_name || s.account?.acct, text: htmlToText(s.content ?? '').slice(0, 280), url: s.url, published: s.created_at }));
      },
    } : null,
    webhook: webhook.url ? {
      label: 'Webhook',
      async post(text) {
        const response = await fetchWithTimeout(webhook.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, content: text }) });
        if (!response.ok) throw new Error(`Webhook responded ${response.status}`);
        return { url: null };
      },
    } : null,
  };
}

export function createSocialSkill() {
  const notConnected = (service) => ({
    text: `${service === 'webhook' ? 'The webhook' : 'Mastodon'} isn't connected yet. Open Settings, choose Integrations, and add your ${service === 'webhook' ? 'Slack or Discord webhook URL' : 'Mastodon server address and access token'}.`,
  });

  async function post(slots, ctx) {
    const service = SERVICE_ALIASES[String(slots.service ?? 'mastodon').toLowerCase()] ?? 'mastodon';
    const text = String(slots.text ?? ctx.session?.entities?.lastDraft ?? '').trim();
    if (!text) return { text: 'What should the post say?', pending: { intent: 'social.post', slots: { service }, slot: 'text' } };
    if (text.length > 500) return { text: `That post is ${text.length} characters, which is over the 500 character limit. Could you shorten it?` };
    const adapter = adapters(ctx)[service];
    if (!adapter) return notConnected(service);
    if (slots.confirm === undefined) {
      return { text: `Ready to post to ${adapter.label}: "${text}". Say "yes" to publish it.`, pending: { intent: 'social.post', slots: { service, text }, slot: 'confirm' } };
    }
    if (slots.confirm !== 'yes') return { text: "Okay, I won't post it." };
    try {
      const result = await adapter.post(text);
      ctx.security.audit('social.post', { service, length: text.length });
      return { text: `Posted to ${adapter.label}.${result.url ? ` ${result.url}` : ''}` };
    } catch (error) {
      return { text: `The post didn't go through (${error.message}).` };
    }
  }

  async function timeline(slots, ctx) {
    const adapter = adapters(ctx).mastodon;
    if (!adapter) return notConnected('mastodon');
    try {
      const items = await adapter.timeline(5);
      if (!items.length) return { text: 'Your timeline is quiet right now.' };
      return {
        text: `Here's the latest from your timeline: ${items.slice(0, 3).map((i) => `${i.author} says: ${i.text.slice(0, 140)}`).join(' ')}`,
        cards: [{ type: 'news', title: 'Mastodon timeline', items: items.map((i) => ({ title: i.text, source: i.author, link: i.url, published: i.published, ago: '' })) }],
      };
    } catch (error) {
      return { text: `I couldn't load your timeline (${error.message}).` };
    }
  }

  async function draft(slots, ctx) {
    const topic = String(slots.topic ?? '').trim();
    if (!topic) return { text: 'What should the post be about?', pending: { intent: 'social.draft', slots: {}, slot: 'topic' } };
    let text = '';
    if (ctx.llm?.enabled) {
      const result = await ctx.llm.complete({
        system: 'You write short social media posts. Reply with the post text only: one or two sentences, under 280 characters, natural and specific, at most one hashtag, no quotation marks around it.',
        prompt: `Write a post about: ${topic}`,
        maxTokens: 2000,
      });
      text = result.text;
    }
    if (!text) text = `${topic[0].toUpperCase()}${topic.slice(1)}. More soon.`;
    return { text: `Here's a draft: "${text}". Say "post it" to publish, or tell me what to change.`, track: { lastDraft: text }, cards: [{ type: 'info', title: 'Draft post', body: text }] };
  }

  const original = (text, re) => re.exec(String(text).trim().replace(/[“”]/g, '"'));

  return {
    id: 'social',
    name: 'Social & Messaging',
    description: 'Drafts posts, publishes them to Mastodon or a Slack/Discord webhook after you confirm, and reads your Mastodon timeline.',

    intents: [
      {
        name: 'social.post',
        priority: 3,
        examples: ['post to mastodon: hello world', 'share this on slack: the build is green', 'toot: enjoying the sunshine', 'post it'],
        patterns: [
          new RegExp(`^(?:post|publish|share|send|toot|tweet)\\s+(?:this\\s+)?(?:to|on)\\s+(${SERVICE_RE})\\s*[:,-]?\\s*(.+)$`),
          new RegExp(`^(?:post|publish|share|toot|tweet)\\s+(.+?)\\s+(?:to|on)\\s+(${SERVICE_RE})$`),
          /^(?:toot|post (?:a )?(?:status|update))\s*[:,-]?\s+(.+)$/,
          new RegExp(`^(?:post|publish|share|send)\\s+(?:it|that|the draft|this)(?:\\s+(?:to|on)\\s+(${SERVICE_RE}))?$`),
        ],
        slots: (m, { text, stripped }) => {
          if (/^(?:post|publish|share|send)\s+(?:it|that|the draft|this)\b/.test(stripped)) return { service: m[1] ?? 'mastodon' };
          const a = original(text, new RegExp(`(?:post|publish|share|send|toot|tweet)\\s+(?:this\\s+)?(?:to|on)\\s+(${SERVICE_RE})\\s*[:,-]?\\s*(.+)$`, 'i'));
          if (a) return { service: a[1].toLowerCase(), text: a[2].replace(/^["']|["']$/g, '') };
          const b = original(text, new RegExp(`(?:post|publish|share|toot|tweet)\\s+(.+?)\\s+(?:to|on)\\s+(${SERVICE_RE})[.!]?$`, 'i'));
          if (b) return { service: b[2].toLowerCase(), text: b[1].replace(/^["']|["']$/g, '') };
          const c = original(text, /(?:toot|post (?:a )?(?:status|update))\s*[:,-]?\s+(.+)$/i);
          return c ? { service: 'mastodon', text: c[1].replace(/^["']|["']$/g, '') } : null;
        },
        handler: post,
      },
      {
        name: 'social.timeline',
        priority: 3,
        examples: ['check my mastodon', "what's new on social media", 'read my timeline', 'show my feed'],
        patterns: [
          /^(?:what is (?:new|happening) on|show (?:me\s+)?(?:my\s+)?|read (?:me\s+)?(?:my\s+)?|check (?:my\s+)?|open (?:my\s+)?)\s*(?:mastodon|social media|social|timeline|feed)(?:\s+(?:timeline|feed))?$/,
        ],
        handler: timeline,
      },
      {
        name: 'social.draft',
        priority: 3,
        examples: ['draft a post about our product launch', 'write a tweet about the new office', 'compose a status about the weekend hike'],
        patterns: [
          /^(?:draft|write|compose|create|prepare)\s+(?:me\s+)?(?:a\s+|an\s+)?(?:short\s+)?(?:social media\s+|mastodon\s+|linkedin\s+)?(?:post|tweet|toot|status|update|caption)\s+(?:about|on|for|announcing|regarding)\s+(.+)$/,
        ],
        slots: (m) => ({ topic: m[1].trim() }),
        handler: draft,
      },
    ],

    tools: [
      {
        name: 'social_post',
        description: 'Prepare a post for Mastodon or a Slack/Discord webhook. Call this when the user asks to post or share a message publicly. The post is only published after the user confirms, so tell them to say "yes".',
        input_schema: {
          type: 'object',
          properties: { service: { type: 'string', enum: ['mastodon', 'webhook'] }, text: { type: 'string', description: 'The exact text to publish, at most 500 characters.' } },
          required: ['service', 'text'],
          additionalProperties: false,
        },
        run: async ({ service, text }, ctx) => {
          const result = await post({ service, text }, ctx);
          if (result.pending) ctx.session?.setPending(result.pending);
          return { result: result.text, needs_confirmation: Boolean(result.pending) };
        },
      },
    ],

    snapshot: (ctx) => {
      const a = adapters(ctx);
      return { mastodon: Boolean(a.mastodon), webhook: Boolean(a.webhook) };
    },
  };
}
