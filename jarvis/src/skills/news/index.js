import { fetchText, fetchJson, decodeEntities } from '../../core/http.js';

const GOOGLE_TOP = 'https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en';
const GOOGLE_SEARCH = (q) => `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-US&gl=US&ceid=US:en`;

const tag = (xml, name) => {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  if (!m) return '';
  return decodeEntities(m[1].replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
};

/** Minimal RSS 2.0 / Atom parser: enough for headline feeds, no dependencies. */
export function parseFeed(xml) {
  const items = [];
  const blocks = String(xml ?? '').match(/<item[\s>][\s\S]*?<\/item>|<entry[\s>][\s\S]*?<\/entry>/gi) ?? [];
  for (const block of blocks) {
    let title = tag(block, 'title');
    let source = tag(block, 'source');
    let link = tag(block, 'link');
    if (!link) {
      const href = /<link[^>]+href=["']([^"']+)["']/i.exec(block);
      if (href) link = href[1];
    }
    const published = tag(block, 'pubDate') || tag(block, 'updated') || tag(block, 'published');
    if (!source) {
      const split = title.lastIndexOf(' - ');
      if (split > 20) { source = title.slice(split + 3); title = title.slice(0, split); }
    } else if (title.endsWith(` - ${source}`)) {
      title = title.slice(0, -(source.length + 3));
    }
    if (!title) continue;
    const date = published ? new Date(published) : null;
    items.push({ title, link, source: source || null, published: date && !Number.isNaN(date.getTime()) ? date.toISOString() : null });
  }
  return items;
}

export function timeAgo(iso, now = new Date()) {
  if (!iso) return '';
  const minutes = Math.max(0, Math.round((now - new Date(iso)) / 60_000));
  if (minutes < 60) return `${minutes || 1}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

export function createNewsSkill() {
  const cache = new Map();

  async function fetchFeed(url) {
    const hit = cache.get(url);
    if (hit && Date.now() - hit.at < 15 * 60_000) return hit.items;
    const xml = await fetchText(url, { timeoutMs: 10_000, headers: { accept: 'application/rss+xml, application/xml, text/xml' } });
    const items = parseFeed(xml);
    cache.set(url, { at: Date.now(), items });
    return items;
  }

  async function hackerNews(topic) {
    const key = `hn:${topic ?? ''}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 15 * 60_000) return hit.items;
    const url = topic
      ? `https://hn.algolia.com/api/v1/search?tags=story&query=${encodeURIComponent(topic)}`
      : 'https://hn.algolia.com/api/v1/search?tags=front_page';
    const data = await fetchJson(url);
    const items = (data.hits ?? []).filter((x) => x.title).map((x) => ({
      title: decodeEntities(x.title), link: x.url || `https://news.ycombinator.com/item?id=${x.objectID}`,
      source: 'Hacker News', published: x.created_at ?? null,
    }));
    cache.set(key, { at: Date.now(), items });
    return items;
  }

  async function headlines(topic, ctx, limit = 6) {
    try {
      return await headlinesFromFeeds(topic, ctx, limit);
    } catch (error) {
      // Feeds can be unreachable (offline, or blocked by CORS in the standalone page).
      try {
        const now = ctx.now();
        return (await hackerNews(topic)).slice(0, limit).map((item) => ({ ...item, ago: timeAgo(item.published, now) }));
      } catch {
        throw error;
      }
    }
  }

  async function headlinesFromFeeds(topic, ctx, limit) {
    const custom = (ctx.config.newsFeeds ?? []).filter(Boolean);
    let items;
    if (topic) items = await fetchFeed(GOOGLE_SEARCH(topic));
    else if (custom.length) {
      const lists = await Promise.allSettled(custom.map(fetchFeed));
      items = lists.flatMap((r) => (r.status === 'fulfilled' ? r.value : [])).sort((a, b) => new Date(b.published ?? 0) - new Date(a.published ?? 0));
    } else items = await fetchFeed(GOOGLE_TOP);
    const now = ctx.now();
    return items.slice(0, limit).map((item) => ({ ...item, ago: timeAgo(item.published, now) }));
  }

  async function handler(slots, ctx) {
    try {
      if (slots.briefing) {
        const topics = (ctx.profile.get('newsTopics') ?? []).slice(0, 3);
        if (!topics.length) return handler({}, ctx);
        const sections = [];
        for (const topic of topics) {
          const items = await headlines(topic, ctx, 3);
          if (items.length) sections.push({ topic, items });
        }
        if (!sections.length) return { text: "I couldn't find any news for your topics right now." };
        const spoken = sections.map((s) => `In ${s.topic}: ${s.items[0].title}.`).join(' ');
        return { text: `Here's your briefing. ${spoken}`, cards: sections.map((s) => ({ type: 'news', title: `${s.topic[0].toUpperCase()}${s.topic.slice(1)}`, items: s.items })), slots: { briefing: true } };
      }
      const topic = slots.topic ? String(slots.topic).replace(/^(the|some|any|latest)\s+/, '').trim() : null;
      const items = await headlines(topic, ctx);
      if (!items.length) return { text: topic ? `I couldn't find recent news about ${topic}.` : "I couldn't load the headlines right now." };
      const spoken = items.slice(0, 3).map((item, i) => `${i + 1}. ${item.title}${item.source ? ` (${item.source})` : ''}.`).join(' ');
      return {
        text: `${topic ? `Here's the latest on ${topic}` : 'Here are the top headlines'}: ${spoken}`,
        cards: [{ type: 'news', title: topic ? `News: ${topic}` : 'Top headlines', items }],
        track: { lastTopic: topic ?? undefined },
        slots: topic ? { topic } : {},
      };
    } catch (error) {
      return { text: `I couldn't reach the news service just now (${error.message}). Please try again shortly.` };
    }
  }

  return {
    id: 'news',
    name: 'News',
    description: 'Top headlines and topic searches from Google News RSS or your own RSS feeds, plus a personalized briefing from your saved topics.',

    intents: [
      {
        name: 'news.headlines',
        priority: 4,
        examples: ["what's in the news", 'give me the latest headlines', 'news about electric cars', "what's happening in the world", 'my news briefing', 'tech news', 'any news on the election'],
        patterns: [
          /^(?:what is (?:in\s+)?the news|what is happening(?: in the world| today)?|what is going on in the world|(?:show|read|get|give|tell) me (?:the\s+|some\s+)?(?:latest\s+|top\s+|today's\s+|todays\s+)?(?:news|headlines)|(?:the\s+)?(?:latest\s+|top\s+|today's\s+|todays\s+)?(?:news|headlines)|any news|news update|catch me up(?: on the news)?)(?:\s+(?:about|on|in|regarding|for|from)\s+(.+?))?(?:\s+today)?$/,
          /^(?:news|headlines)\s+(?:about|on|for|in)\s+(.+)$/,
          /^what is (?:new|going on|happening|the latest)\s+(?:with|in|about|on)\s+(.+)$/,
          /^(?:my\s+|the\s+)?(news briefing|briefing|daily news|morning news|daily briefing)$/,
          /^(?!.*\b(?:the|what|is|any|my)\b)([a-z][a-z ]{2,30})\s+(?:news|headlines)$/,
        ],
        slots: (m, { stripped }) => {
          if (/(?:news briefing|^briefing|daily news|morning news|daily briefing)$/.test(stripped)) return { briefing: true };
          const topic = m[1]?.trim();
          if (topic && /^(the|world|top|latest|today)$/.test(topic)) return {};
          return topic ? { topic } : {};
        },
        handler,
      },
    ],

    tools: [
      {
        name: 'get_news',
        description: 'Fetch current news headlines, optionally about a topic. Call this when the user asks what is happening, wants headlines, or asks for news about something.',
        input_schema: {
          type: 'object',
          properties: { topic: { type: ['string', 'null'], description: 'Topic to search for, e.g. "electric cars". Null for the general top headlines.' } },
          required: ['topic'],
          additionalProperties: false,
        },
        run: async ({ topic }, ctx) => {
          try {
            const items = await headlines(topic, ctx);
            return { headlines: items.map((i) => ({ title: i.title, source: i.source, published: i.ago, link: i.link })) };
          } catch (error) {
            return { error: `news service unavailable: ${error.message}` };
          }
        },
      },
    ],

    snapshot: async (ctx) => {
      try {
        const topic = (ctx.profile.get('newsTopics') ?? [])[0] ?? null;
        return { topic, items: await headlines(topic, ctx, 5) };
      } catch (error) {
        return { items: [], error: error.message };
      }
    },
  };
}
