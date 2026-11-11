import { fetchJson } from '../../core/http.js';
import { nextWeekday } from '../../core/nlu/entities.js';

const WMO = {
  0: 'clear skies', 1: 'mostly clear', 2: 'partly cloudy', 3: 'overcast', 45: 'fog', 48: 'freezing fog',
  51: 'light drizzle', 53: 'drizzle', 55: 'heavy drizzle', 56: 'freezing drizzle', 57: 'heavy freezing drizzle',
  61: 'light rain', 63: 'rain', 65: 'heavy rain', 66: 'freezing rain', 67: 'heavy freezing rain',
  71: 'light snow', 73: 'snow', 75: 'heavy snow', 77: 'snow grains', 80: 'light showers', 81: 'showers',
  82: 'heavy showers', 85: 'snow showers', 86: 'heavy snow showers', 95: 'thunderstorms',
  96: 'thunderstorms with hail', 99: 'severe thunderstorms with hail',
};
const ICON = (code) => {
  if (code === 0 || code === 1) return 'sun';
  if (code === 2) return 'partly';
  if (code === 3) return 'cloud';
  if (code === 45 || code === 48) return 'fog';
  if ((code >= 51 && code <= 67) || (code >= 80 && code <= 82)) return 'rain';
  if ((code >= 71 && code <= 77) || code === 85 || code === 86) return 'snow';
  if (code >= 95) return 'storm';
  return 'cloud';
};
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const WHEN_RE = /\b(today|tomorrow|tonight|this week|next week|this weekend|the weekend|for the week|(?:the\s+)?next few days|(?:on\s+)?(?:sunday|monday|tuesday|wednesday|thursday|friday|saturday)|right now|now|currently)\b/g;
const FILLER_RE = /\b(going to be|gonna be|supposed to be|be like|be|like|looking|look|outside|out|here|there|please)\b/g;

/** Split the tail of a weather question into { location, when }. */
export function parseWeatherTail(tail) {
  let rest = ` ${String(tail ?? '').toLowerCase()} `;
  let when = 'today';
  const found = rest.match(WHEN_RE);
  if (found) {
    const w = found[0].replace(/^on\s+/, '').replace(/^the\s+/, '');
    if (w === 'tomorrow') when = 'tomorrow';
    else if (w === 'tonight') when = 'tonight';
    else if (['this week', 'next week', 'for the week', 'next few days'].includes(w)) when = 'week';
    else if (w === 'this weekend' || w === 'weekend') when = 'weekend';
    else if (WEEKDAYS.includes(w)) when = w;
  }
  rest = rest.replace(WHEN_RE, ' ').replace(FILLER_RE, ' ').replace(/[?,]/g, ' ').replace(/\s+/g, ' ').trim();
  let location = null;
  const m = /^(?:in|at|for|near|around)\s+(.+)$/.exec(rest) ?? /\b(?:in|at|for|near|around)\s+(.+)$/.exec(rest);
  if (m) location = m[1].replace(/\b(?:in|at|for|on)$/, '').trim();
  else if (rest && !/^(?:in|at|for|on|the)$/.test(rest)) location = rest;
  if (location) location = location.replace(/^(?:the\s+)?(?:city of\s+)?/, '').trim();
  return { location: location || null, when };
}

export function createWeatherSkill() {
  const geoCache = new Map();
  const forecastCache = new Map();

  async function geocode(name) {
    const key = name.toLowerCase();
    if (geoCache.has(key)) return geoCache.get(key);
    const data = await fetchJson(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`);
    const hit = data?.results?.[0];
    if (!hit) return null;
    const place = { name: hit.name, region: hit.admin1 ?? null, country: hit.country ?? null, latitude: hit.latitude, longitude: hit.longitude, timezone: hit.timezone };
    geoCache.set(key, place);
    return place;
  }

  async function forecast(place, units) {
    const imperial = units === 'imperial';
    const key = `${place.latitude},${place.longitude},${imperial}`;
    const hit = forecastCache.get(key);
    if (hit && Date.now() - hit.at < 10 * 60_000) return hit.data;
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}`
      + '&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m'
      + '&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum'
      + `&timezone=auto&forecast_days=7&temperature_unit=${imperial ? 'fahrenheit' : 'celsius'}&wind_speed_unit=${imperial ? 'mph' : 'kmh'}`;
    const data = await fetchJson(url);
    forecastCache.set(key, { at: Date.now(), data });
    return data;
  }

  function shape(place, data, units) {
    const deg = units === 'imperial' ? '°F' : '°C';
    const c = data.current ?? {};
    const d = data.daily ?? {};
    const daily = (d.time ?? []).map((date, i) => ({
      date,
      label: i === 0 ? 'Today' : i === 1 ? 'Tomorrow' : new Date(`${date}T12:00:00`).toLocaleDateString('en-US', { weekday: 'short' }),
      weekday: new Date(`${date}T12:00:00`).getDay(),
      code: d.weather_code?.[i],
      text: WMO[d.weather_code?.[i]] ?? 'mixed conditions',
      icon: ICON(d.weather_code?.[i]),
      max: Math.round(d.temperature_2m_max?.[i]),
      min: Math.round(d.temperature_2m_min?.[i]),
      precipChance: d.precipitation_probability_max?.[i] ?? null,
      precip: d.precipitation_sum?.[i] ?? null,
    }));
    return {
      type: 'weather',
      location: [place.name, place.region && place.region !== place.name ? place.region : null, place.country].filter(Boolean).join(', '),
      place: place.name,
      units: { temperature: deg, wind: units === 'imperial' ? 'mph' : 'km/h' },
      current: { temperature: Math.round(c.temperature_2m), feelsLike: Math.round(c.apparent_temperature), humidity: c.relative_humidity_2m, wind: Math.round(c.wind_speed_10m), code: c.weather_code, text: WMO[c.weather_code] ?? 'mixed conditions', icon: ICON(c.weather_code) },
      daily,
      updatedAt: new Date().toISOString(),
    };
  }

  async function load(location, units) {
    const place = await geocode(location);
    if (!place) return null;
    return shape(place, await forecast(place, units), units);
  }

  function dayIndex(when, card, now) {
    if (when === 'tomorrow') return 1;
    if (WEEKDAYS.includes(when)) {
      const target = nextWeekday(now, WEEKDAYS.indexOf(when));
      const idx = card.daily.findIndex((d) => d.date === `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`);
      return idx >= 0 ? idx : card.daily.findIndex((d) => d.weekday === WEEKDAYS.indexOf(when));
    }
    return 0;
  }

  function compose(card, slots, now) {
    const deg = card.units.temperature;
    const when = slots.when ?? 'today';
    const q = slots.question;
    if (when === 'week' || when === 'weekend') {
      const days = when === 'weekend' ? card.daily.filter((d) => d.weekday === 6 || d.weekday === 0).slice(0, 2) : card.daily.slice(0, 5);
      const parts = days.map((d) => `${d.label} ${d.text}, ${d.max}${deg}/${d.min}${deg}`);
      return `${when === 'weekend' ? 'This weekend' : 'The next few days'} in ${card.place}: ${parts.join('; ')}.`;
    }
    const i = dayIndex(when, card, now);
    const day = card.daily[i];
    if (!day) return `I only have a 7-day forecast for ${card.place}, and that day is beyond it.`;
    const label = i === 0 ? (when === 'tonight' ? 'tonight' : 'today') : i === 1 ? 'tomorrow' : `on ${WEEKDAYS[day.weekday][0].toUpperCase()}${WEEKDAYS[day.weekday].slice(1)}`;
    const chance = day.precipChance;
    const wet = ['rain', 'snow', 'storm'].includes(day.icon) || (chance ?? 0) >= 50;
    const chanceText = chance != null ? ` (${chance}% chance of precipitation)` : '';
    if (q === 'rain' || q === 'umbrella' || q === 'raincoat') {
      const lead = wet ? (q === 'rain' ? `Yes, ${day.text} is likely` : `Yes, take ${q === 'umbrella' ? 'an umbrella' : 'a raincoat'}: ${day.text} is likely`) : (q === 'rain' ? 'No, rain is unlikely' : `No need for ${q === 'umbrella' ? 'an umbrella' : 'a raincoat'}: it should stay dry`);
      return `${lead} ${label} in ${card.place}${chanceText}.`;
    }
    if (q === 'snow') return `${day.icon === 'snow' ? `Yes, ${day.text} is expected` : 'No snow is expected'} ${label} in ${card.place}. The high will be ${day.max}${deg} and the low ${day.min}${deg}.`;
    const coldLimit = deg === '°F' ? 54 : 12;
    const hotLimit = deg === '°F' ? 79 : 26;
    if (['jacket', 'coat', 'sweater', 'cold'].includes(q)) {
      const cold = day.max < coldLimit;
      return `${cold ? `Yes, it will be chilly ${label}` : `It will be fairly mild ${label}`} in ${card.place}: a high of ${day.max}${deg} and a low of ${day.min}${deg}${wet ? `, with ${day.text}` : ''}.${q !== 'cold' ? (cold ? ` A ${q} is a good idea.` : ` You can probably skip the ${q}.`) : ''}`;
    }
    if (['hot', 'warm', 'sunscreen', 'sunglasses', 'sunny', 'nice'].includes(q)) {
      const sunny = ['sun', 'partly'].includes(day.icon);
      const lead = q === 'sunscreen' || q === 'sunglasses' ? (sunny ? `Yes, bring ${q}` : `Probably not needed`) : day.max >= hotLimit ? 'Yes, it will be warm' : sunny ? 'It will be pleasant' : 'Not especially';
      return `${lead} ${label} in ${card.place}: ${day.text}, with a high of ${day.max}${deg}.`;
    }
    if (q === 'windy') return `Winds in ${card.place} are currently ${card.current.wind} ${card.units.wind}, with ${card.current.text}.`;
    if (i === 0) {
      return `In ${card.place} it's ${card.current.temperature}${deg} with ${card.current.text}, feeling like ${card.current.feelsLike}${deg}. Today's high is ${day.max}${deg} and the low ${day.min}${deg}${chance != null ? `, with a ${chance}% chance of precipitation` : ''}.`;
    }
    return `${label[0].toUpperCase()}${label.slice(1)} in ${card.place}: ${day.text}, with a high of ${day.max}${deg} and a low of ${day.min}${deg}${chance != null ? ` and a ${chance}% chance of precipitation` : ''}.`;
  }

  async function handler(slots, ctx) {
    const location = slots.location ?? ctx.profile.get('location');
    if (!location) {
      return { text: 'Which city should I check the weather for? You can also tell me where you live, for example "I live in Lisbon".', pending: { intent: 'weather.forecast', slots, slot: 'location' } };
    }
    const units = ctx.profile.get('units');
    let card;
    try {
      card = await load(location, units);
    } catch (error) {
      return { text: `I couldn't reach the weather service just now (${error.message}). Please try again shortly.` };
    }
    if (!card) return { text: `I couldn't find a place called "${location}". Could you give me the city name?`, pending: { intent: 'weather.forecast', slots: { ...slots, location: undefined }, slot: 'location' } };
    return { text: compose(card, slots, ctx.now()), cards: [card], track: { lastLocation: card.place }, slots: { ...slots, location: card.place } };
  }

  const fromTail = (tail, extra = {}) => ({ ...parseWeatherTail(tail), ...extra });
  const clean = (slots) => {
    const out = { when: slots.when };
    if (slots.location) out.location = slots.location;
    if (slots.question) out.question = slots.question;
    return out;
  };

  return {
    id: 'weather',
    name: 'Weather',
    description: 'Current conditions and a 7-day forecast for any city, using the free Open-Meteo service. Answers practical questions such as whether to take an umbrella.',

    intents: [
      {
        name: 'weather.forecast',
        priority: 5,
        examples: ["what's the weather like", "what's the weather in paris tomorrow", 'will it rain today', 'do i need an umbrella', 'weather forecast for this week', 'how cold is it outside', 'is it going to snow on friday in denver'],
        patterns: [
          /^(?:what is|what will|how is|how will|what about|check|show|get|tell me|give me)\s+(?:me\s+)?(?:the\s+)?(?:current\s+)?(?:weather|forecast|temperature outside|weather forecast)\b(.*)$/,
          /^(?:weather|forecast|weather forecast|weather report|weather update)\b(.*)$/,
          /^(?:will it|is it going to|is it gonna|is it|does it look like(?: it will)?)\s+(rain|snow|be (?:cold|hot|sunny|windy|warm|nice)|raining|snowing|cold|hot|sunny|windy|warm|nice)\b(.*)$/,
          /^(?:do i need|should i (?:bring|take|wear|pack)|will i need)\s+(?:an?\s+|my\s+)?(umbrella|jacket|coat|sunscreen|raincoat|sweater|sunglasses)\b(.*)$/,
          /^how (hot|cold|warm) (?:is it|will it be|will it get|is it going to be)\b(.*)$/,
          /^(?:what is|how is) it like (outside)\b(.*)$/,
        ],
        slots: (m, { stripped }) => {
          if (/(inside|in here|thermostat|indoor)/.test(stripped)) return null;
          if (m.length === 2) return clean(fromTail(m[1]));
          let question = m[1].replace(/^be\s+/, '').replace(/ing$/, '');
          if (question === 'outside') question = undefined;
          return clean(fromTail(m[2], { question }));
        },
        handler,
      },
    ],

    tools: [
      {
        name: 'get_weather',
        description: 'Get current conditions and the 7-day forecast for a city. Call this for any question about weather, temperature outside, rain, snow, or what to wear.',
        input_schema: {
          type: 'object',
          properties: { location: { type: ['string', 'null'], description: 'City name, e.g. "Lisbon". Null to use the user\'s home location.' } },
          required: ['location'],
          additionalProperties: false,
        },
        run: async ({ location }, ctx) => {
          const where = location ?? ctx.profile.get('location');
          if (!where) return { error: 'no location given and the user has not set a home location; ask which city' };
          try {
            const card = await load(where, ctx.profile.get('units'));
            if (!card) return { error: `no place found called "${where}"` };
            return { location: card.location, units: card.units, current: card.current, daily: card.daily.map((d) => ({ day: d.label, date: d.date, conditions: d.text, high: d.max, low: d.min, precipitation_chance: d.precipChance })) };
          } catch (error) {
            return { error: `weather service unavailable: ${error.message}` };
          }
        },
      },
    ],

    snapshot: async (ctx) => {
      const location = ctx.profile.get('location');
      if (!location) return { configured: false };
      try {
        const card = await load(location, ctx.profile.get('units'));
        return card ? { configured: true, ...card } : { configured: true, error: `Unknown location "${location}"` };
      } catch (error) {
        return { configured: true, error: error.message };
      }
    },

    suggestions: async (ctx) => {
      const location = ctx.profile.get('location');
      if (!location) return [];
      try {
        const card = await load(location, ctx.profile.get('units'));
        const today = card?.daily?.[0];
        if (today && (today.precipChance ?? 0) >= 60) return [{ id: `rain:${today.date}`, text: `${today.precipChance}% chance of ${today.icon === 'snow' ? 'snow' : 'rain'} in ${card.place} today. Take an umbrella.`, utterance: 'do i need an umbrella', score: 0.7 }];
      } catch { /* weather is optional context */ }
      return [];
    },
  };
}
