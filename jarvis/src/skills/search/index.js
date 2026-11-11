import { fetchJson, fetchText, htmlToText, extractTitle, isPublicUrl } from '../../core/http.js';
import { summarizeText, firstSentences } from './summarize.js';

const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const WIKI_SUMMARY = 'https://en.wikipedia.org/api/rest_v1/page/summary/';
const DDG = 'https://api.duckduckgo.com/';

/** Strip conversational wrappers so the search engines see the topic. */
export function topicOf(query) {
  return String(query ?? '')
    .toLowerCase()
    .replace(/[?!.]+$/g, '')
    .replace(/^(?:please\s+)?(?:can you\s+|could you\s+)?(?:tell me\s+(?:about\s+)?|search (?:the web\s+)?(?:for\s+)?|look up\s+|google\s+|find (?:out\s+)?(?:information\s+)?(?:about\s+|on\s+)?|explain\s+|define\s+|describe\s+)/, '')
    .replace(/^(?:who|what|where|when|which)\s+(?:is|are|was|were)\s+(?:the\s+|an?\s+)?/, '')
    .replace(/^(?:what do you know about|give me (?:info|information|details) (?:on|about))\s+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function wikipedia(query, { limit = 2 } = {}) {
  const url = `${WIKI_API}?action=query&list=search&srsearch=${encodeURIComponent(query)}&srlimit=${limit}&format=json&origin=*`;
  const data = await fetchJson(url);
  const hits = data?.query?.search ?? [];
  const pages = [];
  for (const hit of hits) {
    try {
      const page = await fetchJson(`${WIKI_SUMMARY}${encodeURIComponent(hit.title.replace(/ /g, '_'))}`);
      if (page.type === 'disambiguation' || !page.extract) continue;
      pages.push({ title: page.title, description: page.description ?? '', text: page.extract, url: page.content_urls?.desktop?.page ?? `https://en.wikipedia.org/wiki/${encodeURIComponent(hit.title)}`, source: 'Wikipedia', image: page.thumbnail?.source ?? null });
    } catch { /* skip pages that fail to load */ }
  }
  return pages;
}

async function duckduckgo(query) {
  const data = await fetchJson(`${DDG}?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1&t=jarvis`);
  const out = [];
  if (data.Answer) out.push({ title: data.Heading || query, text: String(data.Answer), url: data.AbstractURL || `https://duckduckgo.com/?q=${encodeURIComponent(query)}`, source: 'DuckDuckGo', instant: true });
  if (data.AbstractText) out.push({ title: data.Heading || query, text: data.AbstractText, url: data.AbstractURL, source: data.AbstractSource || 'DuckDuckGo' });
  if (data.Definition) out.push({ title: data.Heading || query, text: data.Definition, url: data.DefinitionURL, source: data.DefinitionSource || 'DuckDuckGo' });
  for (const topic of (data.RelatedTopics ?? []).slice(0, 3)) {
    if (topic.Text && topic.FirstURL) out.push({ title: topic.Text.split(' - ')[0].slice(0, 80), text: topic.Text, url: topic.FirstURL, source: 'DuckDuckGo', related: true });
  }
  return out;
}

export function createSearchSkill() {
  const cache = new Map();

  async function gather(query) {
    const key = query.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.sources;
    const topic = topicOf(query) || query;
    const [ddg, wiki] = await Promise.allSettled([duckduckgo(query), wikipedia(topic)]);
    const sources = [];
    const d = ddg.status === 'fulfilled' ? ddg.value : [];
    const w = wiki.status === 'fulfilled' ? wiki.value : [];
    sources.push(...d.filter((s) => s.instant));
    sources.push(...w);
    sources.push(...d.filter((s) => !s.instant && !s.related));
    if (!sources.length) sources.push(...d.filter((s) => s.related));
    const errors = [ddg, wiki].filter((r) => r.status === 'rejected').map((r) => r.reason?.message);
    if (sources.length) cache.set(key, { at: Date.now(), sources });
    if (cache.size > 200) cache.delete(cache.keys().next().value);
    return Object.assign(sources, { errors });
  }

  async function lookup(slots, ctx) {
    const query = String(slots.query ?? '').trim();
    if (!query) return { text: 'What would you like me to look up?', pending: { intent: 'search.lookup', slots: {}, slot: 'query' } };
    ctx.security.audit('search.lookup', { query });
    let sources;
    try {
      sources = await gather(query);
    } catch (error) {
      return { text: `I couldn't reach the search services just now (${error.message}). Please try again in a moment.` };
    }
    if (!sources.length) {
      const offline = sources.errors?.length === 2;
      return { text: offline ? "I couldn't reach the search services just now. Please check the network connection and try again." : `I couldn't find anything reliable about "${query}". Try rephrasing it?`, track: { lastTopic: query } };
    }
    const top = sources[0];
    let answer = top.instant ? top.text : firstSentences(top.text, 2);
    let via = 'extract';
    if (ctx.llm?.enabled && !top.instant && ctx.llm.answer) {
      const composed = await ctx.llm.answer({ question: query, sources: sources.slice(0, 3) });
      if (composed.text) { answer = composed.text; via = 'language-model'; }
    }
    return {
      text: answer,
      cards: [{ type: 'search', title: `Results for "${query}"`, items: sources.slice(0, 4).map((s) => ({ title: s.title, snippet: firstSentences(s.text, 2, 260), url: s.url, source: s.source, image: s.image ?? null })) }],
      track: { lastTopic: topicOf(query) || query },
      slots: { query: topicOf(query) || query },
      meta: { via },
    };
  }

  async function summarize(slots, ctx) {
    const url = slots.url;
    let title = '';
    let text = slots.text ?? '';
    if (url) {
      if (!isPublicUrl(url)) return { text: "I can only summarize public web pages, and that address doesn't look like one." };
      ctx.security.audit('search.summarize', { url });
      try {
        const html = await fetchText(url, { timeoutMs: 12_000, headers: { accept: 'text/html,application/xhtml+xml' } });
        title = extractTitle(html);
        text = htmlToText(html.slice(0, 2_000_000));
      } catch (error) {
        const hint = typeof window !== 'undefined' ? ' Many sites block direct access from a web page. Paste the article text after "summarize" instead.' : '';
        return { text: `I couldn't load that page (${error.message}).${hint}` };
      }
    }
    if (text.length < 200) return { text: url ? "I loaded the page but couldn't find enough readable text to summarize." : 'Give me a link or paste the text you want summarized.' };
    let summary;
    let method = 'extractive';
    if (ctx.llm?.enabled) {
      const result = await ctx.llm.summarize({ text, title, url: url ?? '' });
      if (result.text) { summary = result.text; method = 'language-model'; }
    }
    if (!summary) summary = summarizeText(text, { sentences: 4 }).summary;
    const words = text.split(/\s+/).length;
    return {
      text: `${title ? `"${title}": ` : ''}${summary}`,
      cards: [{ type: 'summary', title: title || 'Summary', url: url ?? null, summary, method, stats: { words, readingMinutes: Math.max(1, Math.round(words / 230)) } }],
      track: { lastTopic: title || undefined },
      meta: { via: method },
    };
  }

  return {
    id: 'search',
    name: 'Information Retrieval',
    description: 'Answers factual questions from Wikipedia and DuckDuckGo, and summarizes web pages or pasted text.',

    intents: [
      {
        name: 'search.summarize',
        priority: 5,
        examples: ['summarize https://example.com/article', 'give me a summary of https://news.site/story', 'tldr https://blog.example.org/post'],
        patterns: [
          /^(?:summari[sz]e|tl;?dr|sum up|give me (?:a |the )?(?:summary|gist|tldr) of|what does)\s+(?:this\s+|the\s+)?(?:article|page|link|url|post|story)?\s*(?:at\s+|from\s+|on\s+|:)?\s*(https?:\/\/\S+)(?:\s+say)?$/,
          /^(https?:\/\/\S+)\s+(?:summary|tl;?dr|summari[sz]e(?: this)?)$/,
          /^(?:summari[sz]e|tl;?dr|sum up)\s*(?:this|the following)?\s*[:-]?\s+(.{200,})$/s,
        ],
        slots: (m, { text }) => {
          const url = /(https?:\/\/[^\s"'<>]+)/i.exec(text);
          if (url) return { url: url[1].replace(/[.,;)]+$/, '') };
          const body = /^(?:summari[sz]e|tl;?dr|sum up)\s*(?:this|the following)?\s*[:-]?\s+(.{200,})$/is.exec(text.trim());
          return body ? { text: body[1] } : null;
        },
        handler: summarize,
      },
      {
        name: 'search.lookup',
        examples: ['search for the best hiking trails in colorado', 'look up the eiffel tower', 'who is ada lovelace', 'what is photosynthesis', 'tell me about the roman empire', 'define serendipity', 'how tall is mount everest'],
        patterns: [
          /^(?:search|google|look up|lookup|look for|search for|search the web for|search online for|web search|find out|find (?:me\s+)?(?:information|info) (?:on|about)|find)\s+(?:for\s+|about\s+)?(.+)$/,
          /^(?:tell me about|what do you know about|explain|describe|define|give me (?:info|information|details) (?:on|about)|i want to know about|teach me about)\s+(.+)$/,
          /^((?:who|what|where|when|why|which|how)\s+(?:is|are|was|were|does|do|did|can|could|would|will|many|much|tall|old|far|long|big|fast|high|deep|heavy)\b.+)$/,
        ],
        priority: -3,
        slots: (m, { stripped }) => {
          const generic = /^(?:who|what|where|when|why|which|how)\b/.test(stripped);
          if (generic && /\b(you|your|jarvis)\b/.test(stripped)) return null;
          return { query: m[1].trim(), generic };
        },
        handler: lookup,
      },
    ],

    tools: [
      {
        name: 'web_search',
        description: 'Look up factual information on the web (Wikipedia and DuckDuckGo). Call this when the user asks about a person, place, thing, definition or fact that you are not certain about or that may have changed, and whenever they explicitly ask you to search.',
        input_schema: { type: 'object', properties: { query: { type: 'string', description: 'The search query or question.' } }, required: ['query'], additionalProperties: false },
        run: async ({ query }, ctx) => {
          ctx.security.audit('search.lookup', { query }, 'assistant');
          try {
            const sources = await gather(query);
            return { sources: sources.slice(0, 4).map((s) => ({ title: s.title, text: s.text.slice(0, 1500), url: s.url, source: s.source })) };
          } catch (error) {
            return { error: `search failed: ${error.message}` };
          }
        },
      },
      {
        name: 'summarize_url',
        description: 'Fetch a public web page and return its readable text so it can be summarized. Call this when the user shares a link and wants to know what it says.',
        input_schema: { type: 'object', properties: { url: { type: 'string', description: 'The full http(s) URL.' } }, required: ['url'], additionalProperties: false },
        run: async ({ url }, ctx) => {
          if (!isPublicUrl(url)) return { error: 'only public http(s) URLs can be fetched' };
          ctx.security.audit('search.summarize', { url }, 'assistant');
          try {
            const html = await fetchText(url, { timeoutMs: 12_000 });
            return { title: extractTitle(html), text: htmlToText(html.slice(0, 2_000_000)).slice(0, 40_000) };
          } catch (error) {
            return { error: `could not load the page: ${error.message}` };
          }
        },
      },
    ],
  };
}
