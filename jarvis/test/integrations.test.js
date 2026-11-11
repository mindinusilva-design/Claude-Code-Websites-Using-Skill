// Offline tests for the code that talks to public services. The network is
// replaced by recorded-shape payloads so parsing and wording are exercised
// without depending on live hosts. Live behavior still needs a real run.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { makeJarvis, say } from './helpers.js';

const realFetch = globalThis.fetch;
let routes = [];
const json = (body) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const text = (body, type = 'text/html') => new Response(body, { status: 200, headers: { 'content-type': type } });

beforeEach(() => {
  routes = [];
  globalThis.fetch = async (url) => {
    const hit = routes.find(([pattern]) => String(url).includes(pattern));
    if (!hit) throw new TypeError(`fetch failed (no stub for ${url})`);
    return hit[1](String(url));
  };
});
afterEach(() => { globalThis.fetch = realFetch; });

test('weather: geocodes, forecasts and answers practical questions', async () => {
  routes.push(['geocoding-api.open-meteo.com', () => json({ results: [{ name: 'Lisbon', admin1: 'Lisbon', country: 'Portugal', latitude: 38.7, longitude: -9.1 }] })]);
  routes.push(['api.open-meteo.com', () => json({
    current: { temperature_2m: 18.4, apparent_temperature: 17.9, relative_humidity_2m: 70, weather_code: 2, wind_speed_10m: 12 },
    daily: { time: ['2026-11-11', '2026-11-12', '2026-11-13'], weather_code: [2, 63, 0], temperature_2m_max: [19, 16, 20], temperature_2m_min: [12, 11, 13], precipitation_probability_max: [10, 85, 0], precipitation_sum: [0, 6, 0] },
  })]);
  const j = await makeJarvis();
  let r = await say(j, "what's the weather in Lisbon");
  assert.match(r.reply.text, /Lisbon it's 18°C with partly cloudy/);
  r = await say(j, 'do I need an umbrella tomorrow in Lisbon');
  assert.match(r.reply.text, /^Yes, take an umbrella: rain is likely tomorrow in Lisbon \(85% chance/);
  r = await say(j, 'will it rain tomorrow');
  assert.match(r.reply.text, /Lisbon/, 'the location carries over from context');
});

test('weather: imperial units flow through', async () => {
  let requested = '';
  routes.push(['geocoding-api.open-meteo.com', () => json({ results: [{ name: 'Denver', country: 'United States', latitude: 39.7, longitude: -104.9 }] })]);
  routes.push(['api.open-meteo.com', (url) => { requested = url; return json({ current: { temperature_2m: 41, apparent_temperature: 37, weather_code: 71, wind_speed_10m: 9 }, daily: { time: ['2026-11-11'], weather_code: [71], temperature_2m_max: [44], temperature_2m_min: [29], precipitation_probability_max: [60] } }); }]);
  const j = await makeJarvis();
  await say(j, 'use fahrenheit');
  const r = await say(j, 'weather in Denver');
  assert.match(requested, /temperature_unit=fahrenheit/);
  assert.match(r.reply.text, /41°F/);
});

test('news: parses RSS and reads the top headlines', async () => {
  routes.push(['news.google.com', () => text(`<rss><channel>
    <item><title>Battery breakthrough doubles EV range - Tech Daily</title><link>https://example.com/1</link><pubDate>Wed, 11 Nov 2026 08:00:00 GMT</pubDate><source url="https://td.example">Tech Daily</source></item>
    <item><title><![CDATA[Charging networks expand across Europe - Wire]]></title><link>https://example.com/2</link></item>
  </channel></rss>`, 'application/rss+xml')]);
  const j = await makeJarvis();
  const r = await say(j, 'news about electric cars');
  assert.match(r.reply.text, /latest on electric cars: 1\. Battery breakthrough doubles EV range \(Tech Daily\)/);
  assert.equal(r.reply.cards[0].items[1].source, 'Wire');
});

test('search: combines Wikipedia and DuckDuckGo', async () => {
  routes.push(['api.duckduckgo.com', () => json({})]);
  routes.push(['w/api.php', () => json({ query: { search: [{ title: 'Ada Lovelace' }] } })]);
  routes.push(['page/summary/', () => json({ type: 'standard', title: 'Ada Lovelace', description: 'English mathematician', extract: 'Augusta Ada King, Countess of Lovelace was an English mathematician and writer. She is chiefly known for her work on the Analytical Engine. She was the first to recognise that the machine had applications beyond pure calculation.', content_urls: { desktop: { page: 'https://en.wikipedia.org/wiki/Ada_Lovelace' } } })]);
  const j = await makeJarvis();
  const r = await say(j, 'who is Ada Lovelace');
  assert.match(r.reply.text, /^Augusta Ada King, Countess of Lovelace was an English mathematician/);
  assert.equal(r.reply.cards[0].items[0].source, 'Wikipedia');
});

test('summarize: extracts readable text from a page without a language model', async () => {
  const paragraphs = Array.from({ length: 12 }, (_, i) => `<p>Paragraph ${i + 1} explains how the arc reactor powers the suit and why the design keeps improving with every new version that is built.</p>`).join('');
  routes.push(['example.org', () => text(`<html><head><title>Arc reactors explained</title><script>evil()</script></head><body><nav>menu</nav>${paragraphs}</body></html>`)]);
  const j = await makeJarvis();
  const r = await say(j, 'summarize https://example.org/arc-reactors');
  assert.match(r.reply.text, /^"Arc reactors explained": /);
  assert.ok(!r.reply.text.includes('evil'));
  assert.equal(r.reply.cards[0].method, 'extractive');
});

test('summarize refuses private-network addresses', async () => {
  const j = await makeJarvis();
  const r = await say(j, 'summarize http://192.168.1.1/admin');
  assert.match(r.reply.text, /only summarize public web pages/);
});

test('services that are down produce a clear message, not a crash', async () => {
  const j = await makeJarvis();
  const r = await say(j, 'weather in Paris');
  assert.match(r.reply.text, /couldn't reach the weather service/);
});
