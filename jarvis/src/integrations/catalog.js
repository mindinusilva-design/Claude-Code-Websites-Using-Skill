import Anthropic from '@anthropic-ai/sdk';
import { fetchJson, fetchText } from '../core/http.js';
import { DEFAULT_MODEL } from '../core/nlu/llm.js';
import { DEFAULT_VOICE_ID, DEFAULT_TTS_MODEL, DEFAULT_STT_MODEL, testElevenLabs } from '../voice/index.js';

/** Every third-party service JARVIS can talk to, with its config and a live test. */
export function defineIntegrations(registry) {
  registry
    .define({
      id: 'anthropic',
      name: 'Claude (language model)',
      category: 'Language',
      description: 'Open-ended conversation, multi-step requests and high-quality summaries. Without it JARVIS uses its built-in rules and classifier.',
      docs: 'https://platform.claude.com/',
      fields: [
        { key: 'apiKey', label: 'API key', env: 'ANTHROPIC_API_KEY', secret: true, required: true, placeholder: 'sk-ant-...' },
        { key: 'model', label: 'Model', env: 'JARVIS_LLM_MODEL', default: DEFAULT_MODEL },
        { key: 'effort', label: 'Effort (low, medium, high)', env: 'JARVIS_LLM_EFFORT', default: 'low' },
      ],
      test: async (config) => {
        const client = new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: typeof window !== 'undefined' });
        const model = await client.models.retrieve(config.model ?? DEFAULT_MODEL);
        return `Connected. Model: ${model.display_name ?? model.id}`;
      },
    })
    .define({
      id: 'elevenlabs',
      name: 'ElevenLabs (natural voice)',
      category: 'Voice',
      description: 'A natural, expressive voice for JARVIS, and cloud speech recognition so voice input works in every browser. Without it, JARVIS uses the browser\'s built-in speech.',
      docs: 'https://elevenlabs.io/app/settings/api-keys',
      fields: [
        { key: 'apiKey', label: 'API key', env: 'ELEVENLABS_API_KEY', secret: true, required: true, placeholder: 'sk_...' },
        { key: 'voiceId', label: 'Voice ID', env: 'ELEVENLABS_VOICE_ID', default: DEFAULT_VOICE_ID },
        { key: 'model', label: 'Speech model', env: 'ELEVENLABS_MODEL', default: DEFAULT_TTS_MODEL },
        { key: 'sttModel', label: 'Recognition model', env: 'ELEVENLABS_STT_MODEL', default: DEFAULT_STT_MODEL },
      ],
      test: testElevenLabs,
    })
    .define({
      id: 'open-meteo',
      name: 'Open-Meteo (weather)',
      category: 'Weather',
      description: 'Free weather forecasts and geocoding. No account or key needed.',
      docs: 'https://open-meteo.com/',
      fields: [],
      test: async () => {
        const data = await fetchJson('https://geocoding-api.open-meteo.com/v1/search?name=London&count=1&format=json');
        return data?.results?.length ? 'Reachable' : 'Reachable, but returned no results';
      },
    })
    .define({
      id: 'wikipedia',
      name: 'Wikipedia',
      category: 'Knowledge',
      description: 'Encyclopedic answers and page summaries. No key needed.',
      docs: 'https://en.wikipedia.org/api/rest_v1/',
      fields: [],
      test: async () => {
        const page = await fetchJson('https://en.wikipedia.org/api/rest_v1/page/summary/Earth');
        return page?.title ? 'Reachable' : 'Unexpected response';
      },
    })
    .define({
      id: 'duckduckgo',
      name: 'DuckDuckGo Instant Answers',
      category: 'Knowledge',
      description: 'Quick facts, calculations and definitions. No key needed.',
      docs: 'https://duckduckgo.com/duckduckgo-help-pages/open-source/instant-answer-interface/',
      fields: [],
      test: async () => {
        await fetchJson('https://api.duckduckgo.com/?q=jarvis&format=json&no_html=1');
        return 'Reachable';
      },
    })
    .define({
      id: 'google-news',
      name: 'News feeds (RSS)',
      category: 'News',
      description: 'Headlines from Google News RSS, or your own comma-separated list of RSS feeds.',
      fields: [{ key: 'feeds', label: 'Custom RSS feed URLs (comma-separated)', env: 'JARVIS_NEWS_FEEDS', placeholder: 'https://example.com/rss.xml' }],
      test: async () => {
        const xml = await fetchText('https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en', { timeoutMs: 10_000 });
        return xml.includes('<item>') ? 'Reachable' : 'Reachable, but the feed was empty';
      },
    })
    .define({
      id: 'homeassistant',
      name: 'Home Assistant',
      category: 'Smart home',
      description: 'Controls every device Home Assistant knows about: lights, switches, climate, locks, covers, alarm panels and media players.',
      docs: 'https://developers.home-assistant.io/docs/api/rest/',
      fields: [
        { key: 'url', label: 'Base URL', env: 'HOMEASSISTANT_URL', required: true, placeholder: 'http://homeassistant.local:8123' },
        { key: 'token', label: 'Long-lived access token', env: 'HOMEASSISTANT_TOKEN', secret: true, required: true },
      ],
      test: async (config) => {
        const data = await fetchJson(`${config.url.replace(/\/$/, '')}/api/`, { headers: { authorization: `Bearer ${config.token}` } });
        return data?.message ?? 'Connected';
      },
    })
    .define({
      id: 'hue',
      name: 'Philips Hue',
      category: 'Smart home',
      description: 'Controls lights through a Hue bridge on your local network.',
      docs: 'https://developers.meethue.com/',
      fields: [
        { key: 'bridgeUrl', label: 'Bridge URL', env: 'HUE_BRIDGE_URL', required: true, placeholder: 'http://192.168.1.2' },
        { key: 'username', label: 'Bridge username (app key)', env: 'HUE_USERNAME', secret: true, required: true },
      ],
      test: async (config) => {
        const lights = await fetchJson(`${config.bridgeUrl.replace(/\/$/, '')}/api/${config.username}/lights`);
        return `Connected. ${Object.keys(lights ?? {}).length} lights found`;
      },
    })
    .define({
      id: 'google-calendar',
      name: 'Google Calendar',
      category: 'Calendar',
      description: 'Reads and creates events on a Google calendar. The local calendar and its iCalendar feed work without it.',
      docs: 'https://developers.google.com/calendar/api',
      fields: [
        { key: 'accessToken', label: 'OAuth access token', env: 'GOOGLE_CALENDAR_ACCESS_TOKEN', secret: true, required: true },
        { key: 'calendarId', label: 'Calendar ID', env: 'GOOGLE_CALENDAR_ID', default: 'primary' },
      ],
      test: async (config) => {
        const data = await fetchJson(`https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(config.calendarId ?? 'primary')}/events?maxResults=1`, { headers: { authorization: `Bearer ${config.accessToken}` } });
        return `Connected to "${data?.summary ?? 'calendar'}"`;
      },
    })
    .define({
      id: 'mastodon',
      name: 'Mastodon',
      category: 'Social',
      description: 'Posts statuses (after you confirm) and reads your home timeline.',
      docs: 'https://docs.joinmastodon.org/client/intro/',
      fields: [
        { key: 'url', label: 'Server URL', env: 'MASTODON_URL', required: true, placeholder: 'https://mastodon.social' },
        { key: 'token', label: 'Access token', env: 'MASTODON_TOKEN', secret: true, required: true },
      ],
      test: async (config) => {
        const me = await fetchJson(`${config.url.replace(/\/$/, '')}/api/v1/accounts/verify_credentials`, { headers: { authorization: `Bearer ${config.token}` } });
        return `Connected as @${me?.acct ?? 'unknown'}`;
      },
    })
    .define({
      id: 'webhook',
      name: 'Slack / Discord webhook',
      category: 'Social',
      description: 'Sends messages to a channel through an incoming webhook (after you confirm).',
      fields: [{ key: 'url', label: 'Webhook URL', env: 'WEBHOOK_URL', secret: true, required: true }],
    });
  return registry;
}
